import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import type { DocumentExternalEdit } from '../src/memory/core/ports/documents.ts'
import type { FileCheckpoint } from '../src/memory/node/memory-file-journal.ts'
function fixture(t:test.TestContext) {
  const {dir,defer}=scratch(t,'viva-memory-edit-'),store=openMemoryStore(join(dir,'memory.db'))
  defer(()=>store.close())
  const source=noteSource(store),workspace=memorySourceWorkspace(source),ref={id:source.id,token:memorySourceToken(source)}
  const state={allowed:true,source:true}
  store.db.exec('CREATE TABLE test_edit_callbacks(count INTEGER);INSERT INTO test_edit_callbacks VALUES(0)')
  const callback=()=>{assert.equal(store.db.isTransaction,true);store.db.exec('UPDATE test_edit_callbacks SET count=count+1')}
  const callbacks=()=>Number(store.db.prepare('SELECT count FROM test_edit_callbacks').get()?.count)
  const externalCurrent=(input:DocumentExternalEdit)=>state.allowed&&input.policyToken==='policy'
  const documents=(checkpoint?:(point:FileCheckpoint)=>void,delayed=false)=>openMemoryDocuments({db:store.db,root:store.fileRoot,
    source:id=>state.source&&id===source.id?{workspace,token:ref.token,text:source.text!}:undefined,checkpoint,externalCurrent,deferRecovery:delayed,
    onCommitted:callback})
  const notes=(checkpoint?:(point:FileCheckpoint)=>void)=>openMemoryNotes(store,()=>state.source,checkpoint,undefined,undefined,
    callback,externalCurrent)
  const write=(path:string,text:string)=>writeFileSync(join(store.fileRoot,workspace,path),text)
  return {store,source,workspace,ref,state,documents,notes,write,callbacks}
}
function digest(f:ReturnType<typeof fixture>) {
  const documents=f.documents(),path='digest/wiki/fact.md'
  documents.commit({operationId:'create',workspace:f.workspace,path,expectedRevision:null,markdown:'Original accepted text.',action:'CREATE',sources:[f.ref],reads:[]})
  const before=documents.read(f.workspace,path)!,after='Source-supported edited text.'
  f.write(path,after)
  const input:DocumentExternalEdit={operationId:'external',workspace:f.workspace,id:before.id,path,expectedRevision:before.revision,expectedUsageVersion:before.usageVersion,observedRevision:memoryFileRevision(after),sources:[f.ref],policyToken:'policy'}
  return {documents,before,after,input}
}
function daily(f:ReturnType<typeof fixture>) {
  const notes=f.notes(),key=notes.add('session','2026-11-14',[f.source],'')!,rows=notes.pending(key)
  notes.commit(key,rows,{status:'write',title:'tea',markdown:'Original accepted text.'},1,1,[f.ref],undefined)
  const before=notes.read(key)!,after=before.document.replace('Original accepted text.','Source-supported edited text.')
  f.write(before.path,after)
  const input:DocumentExternalEdit={operationId:'external',workspace:f.workspace,id:key,path:before.path,expectedRevision:before.fileRevision,expectedUsageVersion:before.revision,observedRevision:memoryFileRevision(after),sources:[f.ref],policyToken:'policy'}
  return {notes,before,after,input,key}
}
for(const point of ['intent','replace','receipt','checkpoint'] as const) {
  test(`external digest verification persists exact accepted history and recovers at ${point}`,t=>{
    const f=fixture(t),{before,after,input}=digest(f)
    let crash=false
    const documents=f.documents(at=>{if(at===point&&!crash){crash=true;throw new Error('crash')}})
    assert.equal(documents.acceptedSnapshot(f.workspace,before.id)?.markdown,before.markdown)
    assert.throws(()=>documents.reconcileEdit(input),/crash/)
    const resumed=f.documents(),current=resumed.read(f.workspace,input.path)!
    assert.equal(current.markdown,after);assert.equal(current.usageVersion,before.usageVersion+1)
    assert.equal(resumed.receipt(f.workspace,input.operationId)?.revision,input.observedRevision)
    assert.equal(f.callbacks(),2)
    resumed.undo({operationId:'undo',workspace:f.workspace,documentId:before.id,revision:current.revision,usageVersion:current.usageVersion})
    assert.equal(resumed.read(f.workspace,input.path)?.markdown,before.markdown)
  })
  test(`external daily verification commits no invented turn and recovers at ${point}`,t=>{
    const f=fixture(t),{before,after,input,key}=daily(f)
    let crash=false
    const notes=f.notes(at=>{if(at===point&&!crash){crash=true;throw new Error('crash')}})
    assert.throws(()=>notes.reconcileEdit(input),/crash/)
    const resumed=f.notes(),current=resumed.read(key)!
    assert.equal(current.document,after);assert.equal(current.revision,before.revision+1)
    assert.equal(current.file_revision,input.observedRevision)
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM memory_note_turns').get()?.n,1)
    assert.equal(f.callbacks(),1)
  })
}
test('late external verifiers cannot accept a different observed version or stale registered revision',t=>{
  const f=fixture(t),{documents,before,input}=digest(f)
  f.write(input.path,'Another external writer.')
  assert.equal(documents.reconcileEdit(input),null)
  assert.equal(readFileSync(join(f.store.fileRoot,f.workspace,input.path),'utf8'),'Another external writer.')
  f.write(input.path,'Source-supported edited text.')
  const receipt=documents.reconcileEdit(input)!
  f.write(input.path,'A third version.')
  assert.equal(documents.reconcileEdit({...input,operationId:'late',observedRevision:memoryFileRevision('A third version.')}),null)
  assert.throws(()=>documents.undo({operationId:'late-undo',workspace:f.workspace,documentId:before.id,revision:receipt.revision!,usageVersion:receipt.usageVersion}),/version/)
})
test('external verification is rejected after stop or policy change and requires an explicitly installed guard',t=>{
  const f=fixture(t),{documents,before,input}=digest(f)
  f.state.allowed=false;assert.equal(documents.reconcileEdit(input),null)
  f.state.allowed=true
  const unguarded=openMemoryDocuments({db:f.store.db,root:f.store.fileRoot,source:()=>({workspace:f.workspace,token:f.ref.token,text:f.source.text!})})
  assert.equal(unguarded.reconcileEdit(input),null)
  f.write(input.path,before.markdown)
  documents.setEnabled({operationId:'stop',workspace:f.workspace,documentId:before.id,expectedRevision:before.revision,expectedUsageVersion:before.usageVersion,enabled:false})
  f.write(input.path,'Source-supported edited text.')
  assert.equal(documents.reconcileEdit({...input,expectedUsageVersion:before.usageVersion+1}),null)
})
for(const kind of ['digest','daily'] as const) test(`forgetting source while verified ${kind} edit is pending erases its intent and observed copy`,t=>{
  const f=fixture(t),item=kind==='digest'?digest(f):daily(f)
  const store=kind==='digest'?f.documents(point=>{if(point==='intent')throw new Error('crash')}):f.notes(point=>{if(point==='intent')throw new Error('crash')})
  assert.throws(()=>store.reconcileEdit(item.input),/crash/)
  f.state.source=false;store.withdraw(f.source.id)
  const resumed=kind==='digest'?f.documents():f.notes();resumed.recover()
  assert.equal(existsSync(join(f.store.fileRoot,f.workspace,item.input.path)),false)
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM memory_file_intents WHERE plan LIKE '%Source-supported edited%'").get()?.n,0)
})
test('deferred document recovery invokes the guard only after the caller initializes it',t=>{
  const f=fixture(t),{input}=digest(f)
  assert.throws(()=>f.documents(point=>{if(point==='intent')throw new Error('crash')}).reconcileEdit(input),/crash/)
  f.state.allowed=false
  const delayed=f.documents(undefined,true)
  assert.equal(delayed.receipt(f.workspace,input.operationId),null)
  f.state.allowed=true;delayed.recover()
  assert.equal(delayed.receipt(f.workspace,input.operationId)?.revision,input.observedRevision)
})

for(const kind of ['digest','daily'] as const) test(`external ${kind} edits keep existing supersession anchors or remain quarantined`,t=>{
  const f=fixture(t),item=kind==='digest'?digest(f):daily(f),documents=f.documents()
  const original='document' in item.before ? item.before.document : item.before.markdown
  f.write(item.input.path,original)
  const path='digest/wiki/replacement.md'
  documents.commit({operationId:'replacement-create',workspace:f.workspace,path,expectedRevision:null,markdown:'Initial replacement.',action:'CREATE',sources:[f.ref],reads:[]})
  const replacement=documents.read(f.workspace,path)!,line=original.split('\n').findIndex(value=>value==='Original accepted text.')+1
  documents.commit({operationId:'replace-fragment',workspace:f.workspace,path,expectedRevision:replacement.revision,markdown:'New applicable statement.',action:'CORRECT',sources:[f.ref],reads:[],files:[{path:item.input.path,revision:item.input.expectedRevision}],
    corrections:[{path:item.input.path,revision:item.input.expectedRevision,startLine:line,endLine:line,text:'Original accepted text.',condition:'after change',time:'now'}]})
  f.write(item.input.path,item.after)
  const storage=kind==='digest'?f.documents():f.notes()
  assert.ok(!storage.reconcileEdit(item.input))
  assert.equal(documents.supersessions(f.workspace,item.input.path).length,1)
  const preserved=original+'\nAdditional source-supported context.'
  f.write(item.input.path,preserved)
  assert.ok(storage.reconcileEdit({...item.input,observedRevision:memoryFileRevision(preserved)}))
  assert.equal(documents.supersessions(f.workspace,item.input.path)[0]?.text,'Original accepted text.')
  assert.equal(storage.reconciliationState(item.input.operationId,'edit'),'done')
})
