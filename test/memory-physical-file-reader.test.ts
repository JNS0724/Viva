import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestTimeout } from '../src/shared/request-budget.ts'
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
  put('digest/wiki/oversize.md', 'x'.repeat(4 * 1024 * 1024 + 1))
  await assert.rejects(read(workspace, 'digest/wiki/oversize.md'), /memory-file-not-file/)
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

test('a caller joining an in-flight read observes its original native deadline', async t => {
  const { root, put } = fixture(t)
  const path = 'digest/wiki/stalled.md'
  put(path, 'stored')
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(done => { release = done })
  const started = new Promise<void>(done => { entered = done })
  const native = new AbortController()
  t.mock.method(AbortSignal, 'timeout', () => native.signal)
  const original = promises.lstat
  const stat = t.mock.method(promises, 'lstat', async (...args: Parameters<typeof original>) => {
    entered()
    await blocked
    return Reflect.apply(original, promises, args)
  })
  syncBuiltinESMExports()
  const read = createMemoryPhysicalFileReader(() => root)
  try {
    const first = assert.rejects(read(workspace, path), RequestTimeout)
    await started
    let rejected = false
    const second = assert.rejects(read(workspace, path), RequestTimeout).then(() => { rejected = true })
    native.abort()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(rejected, 'the shared deadline settles a later caller while its own budget is still open')
    await Promise.all([first, second])
  } finally {
    release()
    read.close()
    stat.mock.restore()
    syncBuiltinESMExports()
  }
})

test('stalled reads keep their slots until native I/O settles and queued reads time out', async t => {
  const { root, put } = fixture(t)
  const blocked = ['one', 'two', 'three'].map(name => `digest/wiki/${name}.md`)
  const paths = new Set(blocked.map(path => put(path, 'blocked')))
  const healthy = 'digest/wiki/healthy.md'
  put(healthy, 'available')
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  const original = promises.lstat
  const mocked = t.mock.method(promises, 'lstat', async (...args: Parameters<typeof original>) => {
    if (paths.has(String(args[0]))) await gate
    return Reflect.apply(original, promises, args)
  })
  syncBuiltinESMExports()
  let started = 0
  const read = createMemoryPhysicalFileReader(() => { started++; return root })
  try {
    const first = assert.rejects(read(workspace, blocked[0]!), RequestTimeout)
    assert.equal((await read(workspace, healthy))?.markdown, 'available')
    const others = blocked.slice(1).map(path => assert.rejects(read(workspace, path), RequestTimeout))
    await Promise.all([first, ...others, assert.rejects(read(workspace, healthy), RequestTimeout)])
    await assert.rejects(read(workspace, blocked[0]!), RequestTimeout)
    await assert.rejects(read(workspace, healthy), RequestTimeout)
    assert.equal(started, 4, 'caller timeouts must not start more native reads')
    const retry = read(workspace, healthy)
    release()
    assert.equal((await retry)?.markdown, 'available')
    assert.equal(started, 5)
  } finally {
    release()
    read.close()
    mocked.mock.restore()
    syncBuiltinESMExports()
  }
})
