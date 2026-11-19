import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, renameSync, symlinkSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { openMemoryFileCatalog } from '../src/memory/node/memory-file-catalog.ts'
import { createMemoryPhysicalFileReader, memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import type { MemoryFileIdentity } from '../src/memory/core/ports/file-index.ts'
const workspace='a'.repeat(64)
function fixture(t:test.TestContext) {
  const {dir,defer}=scratch(t,'viva-file-catalog-'), root=join(dir,'files')
  const put=(path:string,text:string)=>{const full=join(root,workspace,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,text);return full}
  const catalog = openMemoryFileCatalog({root})
  defer(() => catalog.close())
  return {root,put,catalog}
}
const identity=(path:string,text:string,id='a'):MemoryFileIdentity=>({workspace,id,path,revision:memoryFileRevision(text),usageVersion:1,policyToken:'policy',kind:'digest',updatedAt:1,sources:[]})

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
})

test('catalog observes modifications and unique exact rename without assigning trust to new content',async t=>{
  const {root,put,catalog}=fixture(t), old=identity('digest/wiki/old.md','original')
  put(old.path,'original');assert.equal((await catalog.scan(workspace,[old]))[0]?.kind,'unchanged')
  renameSync(join(root,workspace,old.path),join(root,workspace,'digest/wiki/new.md'))
  const changes=await catalog.scan(workspace,[old]);assert.equal(changes.length,1);assert.equal(changes[0]?.kind,'rename')
  if(changes[0]?.kind==='rename'){assert.equal(changes[0].identity.id,old.id);assert.equal((await catalog.read(workspace,changes[0].file.path))?.markdown,'original')}
  put('digest/wiki/new.md','modified')
  assert.deepEqual((await catalog.scan(workspace,[old])).map(c=>c.kind).sort(),['added','missing'])
})
test('copies, duplicate missing identities and ambiguous moves never infer ownership',async t=>{
  const {root,put,catalog}=fixture(t), old=identity('digest/wiki/old.md','same')
  put(old.path,'same');put('digest/wiki/copy.md','same')
  assert.ok((await catalog.scan(workspace,[old])).some(c=>c.kind==='quarantined'&&c.reason==='duplicate-content'))
  rmSync(join(root,workspace,old.path));put('digest/wiki/copy2.md','same')
  assert.equal((await catalog.scan(workspace,[old])).filter(c=>c.kind==='rename').length,0)
  assert.equal((await catalog.scan(workspace,[old])).filter(c=>c.kind==='quarantined').length,2)
  rmSync(join(root,workspace,'digest/wiki/copy2.md'))
  assert.equal((await catalog.scan(workspace,[old,identity('digest/wiki/old2.md','same','b')])).filter(c=>c.kind==='rename').length,0)
})
test('catalog refuses symlinks, ignores temporary files, and never reads outside the workspace',async t=>{
  const {root,put,catalog}=fixture(t)
  put('digest/wiki/ok.md','safe');put('digest/wiki/.viva-memory-temp.md','hidden');put('digest/wiki/work.md.tmp','temp')
  const external=join(root,'outside.md');writeFileSync(external,'must not leak')
  symlinkSync(external,join(root,workspace,'digest/wiki/link.md'))
  const changes=await catalog.scan(workspace,[])
  assert.equal(changes.filter(c=>c.kind==='added').length,1)
  assert.ok(changes.some(c=>c.kind==='quarantined'&&c.reason==='symlink'))
  assert.equal(JSON.stringify(changes).includes('must not leak'),false)
  assert.equal(await catalog.read(workspace, 'digest/wiki/missing.md'), null)
  await assert.rejects(catalog.read(workspace, 'digest/wiki/link.md'), /memory-file-not-file/u)
  await assert.rejects(catalog.read(workspace, '../outside.md'), /memory-file-path/u)
  await assert.rejects(catalog.scan('../escape',[]),/invalid-memory-workspace/)
})

test('an incomplete scan preserves unknown bindings without dropping observed edits', async t => {
  const { root, put, catalog } = fixture(t)
  const missing = identity('digest/wiki/missing.md', 'original')
  const modified = identity('digest/wiki/modified.md', 'previous', 'b')
  put('digest/wiki/possible-move.md', 'original')
  put(modified.path, 'edited')
  symlinkSync(join(root, 'unavailable'), join(root, workspace, 'digest/wiki/symlink.md'))

  const changes = await catalog.scan(workspace, [missing, modified])
  assert.ok(changes.some(change => change.kind === 'modified' && change.identity.id === modified.id))
  assert.equal(changes.some(change => change.kind === 'rename' || change.kind === 'missing'), false)
})

test('a scan deadline returns unknown instead of inferring that files have disappeared', async t => {
  const { root, put } = fixture(t)
  const catalog = openMemoryFileCatalog({ root, timeoutMs: 1 })
  t.after(() => catalog.close())
  const old = identity('digest/wiki/old.md', 'original')
  put(old.path, 'original')

  const first = catalog.scan(workspace, [old])
  const overlapping = await catalog.scan(workspace, [old])
  assert.deepEqual(overlapping, [{ kind: 'quarantined', path: '', reason: 'scan-unavailable' }])
  assert.deepEqual(await first, overlapping)
  assert.equal((await catalog.read(workspace, old.path))?.markdown, 'original')
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

test('a stalled scanner returns completed observations without reporting missing files', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { root } = fixture(t)
  const stalledWorker = fileURLToPath(new URL('./fixtures/memory-file-catalog-stall.ts', import.meta.url))
  const catalog = openMemoryFileCatalog({ root, timeoutMs: 10, forkWorker: (_entry, args, options) => {
    const child = fork(stalledWorker, args, options)
    child.once('message', () => setImmediate(() => t.mock.timers.tick(10)))
    return child
  } })
  t.after(() => catalog.close())
  const edited = identity('digest/wiki/edited.md', 'before')
  const unknown = identity('digest/wiki/maybe-present.md', 'original', 'b')

  const changes = await catalog.scan(workspace, [edited, unknown])
  assert.deepEqual(changes.map(change => change.kind), ['quarantined', 'modified'])
  assert.ok(changes.some(change => change.kind === 'modified' && change.identity.id === edited.id))
})
