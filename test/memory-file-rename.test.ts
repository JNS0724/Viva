import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { mkdirSync, renameSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import type { FileCheckpoint } from '../src/memory/node/memory-file-journal.ts'
function fixture(t:test.TestContext) {
  const {dir,defer}=scratch(t,'viva-memory-rename-'),store=openMemoryStore(join(dir,'memory.db'))
  defer(()=>store.close())
  const source=noteSource(store), workspace=memorySourceWorkspace(source), ref={id:source.id,token:memorySourceToken(source)}
  const documents=()=>openMemoryDocuments({db:store.db,root:store.fileRoot,source:id=>id===source.id?{workspace,token:ref.token,text:source.text!}:undefined})
  const notes=(checkpoint?:(point:FileCheckpoint)=>void)=>openMemoryNotes(store,id=>Boolean(store.readSource(id)?.text),checkpoint)
  const move=(from:string,to:string)=>{mkdirSync(dirname(join(store.fileRoot,workspace,to)),{recursive:true});renameSync(join(store.fileRoot,workspace,from),join(store.fileRoot,workspace,to))}
  return {store,source,workspace,ref,documents,notes,move}
}
test('digest external rename preserves identity, stop state, aliases and semantic undo history',t=>{
  const f=fixture(t), docs=f.documents(), from='digest/wiki/a.md',to='digest/wiki/renamed.md'
  docs.commit({operationId:'create',workspace:f.workspace,path:from,expectedRevision:null,markdown:'old',sources:[f.ref],reads:[],action:'CREATE'})
  const first=docs.read(f.workspace,from)!
  docs.commit({operationId:'correct',workspace:f.workspace,path:from,expectedRevision:first.revision,markdown:'new',sources:[f.ref],reads:[first],action:'CORRECT',corrections:[{path:from,revision:first.revision,startLine:1,endLine:1,text:'old',condition:'',time:''}]})
  const corrected=docs.read(f.workspace,from)!
  docs.setEnabled({operationId:'stop',workspace:f.workspace,documentId:first.id,expectedRevision:corrected.revision,expectedUsageVersion:corrected.usageVersion,enabled:false})
  const stopped=docs.read(f.workspace,from,{includeDisabled:true})!
  f.move(from,to)
  assert.equal(docs.reconcileRename({operationId:'rename',workspace:f.workspace,id:first.id,from,to,revision:stopped.revision,usageVersion:stopped.usageVersion}),true)
  assert.equal(docs.read(f.workspace,to),null)
  assert.equal(docs.read(f.workspace,to,{includeDisabled:true})?.id,first.id)
  assert.equal(docs.supersessions(f.workspace,to).length,1)
  assert.equal(docs.supersessions(f.workspace,from).length,0)
  assert.deepEqual(docs.aliases(f.workspace),[{path:from,id:first.id}])
  const reopened=f.documents()
  reopened.undo({operationId:'undo',workspace:f.workspace,documentId:first.id,revision:stopped.revision,usageVersion:stopped.usageVersion})
  assert.equal(reopened.read(f.workspace,to,{includeDisabled:true})?.markdown,'old')
  assert.equal(reopened.read(f.workspace,to),null)
})
for(const point of ['intent','replace','receipt','checkpoint'] as const) test(`daily external rename recovers ledger, alias, day index at ${point}`,t=>{
  const f=fixture(t),notes=f.notes(),key=notes.add('session','2026-11-14',[f.source],'')!,rows=notes.pending(key)
  notes.commit(key,rows,{status:'write',title:'tea',markdown:'Enjoy tea.'},1,1,[f.ref],undefined)
  const before=notes.read(key)!,to='daily/2026-11-14/renamed.md'
  const docs=f.documents(),digest='digest/wiki/correction.md'
  const startLine=before.document.split('\n').findIndex(line=>line==='Enjoy tea.')+1
  docs.commit({operationId:'create-daily-digest',workspace:f.workspace,path:digest,expectedRevision:null,markdown:'Prior summary.',sources:[f.ref],reads:[],action:'CREATE'})
  docs.commit({operationId:'correct-daily',workspace:f.workspace,path:digest,expectedRevision:docs.read(f.workspace,digest)!.revision,markdown:'Coffee instead.',sources:[f.ref],reads:[],files:[{path:before.path,revision:before.fileRevision}],action:'CORRECT',corrections:[{path:before.path,revision:before.fileRevision,startLine,endLine:startLine,text:'Enjoy tea.',condition:'',time:''}]})
  f.move(before.path,to)
  let failed=false
  const crash=f.notes(at=>{if(at===point&&!failed){failed=true;throw new Error('crash')}})
  const input={operationId:'rename',workspace:f.workspace,id:key,from:before.path,to,revision:before.fileRevision,usageVersion:before.revision}
  assert.throws(()=>crash.reconcileRename(input),/crash/)
  const reopened=f.notes();reopened.recover()
  const after=reopened.read(key)!
  assert.equal(after.path,to);assert.equal(after.revision,before.revision+1);assert.equal(after.fileRevision,before.fileRevision)
  assert.equal(readFileSync(join(f.store.fileRoot,f.workspace,'daily/2026-11-14.md'),'utf8').includes(`[[${to}]]`),true)
  assert.equal(readFileSync(join(f.store.fileRoot,f.workspace,'daily/2026-11-14.md'),'utf8').includes(`[[${before.path}]]`),false)
  assert.equal(docs.supersessions(f.workspace,to).length,1)
  assert.equal(docs.supersessions(f.workspace,before.path).length,0)
  assert.deepEqual(reopened.aliases(),[{workspace:f.workspace,path:before.path,id:key}])
})
test('rename requires missing original and exact unchanged target; copied or edited target cannot acquire identity',t=>{
  const f=fixture(t),docs=f.documents(),from='digest/wiki/a.md',to='digest/wiki/b.md'
  docs.commit({operationId:'create',workspace:f.workspace,path:from,expectedRevision:null,markdown:'original',sources:[f.ref],reads:[],action:'CREATE'})
  const original=docs.read(f.workspace,from)!,input={operationId:'rename',workspace:f.workspace,id:original.id,from,to,revision:original.revision,usageVersion:original.usageVersion}
  writeFileSync(join(f.store.fileRoot,f.workspace,to),'original')
  assert.equal(docs.reconcileRename(input),false)
  f.move(from,to);writeFileSync(join(f.store.fileRoot,f.workspace,to),'modified')
  assert.equal(docs.reconcileRename(input),false)
  assert.equal(docs.registered(f.workspace)[0]?.path,from)
})

for(const point of ['intent','replace'] as const) test(`withdraw cancels pending rename at ${point} and erases both old and externally moved path`,t=>{
  const f=fixture(t),notes=f.notes(),key=notes.add('session','2026-11-14',[f.source],'')!,rows=notes.pending(key)
  notes.commit(key,rows,{status:'write',title:'tea',markdown:'Private peppermint tea preference.'},1,1,[f.ref],undefined)
  const before=notes.read(key)!,to='daily/2026-11-14/moved.md'
  f.move(before.path,to)
  const crash=f.notes(at=>{if(at===point)throw new Error('crash')})
  assert.throws(()=>crash.reconcileRename({operationId:'rename',workspace:f.workspace,id:key,from:before.path,to,revision:before.fileRevision,usageVersion:before.revision}),/crash/)
  notes.withdraw(f.source.id)
  notes.recover()
  assert.equal(notes.read(key),undefined)
  assert.equal(existsSync(join(f.store.fileRoot,f.workspace,to)),false)
  assert.equal(existsSync(join(f.store.fileRoot,f.workspace,before.path)),false)
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM memory_file_intents WHERE plan LIKE '%Private peppermint%'").get()?.n,0)
})
test('rename callbacks execute in the ledger transaction; a failed callback leaves restart recovery pending',t=>{
  const f=fixture(t),notes=f.notes(),key=notes.add('session','2026-11-14',[f.source],'')!,rows=notes.pending(key)
  notes.commit(key,rows,{status:'write',title:'tea',markdown:'Enjoy tea.'},1,1,[f.ref],undefined)
  const before=notes.read(key)!,to='daily/2026-11-14/moved.md';f.move(before.path,to)
  let calls=0
  const failing=openMemoryNotes(f.store,()=>true,undefined,undefined,()=>{assert.equal(f.store.db.isTransaction,true);throw new Error('callback')})
  assert.throws(()=>failing.reconcileRename({operationId:'rename',workspace:f.workspace,id:key,from:before.path,to,revision:before.fileRevision,usageVersion:before.revision}),/callback/)
  assert.equal(failing.registered()[0]?.path,before.path)
  const recovered=openMemoryNotes(f.store,()=>true,undefined,undefined,()=>{assert.equal(f.store.db.isTransaction,true);calls++})
  recovered.recover();assert.equal(calls,1);assert.equal(recovered.read(key)?.path,to)
})

test('digest rename receipt is idempotent and commits atomically with its revision callback',t=>{
  const f=fixture(t),docs=f.documents(),from='digest/wiki/a.md',to='digest/wiki/b.md'
  docs.commit({operationId:'create',workspace:f.workspace,path:from,expectedRevision:null,markdown:'original',sources:[f.ref],reads:[],action:'CREATE'})
  const before=docs.read(f.workspace,from)!,input={operationId:'rename-receipt',workspace:f.workspace,id:before.id,from,to,revision:before.revision,usageVersion:before.usageVersion}
  f.move(from,to)
  const failing=openMemoryDocuments({db:f.store.db,root:f.store.fileRoot,source:()=>({workspace:f.workspace,token:f.ref.token,text:f.source.text!}),onRenamed:()=>{throw new Error('callback')}})
  assert.throws(()=>failing.reconcileRename(input),/callback/)
  assert.equal(failing.reconciliationState(input.operationId,'rename'),undefined)
  assert.equal(failing.registered(f.workspace)[0]?.path,from)
  assert.equal(docs.reconcileRename(input),true)
  assert.equal(docs.reconciliationState(input.operationId,'rename'),'done')
  assert.equal(docs.reconcileRename(input),true)
  assert.throws(()=>docs.reconcileRename({...input,to:'digest/wiki/other.md'}),/input-mismatch/)
})


test('forgetting a daily renamed across date directories removes the logical day index reference',t=>{
  const f=fixture(t),notes=f.notes(),key=notes.add('session','2026-11-14',[f.source],'')!,rows=notes.pending(key)
  notes.commit(key,rows,{status:'write',title:'tea',markdown:'Private tea preference.'},1,1,[f.ref],undefined)
  const before=notes.read(key)!,to='daily/2026-11-15/renamed-private-title.md'
  f.move(before.path,to)
  assert.equal(notes.reconcileRename({operationId:'cross-day',workspace:f.workspace,id:key,from:before.path,to,revision:before.fileRevision,usageVersion:before.revision}),true)
  assert.equal(notes.read(key)?.day,'2026-11-14')
  notes.withdraw(f.source.id);notes.recover()
  assert.equal(notes.pendingCleanup(),0)
  assert.equal(existsSync(join(f.store.fileRoot,f.workspace,to)),false)
  const index=readFileSync(join(f.store.fileRoot,f.workspace,'daily/2026-11-14.md'),'utf8')
  assert.equal(index.includes(to),false)
  assert.equal(index.includes(before.path),false)
})

test('daily card rename cannot take another day reserved index path',t=>{
  const f=fixture(t),notes=f.notes(),key=notes.add('session','2026-11-14',[f.source],'')!
  notes.commit(key,notes.pending(key),{status:'write',title:'Original card',markdown:'Accepted original evidence.'},1,1,[f.ref],undefined)
  const before=notes.read(key)!,to='daily/2026-11-15.md'
  f.move(before.path,to)
  assert.equal(notes.reconcileRename({operationId:'index-collision',workspace:f.workspace,id:key,
    from:before.path,to,revision:before.fileRevision,usageVersion:before.revision}),false)
  assert.equal(notes.registered().find(row=>row.key===key)?.path,before.path)
  assert.equal(notes.reconciliationState('index-collision','rename'),undefined)
  // Restore the rejected external move, then verify that the next day's generated
  // navigation cannot overwrite a registered card's accepted evidence.
  f.move(to,before.path)
  const next=noteSource(f.store,{at:Date.parse('2026-11-15T01:00:00Z')})
  const nextRef={id:next.id,token:memorySourceToken(next)},nextKey=notes.add('session','2026-11-15',[next],'')!
  notes.commit(nextKey,notes.pending(nextKey),{status:'write',title:'Next card',markdown:'Next day evidence.'},1,1,[nextRef],undefined)
  assert.equal(notes.read(key)?.markdown,'Accepted original evidence.')
  assert.ok(readFileSync(join(f.store.fileRoot,f.workspace,to),'utf8').includes(`[[${notes.read(nextKey)!.path}]]`))
})
