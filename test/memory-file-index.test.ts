import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { openMemoryFileIndex } from '../src/memory/node/memory-file-index.ts'
import { APP_DB_PRAGMAS } from '../src/memory/node/sqlite.ts'
import type { MemoryFileSnapshot } from '../src/memory/core/ports/file-index.ts'
const workspace='a'.repeat(64)
function file(id: string, text='喜欢茶', patch: Partial<MemoryFileSnapshot>={}): MemoryFileSnapshot {
  return {workspace,id,path:`digest/wiki/${id}.md`,revision:`revision-${id}`,usageVersion:1,policyToken:'policy-1',kind:'digest',updatedAt:1,sources:[{id:`source-${id}`,token:'token'}],name:id,description:'',links:[],chunks:[{text,searchText:text,headingPath:[],startLine:1,endLine:1,startOffset:0,endOffset:text.length}],...patch}
}
function fixture(t: test.TestContext) {
  const temp=scratch(t,'viva-file-index-'), path=join(temp.dir,'index.db'), db=new DatabaseSync(path)
  db.exec(APP_DB_PRAGMAS); temp.defer(()=>db.close())
  return {db,path,index:openMemoryFileIndex({db}),defer:temp.defer}
}
test('accepted snapshot CAS and authorization cover every candidate before applying hit quota',t=>{
  const {index}=fixture(t), authorized=file('authorized','tea tea tea'), hidden=file('hidden','tea')
  index.accept(hidden,null); index.accept(authorized,null)
  assert.equal(index.lexical('tea',[authorized],1).hits[0]?.file.id,'authorized')
  assert.equal(index.lexical('tea',[{...authorized,policyToken:'old'}],10).hits.length,0)
  assert.equal(index.accept({...authorized,policyToken:'policy-2'},null),false)
  assert.equal(index.accept({...authorized,policyToken:'policy-2'},authorized),true)
  assert.equal(index.accept({...authorized,revision:'late'},authorized),false)
  assert.deepEqual(index.chunks([authorized]),[])
  assert.equal(index.snapshot(workspace,'authorized')?.policyToken,'policy-2')
})
test('FTS retains term frequency, falls back after corruption, and rebuilds only accepted projections',t=>{
  const {db,index}=fixture(t), once=file('once','tea other other'), frequent=file('frequent','tea tea tea')
  index.accept(once,null); index.accept(frequent,null)
  const result=index.lexical('tea',[once,frequent],10)
  assert.equal(result.mode,'fts'); assert.equal(result.hits[0]?.file.id,'frequent')
  db.exec('DROP TABLE memory_file_index_fts')
  const fallback=index.lexical('tea',[once,frequent],10)
  assert.equal(fallback.mode,'fallback'); assert.equal(fallback.hits[0]?.file.id,'frequent')
  assert.equal(index.reindex().lexical,true)
  assert.equal(index.lexical('tea',[once,frequent],10).mode,'fts')
  assert.equal(index.snapshot(workspace,'once')?.chunks[0]?.text,'tea other other')
})
test('multiple passage vectors use maximum cosine and space switches disable old vectors until complete',t=>{
  const {index}=fixture(t), a=file('a'), b=file('b'), space={fingerprint:'model-a',dimensions:2}
  index.accept(a,null); index.accept(b,null)
  const generation=index.beginVectors(space), refs=index.missingVectors(generation).map(chunk=>chunk.ref)
  assert.equal(index.stageVectors(generation,[{ref:refs[0]!,vectors:[new Float32Array([1,0]),new Float32Array([0,1])]}]),1)
  assert.equal(index.finishVectors(generation,refs),false)
  assert.equal(index.finishVectors(generation,[refs[0]!]),false)
  assert.equal(index.vector(new Float32Array([0,1]),space,[a,b],5),null)
  index.stageVectors(generation,[{ref:refs[1]!,vectors:[new Float32Array([1,1])]}])
  assert.equal(index.finishVectors(generation,refs),true)
  assert.equal(index.vector(new Float32Array([0,1]),space,[a,b],5)?.[0]?.file.id,'a')
  const next=index.beginVectors({...space,fingerprint:'model-b'})
  assert.equal(index.vector(new Float32Array([0,1]),space,[a,b],5),null)
  assert.equal(index.stageVectors(generation,[{ref:refs[0]!,vectors:[new Float32Array([1,0])]}]),0)
  assert.equal(index.finishVectors(next,refs),false)
})
test('incremental changed policy rejects late vectors while unchanged active chunks remain queryable',t=>{
  const {index}=fixture(t), a=file('a'), b=file('b'), space={fingerprint:'model',dimensions:2}
  index.accept(a,null); index.accept(b,null)
  const gen=index.beginVectors(space), refs=index.missingVectors(gen).map(chunk=>chunk.ref)
  index.stageVectors(gen,refs.map(ref=>({ref,vectors:[new Float32Array([1,0])]}))); assert.equal(index.finishVectors(gen,refs),true)
  const newer={...a,policyToken:'policy-2'}; index.accept(newer,a)
  assert.deepEqual(index.vector(new Float32Array([1,0]),space,[newer,b],10)?.map(hit=>hit.file.id),['b'])
  assert.equal(index.stageVectors(gen,[{ref:refs[0]!,vectors:[new Float32Array([1,0])]}]),0)
  const pending=index.missingVectors(gen); assert.equal(pending.length,1)
  assert.throws(()=>index.stageVectors(gen,[{ref:pending[0]!.ref,vectors:[new Float32Array([NaN,0])]}]),/invalid-passage/)
  assert.throws(()=>index.stageVectors(gen,[{ref:pending[0]!.ref,vectors:[]}]),/invalid-passage/)
  assert.throws(()=>index.stageVectors(gen,[{ref:pending[0]!.ref,vectors:[new Float32Array([1])]}]),/invalid-passage/)
  index.stageVectors(gen,[{ref:pending[0]!.ref,vectors:[new Float32Array([1,0])]}])
  assert.equal(index.vector(new Float32Array([1,0]),space,[newer,b],10)?.length,2)
})
test('restarting retains accepted chunks and completed vectors, reindex invalidates only derivatives',t=>{
  const {db,index}=fixture(t), a=file('a'), space={fingerprint:'model',dimensions:2}
  index.accept(a,null); const gen=index.beginVectors(space), refs=index.missingVectors(gen).map(chunk=>chunk.ref)
  index.stageVectors(gen,refs.map(ref=>({ref,vectors:[new Float32Array([1,0])]}))); index.finishVectors(gen,refs)
  const reopened=openMemoryFileIndex({db})
  assert.deepEqual(reopened.snapshot(workspace,'a'),a)
  assert.equal(reopened.vector(new Float32Array([1,0]),space,[a],10)?.length,1)
  const rebuilt=reopened.reindex()
  assert.equal(reopened.vector(new Float32Array([1,0]),space,[a],10),null)
  assert.equal(reopened.missingVectors(rebuilt.vectorGeneration).length,1)
  assert.equal(reopened.lexical('喜欢茶',[a],10).hits.length,1)
})
test('withdrawal physically erases accepted projections and generations, rejects delayed reaccept, keeps WAL cleanup pending with a reader',t=>{
  const {db,path,index,defer}=fixture(t), marker='Archived sentence about quietly drinking peppermint tea.'
  const a=file('private',marker,{ name: 'private-derived-node-name', links: [{ path: 'digest/wiki/private-derived-link.md', line: 1 }] })
  index.accept(a,null); const gen=index.beginVectors({fingerprint:'model',dimensions:2}), refs=index.missingVectors(gen).map(chunk=>chunk.ref)
  index.stageVectors(gen,refs.map(ref=>({ref,vectors:[new Float32Array([1,0])]})))
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const reader=new DatabaseSync(path); defer(()=>reader.close()); reader.exec('BEGIN'); reader.prepare('SELECT * FROM memory_file_index_nodes').all()
  index.withdraw(a.sources[0]!.id); index.recover()
  assert.equal(index.pendingCleanup(),1)
  assert.equal(index.snapshot(workspace,a.id),null)
  assert.equal(index.accept(a,null),false)
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory_file_index_vectors').get()?.n,0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory_file_index_lookup').get()?.n,0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory_file_index_links').get()?.n,0)
  assert.deepEqual(index.nodeCandidates(a.name, { workspaces: [workspace] }, 10).rows, [])
  reader.exec('COMMIT'); index.recover(); assert.equal(index.pendingCleanup(),0)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const bytes = readFileSync(path)
  for (const fragment of [marker,a.name,a.links[0]!.path]) assert.equal(bytes.includes(Buffer.from(fragment)),false)
})

test('FTS table loss across restart rebuilds from accepted chunks instead of silently returning empty results',t=>{
  const {db,index}=fixture(t),a=file('a','tea tea')
  index.accept(a,null);assert.equal(index.lexical('tea',[a],10).hits.length,1)
  db.exec('DROP TABLE memory_file_index_fts')
  const reopened=openMemoryFileIndex({db})
  assert.equal(reopened.accept(a,a),true)
  assert.equal(reopened.lexical('tea',[a],10).hits.length,1)
})

test('published pages filter workspaces and dates before applying a bounded probe', t => {
  const { db, index } = fixture(t)
  const daily = file('daily-source', 'tea tea tea', {
    path: 'daily/2026-11-05/note.md', kind: 'daily', day: '2026-11-05', updatedAt: 12,
  })
  const outsider = file('other-scope', 'tea tea tea', { workspace: 'b'.repeat(64) })
  const first = file('first', 'tea tea tea')
  const second = file('second', 'tea')
  for (const entry of [daily, outsider, first, second]) assert.equal(index.accept(entry, null), true)
  const scope = { workspaces: [workspace], from: '2026-11-06', asOf: 2 }
  const lexical = index.lexicalCandidates('tea', scope, 1)
  assert.equal(lexical.mode, 'fts')
  assert.deepEqual(lexical.rows.map(hit => hit.file.id), ['first'])
  assert.equal(lexical.incomplete, true)
  assert.deepEqual(index.nodeCandidates('first', scope, 1).rows.map(entry => entry.id), ['first'])
  db.exec('DROP TABLE memory_file_index_fts')
  const fallback = index.lexicalCandidates('tea', scope, 1)
  assert.equal(fallback.mode, 'fallback')
  assert.deepEqual(fallback.rows.map(hit => hit.file.id), ['first'])
  assert.equal(fallback.incomplete, true)
})

test('legacy snapshots seed lookup rows and indexed edges without rereading source files', t => {
  const { db, index } = fixture(t)
  const target = file('target')
  const root = file('root', 'tea', {
    links: [
      { path: target.path, line: 1 },
      { path: target.path, line: 2 },
    ],
  })
  index.accept(target, null)
  index.accept(root, null)
  db.exec(`DROP TABLE memory_file_index_links;
    DROP TABLE memory_file_index_lookup;
    DROP TABLE memory_file_index_node_fts`)
  const reopened = openMemoryFileIndex({ db })
  assert.equal(reopened.nodeAt(workspace, target.path)?.id, target.id)
  assert.deepEqual(reopened.linkTargets(root, 1), { rows: [target.path], incomplete: false })
  assert.deepEqual(reopened.linkingNodes(workspace, [target.path], 1).rows.map(entry => entry.id), [root.id])
  assert.equal(reopened.remove(root), true)
  assert.deepEqual(reopened.linkingNodes(workspace, [target.path], 1).rows, [])
  assert.deepEqual(reopened.nodeCandidates('root', { workspaces: [workspace] }, 1).rows, [])
})

test('bounded semantic probing retains lexical candidates and supplements the most recently published nodes', t => {
  const { index } = fixture(t)
  const contents = [file('preferred', 'needle'), file('older'), file('recent')]
  for (const entry of contents) index.accept(entry, null)
  const space = { fingerprint: 'test', dimensions: 2 }
  const generation = index.beginVectors(space)
  const refs = index.missingVectors(generation).map(entry => entry.ref)
  index.stageVectors(generation, refs.map(ref => ({ ref, vectors: [new Float32Array([1, 0])] })))
  assert.equal(index.finishVectors(generation, refs), true)
  const scope = { workspaces: [workspace] }
  const preferred = index.lexicalCandidates('needle', scope, 2).rows
  const result = index.vectorCandidates(new Float32Array([1, 0]), space, scope, preferred, 2)
  assert.equal(result?.incomplete, true)
  assert.deepEqual(new Set(result?.rows.map(hit => hit.file.id)), new Set(['preferred', 'recent']))
})
