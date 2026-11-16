import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { createMemorySendFence } from '../src/memory/core/send-fence.ts'
import { createMemoryNoteJobs } from '../src/memory/core/memory-note-jobs.ts'
import { createEffects } from '../src/memory/node/effects.ts'
import { WRITE_NOTE } from '../src/memory/core/memory-notes.ts'
import type { MemorySendPermit } from '../src/memory/core/send-fence.ts'

function aborted(signal:AbortSignal) {
  return signal.aborted ? Promise.resolve() : new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('expected physical send abort')),3000)
    signal.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true})
  })
}
test('a live physical send permit must settle before an ordinary daily update can change its file version',async t=>{
  const {dir,defer}=scratch(t,'memory-note-live-fence-')
  const owner=openMemoryOwner({root:dir,dailyNotes:{noteInterval:1,timezone:'UTC'},fileMode:true,
    route:()=>({provider:'fake',model:'fake'}),quiesce:async()=>{},compute(job){
      if(job.stage!=='note')return null
      const data=JSON.parse(job.input) as {existing?:{markdown:string},turns:Array<{user:Array<{text:string}>}>}
      return Promise.resolve(JSON.stringify({status:'write',title:'Notes',markdown:[data.existing?.markdown??'',...data.turns.flatMap(turn=>turn.user.map(s=>s.text))].filter(Boolean).join('\n')}))
    }})
  defer(()=>owner.close());await owner.recover()
  const db=new DatabaseSync(join(dir,'memory.db'));defer(()=>db.close())
  const session=randomUUID()
  async function turn(turn:number,text:string) {
    const input={sessionId:session,messageId:randomUUID(),text,at:Date.now(),timezone:'UTC',turn,step:1,admitted:true,inherited:false}
    const receipt=await owner.receiveSource(input)
    await owner.completeTurn({sessionId:session,turn,eventSeq:turn*3,sourceIds:[receipt.sourceId],assistant:'',completed:true,at:input.at,timezone:'UTC'})
  }
  await turn(1,'I enjoy peppermint tea.');await owner.runtime.wake()
  const before=db.prepare('SELECT revision,file_revision FROM memory_daily_notes').get()!
  const packet=JSON.parse(owner.runtime.handle({op:'recall',session,query:'peppermint'},owner.sessionContext(session))) as {notes?:unknown[]}
  assert.equal(packet.notes?.length,1)
  const permit=owner.acquireSend(randomUUID(),{session},'request body containing the accepted daily')
  try {
    await turn(2,'I listen to quiet music.')
    const work=owner.runtime.wake()
    await aborted(permit.signal)
    assert.deepEqual(db.prepare('SELECT revision,file_revision FROM memory_daily_notes').get(),before)
    permit.settled();await work
    assert.ok(Number(db.prepare('SELECT revision FROM memory_daily_notes').get()?.revision)>Number(before.revision))
  } finally { permit.settled() }
})

test('intake does not recover an unrelated pending daily commit and fenced job recovery waits for settled transport',async t=>{
  const {dir,defer}=scratch(t,'memory-note-recover-fence-'),store=openMemoryStore(join(dir,'memory.db'))
  defer(()=>store.close())
  const source=noteSource(store),notes=openMemoryNotes(store,()=>true),key=notes.add('session','2026-11-14',[source],'')!
  const crashing=openMemoryNotes(store,()=>true,point=>{if(point==='intent')throw new Error('crash')})
  assert.throws(()=>crashing.commit(key,crashing.pending(key),{status:'write',title:'Notes',markdown:'Accepted pending text.'},1,1,crashing.snapshot([source.id]),undefined),/crash/)
  const later=noteSource(store,{session:'independent'})
  const intake=openMemoryNotes(store,()=>true,undefined,undefined,undefined,undefined,undefined,{deferRecovery:true})
  intake.add('independent','2026-11-14',[later],'')
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_daily_notes').get()?.n,0,'intake cannot secretly finish a daily file mutation')
  const fence=createMemorySendFence({epoch:'test',admit:()=>({current:()=>true,deadline:null})})
  const permit=fence.acquire('held',{session:'test'},'pending body')
  const effects=createEffects({db:store.db,now:()=>1000,later:()=>null,cancel:()=>{}});defer(()=>effects.close())
  createMemoryNoteJobs({store,effects,now:()=>1000,openNotes:()=>intake,readable:()=>true,eligible:()=>false,allowsText:()=>true,
    assistantContextCurrent:()=>true,calculate:async()=>undefined,mutate:write=>fence.mutate(write),settings:{noteInterval:1}})
  try {
    const work=effects.wake();await aborted(permit.signal)
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_daily_notes').get()?.n,0)
    permit.settled();await work
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_daily_notes').get()?.n,1)
  } finally {permit.settled();await fence.close()}
})

test('normal daily commit callbacks roll back with metadata and run atomically during restart recovery',t=>{
  const {dir,defer}=scratch(t,'memory-note-commit-callback-'),store=openMemoryStore(join(dir,'memory.db'))
  defer(()=>store.close());store.db.exec('CREATE TABLE test_revisions(n INTEGER);INSERT INTO test_revisions VALUES(0)')
  const source=noteSource(store),notes=openMemoryNotes(store,()=>true),key=notes.add('session','2026-11-14',[source],'')!
  const failed=openMemoryNotes(store,()=>true,undefined,undefined,undefined,undefined,undefined,{onCommitted(){
    assert.equal(store.db.isTransaction,true);store.db.exec('UPDATE test_revisions SET n=n+1');throw new Error('callback')
  }})
  assert.throws(()=>failed.commit(key,failed.pending(key),{status:'write',title:'Notes',markdown:'Accepted text.'},1,1,failed.snapshot([source.id]),undefined),/callback/)
  assert.equal(store.db.prepare('SELECT n FROM test_revisions').get()?.n,0)
  assert.equal(failed.read(key),undefined)
  const recovered=openMemoryNotes(store,()=>true,undefined,undefined,undefined,undefined,undefined,{onCommitted(){
    assert.equal(store.db.isTransaction,true);store.db.exec('UPDATE test_revisions SET n=n+1')
  }})
  assert.equal(recovered.read(key)?.markdown,'Accepted text.')
  assert.equal(store.db.prepare('SELECT n FROM test_revisions').get()?.n,1)
})

for (const changed of ['unchanged', 'projection-restored', 'generation-cancelled'] as const) {
  test(`empty daily rebuild fences deletion and rechecks ${changed} after transport settles`,async t=>{
    const {dir,defer}=scratch(t,'memory-note-empty-fence-'),store=openMemoryStore(join(dir,'memory.db'))
    defer(()=>store.close())
    const source=noteSource(store),notes=openMemoryNotes(store,()=>true),key=notes.add('session','2026-11-14',[source],'')!
    notes.commit(key,notes.pending(key),{status:'write',title:'Original',markdown:'Accepted original evidence.'},99,1,notes.snapshot([source.id]),undefined)
    const before=notes.read(key)!
    const fence=createMemorySendFence({epoch:'test',admit:()=>({current:()=>true,deadline:null})})
    const effects=createEffects({db:store.db,now:()=>1000,later:()=>null,cancel:()=>{}});defer(()=>effects.close())
    let projectionRestored=false,mutations=0
    let announce!: (permit:MemorySendPermit)=>void
    const acquired=new Promise<MemorySendPermit>(resolve=>{announce=resolve})
    createMemoryNoteJobs({store,effects,now:()=>1000,openNotes:()=>notes,readable:()=>true,eligible:()=>true,allowsText:()=>true,
      projectSource:()=>({text:projectionRestored?source.text!:''}),assistantContextCurrent:()=>true,calculate:async()=>undefined,
      async mutate(write){
        const result=await fence.mutate(write)
        // A new physical attempt starts after initial recovery releases its fence.
        if (++mutations===1) announce(fence.acquire('held',{session:'test'},'accepted daily evidence'))
        return result
      },settings:{noteInterval:1}})
    effects.queue(WRITE_NOTE,key,{rebuild:true,flush:true})
    const work=effects.wake(),permit=await acquired
    try {
      await Promise.race([aborted(permit.signal),work.then(()=>{throw new Error('rebuild completed without fencing its deletion')})])
      assert.equal(notes.read(key)?.fileRevision,before.fileRevision,'accepted file remains intact until physical transport settles')
      if(changed==='projection-restored')projectionRestored=true
      if(changed==='generation-cancelled')effects.cancel(WRITE_NOTE,key)
      permit.settled();await work
      assert.equal(notes.read(key)?.markdown,changed==='unchanged'?undefined:'Accepted original evidence.')
    } finally {permit.settled();await work;await fence.close()}
  })
}
