import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, renameSync, symlinkSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { openMemoryFileCatalog } from '../src/memory/node/memory-file-catalog.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import type { MemoryFileIdentity } from '../src/memory/core/ports/file-index.ts'
const workspace='a'.repeat(64)
function fixture(t:test.TestContext) {
  const {dir}=scratch(t,'viva-file-catalog-'), root=join(dir,'files')
  const put=(path:string,text:string)=>{const full=join(root,workspace,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,text);return full}
  return {root,put,catalog:openMemoryFileCatalog({root})}
}
const identity=(path:string,text:string,id='a'):MemoryFileIdentity=>({workspace,id,path,revision:memoryFileRevision(text),usageVersion:1,policyToken:'policy',kind:'digest',updatedAt:1,sources:[]})
test('catalog observes modifications and unique exact rename without assigning trust to new content',t=>{
  const {root,put,catalog}=fixture(t), old=identity('digest/wiki/old.md','original')
  put(old.path,'original');assert.equal(catalog.scan(workspace,[old])[0]?.kind,'unchanged')
  renameSync(join(root,workspace,old.path),join(root,workspace,'digest/wiki/new.md'))
  const changes=catalog.scan(workspace,[old]);assert.equal(changes.length,1);assert.equal(changes[0]?.kind,'rename')
  if(changes[0]?.kind==='rename'){assert.equal(changes[0].identity.id,old.id);assert.equal(changes[0].file.markdown,'original')}
  put('digest/wiki/new.md','modified')
  assert.deepEqual(catalog.scan(workspace,[old]).map(c=>c.kind).sort(),['added','missing'])
})
test('copies, duplicate missing identities and ambiguous moves never infer ownership',t=>{
  const {root,put,catalog}=fixture(t), old=identity('digest/wiki/old.md','same')
  put(old.path,'same');put('digest/wiki/copy.md','same')
  assert.ok(catalog.scan(workspace,[old]).some(c=>c.kind==='quarantined'&&c.reason==='duplicate-content'))
  rmSync(join(root,workspace,old.path));put('digest/wiki/copy2.md','same')
  assert.equal(catalog.scan(workspace,[old]).filter(c=>c.kind==='rename').length,0)
  assert.equal(catalog.scan(workspace,[old]).filter(c=>c.kind==='quarantined').length,2)
  rmSync(join(root,workspace,'digest/wiki/copy2.md'))
  assert.equal(catalog.scan(workspace,[old,identity('digest/wiki/old2.md','same','b')]).filter(c=>c.kind==='rename').length,0)
})
test('catalog refuses symlinks, ignores temporary files, and never reads outside the workspace',t=>{
  const {root,put,catalog}=fixture(t)
  put('digest/wiki/ok.md','safe');put('digest/wiki/.viva-memory-temp.md','hidden');put('digest/wiki/work.md.tmp','temp')
  const external=join(root,'outside.md');writeFileSync(external,'must not leak')
  symlinkSync(external,join(root,workspace,'digest/wiki/link.md'))
  const changes=catalog.scan(workspace,[])
  assert.equal(changes.filter(c=>c.kind==='added').length,1)
  assert.ok(changes.some(c=>c.kind==='quarantined'&&c.reason==='symlink'))
  assert.equal(JSON.stringify(changes).includes('must not leak'),false)
  assert.throws(()=>catalog.scan('../escape',[]),/invalid-memory-workspace/)
})
