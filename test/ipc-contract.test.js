import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { IPC_ARGS, argsProblem, checkedIpc } from '../src/shared/ipc-contract.ts'

const ROOT = path.join(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const channelsIn = (source, pattern) => new Set([...source.matchAll(pattern)].map((match) => match[1]))

/** What the pages send: ipcRenderer.invoke / send in the preload scripts (listeners for main's messages aside). */
const sentByPages = () => channelsIn(
  read('src/preload/preload.cjs') + read('src/preload/desk-preload.cjs'),
  /ipcRenderer\.(?:invoke|send)\('([^']+)'/g,
)

/**
 * What the main process registers, the shell's and the backend's together (src/shell, src/backend): ipcMain.handle /
 * on, and the `handle('…'` shorthand of the register*Ipc modules.
 */
const registeredByMain = () => {
  const sources = ['shell', 'backend'].flatMap((folder) => fs.readdirSync(path.join(ROOT, 'src', folder))
    .filter((name) => /\.[jt]s$/.test(name)).map((name) => read(path.join('src', folder, name)))).join('\n')
  return channelsIn(sources, /(?:ipcMain\.(?:handle|on)|\bhandle)\('([^']+)'/g)
}

const sorted = (set) => [...set].sort()

test('every channel the pages send is in the contract, and the contract holds nothing else', () => {
  assert.deepEqual(sorted(sentByPages()), sorted(Object.keys(IPC_ARGS)))
})

test('every channel the main process registers is in the contract', () => {
  assert.deepEqual(sorted(registeredByMain()), sorted(Object.keys(IPC_ARGS)))
})

test('arguments of the right outline pass, trailing ones left out or undefined included', () => {
  assert.equal(argsProblem('agent:info', []), null)
  assert.equal(argsProblem('agent:prompt', ['你好']), null)
  assert.equal(argsProblem('agent:prompt', ['', [{ id: 'img-1', mimeType: 'image/png' }]]), null)
  assert.equal(argsProblem('history:list', [undefined]), null)
  assert.equal(argsProblem('files:open', ['notes.md', null]), null)
  assert.equal(argsProblem('memory:update', [3, '喜欢喝茶']), null)
  assert.equal(argsProblem('images:keep', [new Uint8Array([1, 2, 3])]), null)
  assert.equal(argsProblem('task:close', ['t1']), null)
})

test('arguments of another outline are refused with the channel and the place named', () => {
  assert.match(argsProblem('agent:prompt', [42]), /^invalid agent:prompt arguments: #0 /)
  assert.match(argsProblem('settings:set-desk-island', ['yes']), /^invalid settings:set-desk-island arguments: #0 /)
  assert.match(argsProblem('agent:info', ['extra']), /^invalid agent:info arguments/)
  assert.match(argsProblem('memory:delete', ['3']), /#0 /)
  assert.match(argsProblem('agent:prompt', ['x'.repeat(200_001)]), /#0 /)
  assert.match(argsProblem('agent:prompt', ['', [{ id: 7 }]]), /#1\.0\.id /)
  assert.equal(argsProblem('no:such', []), 'unknown channel no:such')
})

/** An ipcMain that keeps the listeners, so a test can send as a page would. */
function fakeIpcMain() {
  const listeners = new Map()
  return {
    handle: (channel, listener) => listeners.set(channel, listener),
    on: (channel, listener) => listeners.set(channel, listener),
    send: (channel, ...args) => listeners.get(channel)({ sender: 'page' }, ...args),
  }
}

test('the checked ipcMain runs a handler only for arguments that fit, passing them on as sent', async () => {
  const ipcMain = fakeIpcMain()
  const refused = []
  const ipc = checkedIpc(ipcMain, { onRefused: (channel, problem) => refused.push([channel, problem]) })
  const request = { text: '继续', extra: true }
  ipc.handle('task:start', (event, given) => ({ event, given }))
  const result = ipcMain.send('task:start', request)
  assert.equal(result.given, request, 'the same object, not a copy')
  assert.deepEqual(result.event, { sender: 'page' })
  assert.throws(() => ipcMain.send('task:start', 'not a request'), /invalid task:start arguments/)
  assert.equal(refused.length, 1)
  assert.equal(refused[0][0], 'task:start')
})

test('a one-way message that does not fit is dropped, not thrown', () => {
  const ipcMain = fakeIpcMain()
  const seen = []
  const refused = []
  const ipc = checkedIpc(ipcMain, { onRefused: (channel) => refused.push(channel) })
  ipc.on('island:act', (_event, action) => seen.push(action))
  ipcMain.send('island:act', { kind: 'stop' })
  ipcMain.send('island:act', 'stop')
  assert.deepEqual(seen, [{ kind: 'stop' }])
  assert.deepEqual(refused, ['island:act'])
})

test('a channel missing from the contract cannot be registered', () => {
  const ipc = checkedIpc(fakeIpcMain())
  assert.throws(() => ipc.handle('agent:unchecked', () => {}), /agent:unchecked has no entry in ipc-contract\.ts/)
  assert.throws(() => ipc.on('agent:unchecked', () => {}), /has no entry/)
})
