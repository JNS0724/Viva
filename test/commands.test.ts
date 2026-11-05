import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { commandIpc, isCommand } from '../src/backend/commands.ts'
import { createEventCore, type Routes } from '../src/backend/event-core.ts'
import { IPC_ARGS, QUERY_CHANNELS, type Channel, type IpcRegistry } from '../src/shared/ipc-contract.ts'

type Listener = (event: unknown, ...args: unknown[]) => unknown

/** The backend's channels through commandIpc, on a fake registry, with the event core routing them. */
function backendIn(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-commands-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => {
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const core = createEventCore({ app, publish: () => {}, now: () => 1000 })
  const registered = new Map<string, Listener>()
  const raw = { handle: (channel: string, listener: Listener) => { registered.set(channel, listener) }, on: () => {} } as unknown as IpcRegistry
  const commands = commandIpc(raw, (input) => core.signal(input))
  const idle = () => undefined
  const routes: Routes = {
    'chat.said': idle, 'agent.turn_ended': idle, 'agent.task_ended': idle, 'agent.task_waits': idle, 'agent.followup_proposed': idle,
    'clock.reminder_due': idle, 'clock.prepare_window': idle, 'system.woke': idle, 'system.user_returned': idle,
    'window.foreground': idle, 'user.command': (input) => commands.route(input),
  }
  core.route(routes)
  const call = (channel: Channel, ...args: unknown[]) => registered.get(channel)!({ sender: 'page' }, ...args)
  return { core, ipc: commands.ipc, call }
}

test('what the user does is recorded first, by its shape only, then handled; its answer comes back', async (t) => {
  const { core, ipc, call } = backendIn(t)
  const seen: unknown[] = []
  ipc.handle('settings:save-key', (event, key) => { seen.push([event, key]); return 'saved' })
  ipc.handle('history:rename', async (_event, id, title) => `${id}:${title}`)
  assert.equal(await call('settings:save-key', 'sk-0123456789abcdef'), 'saved')
  assert.equal(await call('history:rename', 'c-1', '季度复盘'), 'c-1:季度复盘')
  assert.deepEqual(seen, [[{ sender: 'page' }, 'sk-0123456789abcdef']], 'the listener gets the event and the arguments as sent')
  assert.deepEqual(core.since(0).map((event) => [event.kind, event.data]), [
    ['signal.user.command', { channel: 'settings:save-key', args: [{ chars: 19 }] }],
    ['signal.user.command', { channel: 'history:rename', args: [{ chars: 3 }, { chars: 4 }] }],
  ])
  assert.ok(!JSON.stringify(core.since(0)).includes('sk-0123'), 'a key is never in the events')
})

test('a query, and a channel that is its own signal, go straight to their listener with no event', async (t) => {
  const { core, ipc, call } = backendIn(t)
  ipc.handle('history:list', () => ['a'])
  ipc.handle('agent:prompt', () => 'asked')
  assert.deepEqual(await call('history:list'), ['a'])
  assert.equal(await call('agent:prompt', '你好'), 'asked')
  assert.deepEqual(core.since(0), [])
})

test('a command that fails still says so, and its signal stays recorded; one channel is registered once', async (t) => {
  const { core, ipc, call } = backendIn(t)
  ipc.handle('history:delete', () => { throw new Error('conversation not found') })
  assert.throws(() => call('history:delete', 'gone-1'), /conversation not found/)
  assert.deepEqual(core.since(0).map((event) => event.data.channel), ['history:delete'], 'the user did it, whatever came of it')
  assert.throws(() => ipc.handle('history:delete', () => {}), /registered twice/)
})

test('a query is marked where its channel is defined; the rest are commands', () => {
  const channels = Object.keys(IPC_ARGS) as Channel[]
  for (const channel of QUERY_CHANNELS) assert.ok(channels.includes(channel), channel)
  assert.ok(QUERY_CHANNELS.has('history:read') && QUERY_CHANNELS.has('memory:get'), 'a schema over several lines is marked too')
  assert.ok(isCommand('followups:accept') && isCommand('memory:delete') && !isCommand('memory:get') && !isCommand('agent:prompt'))
  assert.ok(IPC_ARGS['history:read'].safeParse(['c-1']).success, 'the mark leaves the check as it was')
})
