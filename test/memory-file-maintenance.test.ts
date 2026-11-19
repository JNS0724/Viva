import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { scratch } from './fixtures/scratch.js'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { openMemoryStore, memoryHash } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { openMemoryFileCatalog } from '../src/memory/node/memory-file-catalog.ts'
import { createEffects } from '../src/memory/node/effects.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { createMemoryFileMaintenance, currentExternalEdit, externalEditPolicyToken } from '../src/memory/core/memory-file-maintenance.ts'
import type { FileMaintenanceCalculate } from '../src/memory/core/memory-file-maintenance.ts'
import type { MemoryDocuments } from '../src/memory/core/ports/documents.ts'

function harness(t: test.TestContext) {
  const {dir,defer}=scratch(t,'memory-file-maintenance-')
  let now=1000
  const store=openMemoryStore(join(dir,'memory.db'))
  const original=noteSource(store,{text:'I prefer peppermint tea.',hash:memoryHash('I prefer peppermint tea.'),length:23})
  const workspace=memorySourceWorkspace(original), ref={id:original.id,token:memorySourceToken(original)}
  const readable=(id:string)=>Boolean(store.readSource(id)?.text && !store.readSource(id)?.withdrawn)
  let documents:MemoryDocuments
  const policy=()=>({documents,source:(id:string)=>store.readSource(id)??undefined,sourceToken:memorySourceToken,sourceWorkspace:memorySourceWorkspace,readable,hash:memoryHash})
  documents=openMemoryDocuments({db:store.db,root:store.fileRoot,deferRecovery:true,
    source:id=>{const item=store.readSource(id);return item?.text&&readable(id)?{token:memorySourceToken(item),workspace:memorySourceWorkspace(item),text:item.text}:undefined},
    externalCurrent:input=>currentExternalEdit(input,policy())})
  const notes=openMemoryNotes(store,readable,undefined,undefined,undefined,undefined,input=>currentExternalEdit(input,policy()))
  documents.recover()
  let effects=createEffects({db:store.db,now:()=>now,later:()=>null,cancel:()=>{}})
  let calls=0, changed=0, scans=0
  let onChanged=()=>{}
  let model:FileMaintenanceCalculate=async request=>{
    const data=request.input as {canonicalSources:Array<{sourceId:string,version:number,text:string}>}
    const input=data.canonicalSources[0]!
    return JSON.stringify({verdict:'verified',action:'REFINE',classification:'same_abstraction',
      checks:{attribution:true,polarity:true,time:true,conditions:true,meaning:true,sources:true,action:true},
      evidence:[{sourceId:input.sourceId,sourceVersion:input.version,start:0,end:input.text.length,text:input.text,claim:'Peppermint preference.'}],changeEvidence:[],corrections:[]})
  }
  const start = () => {
    const catalog = openMemoryFileCatalog({ root: store.fileRoot })
    return createMemoryFileMaintenance({notes, catalog: { ...catalog, scan(workspace, accepted) {
      scans++
      return catalog.scan(workspace, accepted)
    } }, effects, commands:store,
    identity:{hash:memoryHash,newId:randomUUID},now:()=>now,...policy(),materialAllowed:text=>!text.includes('PRIVATE_SECRET'),
    calculate:async request=>{calls++;assert(request.current());return model(request)},mutate:async write=>write(),changed:()=>{changed++;onChanged()}})
  }
  let maintenance=start()
  defer(()=>{maintenance.close();effects.close();store.close()})
  const put=(path:string,text:string)=>{const absolute=join(store.fileRoot,workspace,path);mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,text)}
  const daily=()=>{const key=notes.add('session','2026-11-14',[original],'')!;notes.commit(key,notes.pending(key),{status:'write',title:'Tea',markdown:original.text!},1,now,[ref],undefined);return notes.read(key)!}
  const digest=()=>{documents.commit({operationId:randomUUID(),workspace,path:'digest/personal/tea.md',expectedRevision:null,markdown:'Peppermint tea.',sources:[ref],reads:[],action:'CREATE'});return documents.read(workspace,'digest/personal/tea.md')!}
  return {store,notes,documents,workspace,original,ref,daily,digest,put,policy,
    get calls(){return calls},get scans(){return scans},get changed(){return changed},get maintenance(){return maintenance},
    setModel(next:FileMaintenanceCalculate){model=next},afterChanged(next:()=>void){onChanged=next},
    async run(id:string){maintenance.rescan(id);await effects.wake();return maintenance.status(id)!},
    async wake() { await effects.wake() },
    async retry(){now+=60_000;await effects.wake()},
    restart(){maintenance.close();effects.close();effects=createEffects({db:store.db,now:()=>now,later:()=>null,cancel:()=>{}});maintenance=start()},
    move(from:string,to:string){mkdirSync(dirname(join(store.fileRoot,workspace,to)),{recursive:true});renameSync(join(store.fileRoot,workspace,from),join(store.fileRoot,workspace,to))},
  }
}

test('daily external edit is independently revalidated from the same original sources and has a durable rescan receipt',async t=>{
  const h=harness(t),note=h.daily(),text=note.document.replace('I prefer peppermint tea.','Peppermint tea is my preference.')
  h.put(note.path,text)
  const result=await h.run('daily-edit')
  assert.equal(result.status,'completed');assert.equal(result.accepted,1)
  assert.equal(h.notes.registered()[0]!.file_revision,memoryHash(text))
  assert.equal(h.calls,1)
  assert.deepEqual(await h.run('daily-edit'),result);assert.equal(h.calls,1)
})

test('digest edit supplies exact accepted prior body and unsupported or secret edits remain quarantined',async t=>{
  const h=harness(t),doc=h.digest()
  h.put(doc.path,'Unsupported claim.')
  h.setModel(async request=>{assert.equal((request.input as {before:{markdown:string}}).before.markdown,doc.markdown);return '{"verdict":"rejected","reason":"unsupported"}'})
  assert.equal((await h.run('rejected')).quarantined,1)
  assert.equal(h.documents.registered(h.workspace)[0]!.revision,doc.revision)
  assert.equal((await h.run('same-rejected')).quarantined,1);assert.equal(h.calls,1,'same observed bytes and policy reuse the terminal verdict')
  h.put(doc.path,'PRIVATE_SECRET')
  assert.equal((await h.run('secret')).quarantined,1);assert.equal(h.calls,1)
})

test('unregistered copies are isolated while a unique unchanged rename keeps identity',async t=>{
  const h=harness(t),doc=h.digest(),target='digest/personal/moved.md'
  h.move(doc.path,target)
  const result=await h.run('rename')
  assert.equal(result.renamed,1);assert.equal(h.documents.read(h.workspace,target)?.id,doc.id);assert.equal(h.calls,0)
  h.put('digest/wiki/copy.md',doc.markdown)
  const duplicate=await h.run('copy')
  assert.equal(duplicate.quarantined,1);assert.equal(h.documents.registered(h.workspace).length,1)
})

test('late model output cannot accept a newer physical edit or a withdrawn source',async t=>{
  const h=harness(t),doc=h.digest();h.put(doc.path,'Tea preference clarified.')
  h.setModel(async request=>{h.put(doc.path,'A different edit.');assert.equal(request.current(),false);return undefined})
  assert.equal((await h.run('late')).quarantined,1)
  assert.equal(h.documents.registered(h.workspace)[0]!.revision,doc.revision)
  h.setModel(async request=>{h.store.withdrawSource(h.original.id);assert.equal(request.current(),false);return undefined})
  assert.equal((await h.run('forgotten')).quarantined,1)
  assert.equal(h.documents.read(h.workspace,doc.path),null)
})

test('pending verification survives runner recreation and a committed receipt survives a callback failure',async t=>{
  const h=harness(t),note=h.daily();h.put(note.path,note.document.replace('I prefer peppermint tea.','Peppermint tea is preferred.'))
  let available=false
  h.setModel(async request=>{
    if(!available)return undefined
    const item=(request.input as {canonicalSources:Array<{sourceId:string,version:number,text:string}>}).canonicalSources[0]!
    return JSON.stringify({verdict:'verified',action:'REFINE',classification:'same_abstraction',checks:{attribution:true,polarity:true,time:true,conditions:true,meaning:true,sources:true,action:true},
      evidence:[{sourceId:item.sourceId,sourceVersion:item.version,start:0,end:item.text.length,text:item.text,claim:'Preference'}],changeEvidence:[],corrections:[]})
  })
  assert.equal((await h.run('recover')).status,'pending')
  available=true;let crash=true;h.afterChanged(()=>{if(crash){crash=false;throw new Error('after stored receipt')}})
  h.restart();await h.retry()
  assert.equal(h.maintenance.status('recover')?.status,'pending')
  const count=h.calls
  h.restart();await h.retry()
  assert.equal(h.maintenance.status('recover')?.accepted,1)
  assert.equal(h.maintenance.status('recover')?.status,'completed')
  assert.equal(h.calls,count,'already committed edit is never sent for semantic review again')
})

test('periodic scanning is separate from explicit operations and scans every registered scope',async t=>{
  const h=harness(t),doc=h.digest();h.put(doc.path,'Clarified preference.')
  h.maintenance.start()
  await h.retry();await h.retry()
  assert.equal(h.documents.registered(h.workspace)[0]!.revision,memoryHash('Clarified preference.'))
  assert.equal(h.calls,1)
  await h.retry();await h.retry()
  assert.equal(h.calls,1,'unchanged accepted files do not repeatedly invoke the verifier')
})

test('existing supersession anchors must survive edits, and replacement dependencies join the request barrier',async t=>{
  const h=harness(t),note=h.daily()
  const replacementSource=noteSource(h.store,{text:'Correction: coffee replaces tea.',hash:memoryHash('Correction: coffee replaces tea.'),length:31})
  const replacementRef={id:replacementSource.id,token:memorySourceToken(replacementSource)},path='digest/personal/replacement.md'
  const created=h.documents.commit({operationId:'replacement-create',workspace:h.workspace,path,expectedRevision:null,markdown:'Summary.',action:'CREATE',sources:[replacementRef],reads:[]})
  const line=note.document.split('\n').findIndex(value=>value===h.original.text)+1
  h.documents.commit({operationId:'replacement-correct',workspace:h.workspace,path,expectedRevision:created.revision,markdown:'Coffee now.',action:'CORRECT',sources:[replacementRef],reads:[],files:[{path:note.path,revision:note.fileRevision}],
    corrections:[{path:note.path,revision:note.fileRevision,startLine:line,endLine:line,text:h.original.text!,condition:'drink',time:'current'}]})
  h.put(note.path,note.document.replace('I prefer peppermint tea.','Peppermint tea is current.'))
  assert.equal((await h.run('bad-anchor')).quarantined,1);assert.equal(h.calls,0)
  h.put(note.path,note.document+'\nUnrelated supporting detail.')
  h.setModel(async request=>{
    assert.deepEqual(new Set(request.sourceIds()),new Set([h.original.id,replacementSource.id]))
    h.store.withdrawSource(replacementSource.id)
    assert.equal(request.current(),false)
    assert(request.sourceIds().includes(replacementSource.id),'invalidated dependency is retained until the request drains')
    return undefined
  })
  assert.equal((await h.run('replacement-withdrawn')).quarantined,1)
})

test('cross-scope source references and evidence outside the original spans cannot authorize external edits',async t=>{
  const h=harness(t),doc=h.digest()
  const privateSource=noteSource(h.store,{scope:{kind:'project',id:'private'},project:{kind:'project',id:'private'}})
  assert.equal(currentExternalEdit({operationId:'forged',workspace:h.workspace,id:doc.id,path:doc.path,expectedRevision:doc.revision,expectedUsageVersion:doc.usageVersion,
    observedRevision:'edited',sources:[{id:privateSource.id,token:memorySourceToken(privateSource)}],policyToken:'forged'},h.policy()),false)
  h.put(doc.path,'Unrelated fact.')
  h.setModel(async()=>JSON.stringify({verdict:'verified',action:'REFINE',classification:'same_abstraction',checks:{attribution:true,polarity:true,time:true,conditions:true,meaning:true,sources:true,action:true},
    evidence:[{sourceId:privateSource.id,sourceVersion:privateSource.version,start:0,end:privateSource.text!.length,text:privateSource.text,claim:'forged'}],changeEvidence:[],corrections:[]}))
  assert.equal((await h.run('forged-evidence')).quarantined,1)
  assert.equal(h.documents.registered(h.workspace)[0]!.revision,doc.revision)
})

test('an unchanged disabled document can move without re-enabling it or invoking a model',async t=>{
  const h=harness(t),doc=h.digest(),path='digest/personal/stopped-moved.md'
  h.documents.setEnabled({operationId:'disable',workspace:h.workspace,documentId:doc.id,expectedRevision:doc.revision,expectedUsageVersion:doc.usageVersion,enabled:false})
  h.move(doc.path,path)
  assert.equal((await h.run('stopped-rename')).renamed,1)
  assert.equal(h.documents.read(h.workspace,path),null)
  assert.equal(h.documents.read(h.workspace,path,{includeDisabled:true})?.id,doc.id)
  h.put(path,'An edited disabled document.')
  assert.equal((await h.run('stopped-edit')).quarantined,1)
  assert.equal(h.calls,0)
})

test('a replacement physical edit invalidates an awaiting external-file verification without changing its ledger',async t=>{
  const h=harness(t),note=h.daily(),path='digest/personal/live-replacement.md'
  const replacement=h.documents.commit({operationId:'physical-replacement-create',workspace:h.workspace,path,expectedRevision:null,
    markdown:'Summary.',action:'CREATE',sources:[h.ref],reads:[]})
  const line=note.document.split('\n').findIndex(value=>value===h.original.text)+1
  h.documents.commit({operationId:'physical-replacement-correct',workspace:h.workspace,path,expectedRevision:replacement.revision,
    markdown:'Peppermint later.',action:'CORRECT',sources:[h.ref],reads:[],files:[{path:note.path,revision:note.fileRevision}],
    corrections:[{path:note.path,revision:note.fileRevision,startLine:line,endLine:line,text:h.original.text!,condition:'drink',time:'later'}]})
  h.put(note.path,note.document+'\nCompatible description.')
  h.setModel(async request=>{
    const before=h.documents.registered(h.workspace)[0]!
    h.put(path,'Unverified replacement body.')
    assert.equal(h.documents.registered(h.workspace)[0]!.revision,before.revision)
    assert.equal(request.current(),false)
    return undefined
  })
  assert.equal((await h.run('replacement-physical-edit')).quarantined,1)
  assert.equal(h.notes.registered()[0]!.file_revision,note.fileRevision)
  h.setModel(async request=>{assert.equal((request.input as {kind:string}).kind,'digest','dependent daily is not reviewed while its replacement is quarantined');return '{"verdict":"rejected","reason":"unsupported replacement"}'})
  assert.ok((await h.run('replacement-still-unverified')).quarantined>=1)
})

test('external verification only receives the original document evidence spans with stable offsets',async t=>{
  const h=harness(t),path='digest/personal/narrow.md',start=h.original.text!.indexOf('peppermint'),end=h.original.text!.length
  h.documents.commit({operationId:'narrow-evidence',workspace:h.workspace,path,expectedRevision:null,
    markdown:'Peppermint tea.',action:'CREATE',sources:[{...h.ref,spans:[{start,end}]}],reads:[]})
  h.put(path,'Peppermint preference clarified.')
  h.setModel(async request=>{
    const text=(request.input as {canonicalSources:Array<{text:string}>}).canonicalSources[0]!.text
    assert.equal(text.length,h.original.text!.length)
    assert.equal(text.slice(0,start),' '.repeat(start))
    assert.equal(text.slice(start),h.original.text!.slice(start))
    return '{"verdict":"rejected","reason":"fixture"}'
  })
  assert.equal((await h.run('bounded-evidence')).quarantined,1)
})


test('unreadable replacement policy isolates the affected chain instead of throwing out of a scan', t => {
  const h = harness(t), note = h.daily()
  const path = 'digest/personal/unreadable.md'
  const created = h.documents.commit({ operationId: 'unreadable-create', workspace: h.workspace, path,
    expectedRevision: null, markdown: 'Old.', action: 'CREATE', sources: [h.ref], reads: [] })
  const line = note.document.split('\n').findIndex(value => value === h.original.text) + 1
  h.documents.commit({ operationId: 'unreadable-correct', workspace: h.workspace, path, expectedRevision: created.revision,
    markdown: 'Peppermint.', action: 'CORRECT', sources: [h.ref], reads: [], files: [{path:note.path, revision:note.fileRevision}],
    corrections: [{path:note.path, revision:note.fileRevision, startLine:line, endLine:line, text:h.original.text!, condition:'', time:''}] })
  const policy = h.policy()
  const denied = { ...policy, documents: { ...policy.documents, read() { throw new Error('simulated unsafe path') } } }
  assert.equal(externalEditPolicyToken({ workspace:h.workspace, id:note.key, path:note.path, sources:[h.ref] }, denied), null)
  const independent = h.digest()
  assert(externalEditPolicyToken({ workspace:h.workspace, id:independent.id, path:independent.path, sources:[h.ref] }, denied))
})

test('queued rescans share one directory observation and still get individual durable receipts', async t => {
  const h = harness(t)
  const doc = h.digest()
  h.put(doc.path, 'Clarified peppermint preference.')
  h.maintenance.rescan('request-one')
  h.maintenance.rescan('request-two')
  await h.wake()

  assert.equal(h.scans, 1)
  assert.equal(h.calls, 1)
  const first = h.maintenance.status('request-one')
  const second = h.maintenance.status('request-two')
  assert.equal(first?.accepted, 1)
  assert.equal(second?.status, 'completed')
  assert.deepEqual(second, { ...first, operationId: 'request-two' })
})
