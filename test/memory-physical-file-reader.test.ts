import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { createMemoryPhysicalFileReader, memoryFileRevision, readMemoryFileAtCommit } from '../src/memory/node/memory-file-store.ts'

const workspace = 'a'.repeat(64)
function fixture(t: test.TestContext) {
  const { dir } = scratch(t, 'viva-physical-memory-read-')
  const root = join(dir, 'files')
  function put(path: string, text: string) {
    const file = join(root, workspace, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return file
  }
  return { root, put }
}

test('exact-path verification checks the current hash, missing files, unsafe paths and symlinks', async t => {
  const { root, put } = fixture(t)
  const path = 'digest/wiki/safe.md'
  const read = createMemoryPhysicalFileReader(() => root)
  t.after(read.close)
  put(path, 'first revision')
  assert.deepEqual(await read(workspace, path), { path, markdown: 'first revision', revision: memoryFileRevision('first revision') })
  put(path, 'second revision')
  assert.equal((await read(workspace, path))?.revision, memoryFileRevision('second revision'))
  assert.equal(readMemoryFileAtCommit(root, workspace, path)?.revision, memoryFileRevision('second revision'))
  assert.equal(await read(workspace, 'digest/wiki/missing.md'), null)
  const external = join(root, 'outside.md')
  writeFileSync(external, 'outside the workspace')
  symlinkSync(external, join(root, workspace, 'digest/wiki/link.md'))
  await assert.rejects(read(workspace, 'digest/wiki/link.md'), /memory-file-not-file/)
  await assert.rejects(read(workspace, '../outside.md'), /memory-file-path/)
  await assert.rejects(read('../outside', path), /memory-file-path/)
  assert.throws(() => readMemoryFileAtCommit(root, workspace, 'digest/wiki/link.md'), /memory-file-path/)
})

test('cancelling a coalesced file lookup leaves the other caller able to verify it', async t => {
  const { root, put } = fixture(t)
  const path = 'digest/wiki/shared.md'
  put(path, 'shared memory')
  const read = createMemoryPhysicalFileReader(() => root)
  const cancelled = new AbortController()
  const first = read(workspace, path, cancelled.signal)
  const second = read(workspace, path)
  const stopped = assert.rejects(first, /lookup cancelled/)
  cancelled.abort(new Error('lookup cancelled'))
  await stopped
  assert.equal((await second)?.markdown, 'shared memory')
  const inFlight = read(workspace, path)
  read.close()
  await assert.rejects(inFlight, /reader closed/)
  await assert.rejects(read(workspace, path), /reader closed/)
})

test('concurrent verification shares one physical read of a path and leaves room for other files', async t => {
  const { root, put } = fixture(t)
  const slow = 'digest/wiki/first.md', other = 'digest/wiki/other.md'
  put(slow, 'first')
  put(other, 'other')
  let opened = 0
  const verify = createMemoryPhysicalFileReader(() => { opened++; return root })
  const samePath = Array.from({ length: 8 }, () => verify(workspace, slow))
  const independent = verify(workspace, other)
  assert.equal(opened, 2)
  assert.deepEqual((await Promise.all(samePath)).map(result => result?.markdown), Array(8).fill('first'))
  assert.equal((await independent)?.markdown, 'other')
})

test('queued healthy files share a recovery worker; a cancelled or stalled recovery cannot occupy its lane', async t => {
  const { root, put } = fixture(t)
  const blocked = ['one', 'two', 'three'].map(name => `digest/wiki/${name}.md`)
  const paths = new Set(blocked.map(path => put(path, 'unreadable')))
  const healthy = 'digest/wiki/healthy.md', slow = 'digest/wiki/slow.md'
  put(healthy, 'available')
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  const original = promises.lstat
  const mocked = t.mock.method(promises, 'lstat', async (...args: Parameters<typeof original>) => {
    if (paths.has(String(args[0]))) await gate
    return Reflect.apply(original, promises, args)
  })
  syncBuiltinESMExports()
  let forks = 0
  let sent!: () => void
  const waiting = new Promise<void>(done => { sent = done })
  const read = createMemoryPhysicalFileReader(() => root, (entry, args, options) => {
    const child = fork(entry, args, options), send = child.send
    forks++
    t.mock.method(child, 'send', function (this: typeof child, ...parts: Parameters<typeof send>) {
      const request = parts[0] as { path?: string }
      if (request.path === slow) { sent(); return true }
      if (request.path === 'digest/wiki/fourth.md') {
        setImmediate(() => child.emit('message', { timedOut: true }))
        return true
      }
      return Reflect.apply(send, this, parts) as boolean
    })
    return child
  })
  try {
    const stalled = blocked.map(path => assert.rejects(read(workspace, path), /timed out/u))
    // Enqueued before the three native deadlines fire.
    const available = read(workspace, healthy)
    await Promise.all(stalled)
    assert.equal((await available)?.markdown, 'available')
    assert.equal((await read(workspace, healthy))?.markdown, 'available')
    assert.equal(forks, 1, 'rescue reads reuse their independent process')
    const controller = new AbortController()
    const pending = assert.rejects(read(workspace, slow, controller.signal), /cancelled/)
    await waiting
    controller.abort(new Error('cancelled'))
    await pending
    assert.equal((await read(workspace, healthy))?.markdown, 'available')
    assert.equal(forks, 2)
    await assert.rejects(read(workspace, 'digest/wiki/fourth.md'), /timed out/)
    await assert.rejects(read(workspace, 'digest/wiki/fourth.md'), /timed out/)
    assert.equal(forks, 2, 'a previously wedged rescue path cannot repeatedly spawn a process')
    assert.equal((await read(workspace, healthy))?.markdown, 'available')
  } finally {
    release()
    read.close()
    mocked.mock.restore()
    syncBuiltinESMExports()
  }
})
