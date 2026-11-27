import test from 'node:test'
import { offlineMemorySafety } from './fixtures/memory-safety.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { createMemoryRuntime } from '../src/memory/core/memory-runtime.ts'
import { openMemoryRuntimeResources } from '../src/memory/node/runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'

test('unverified daily edits never enter later note requests or become accepted, and malformed cards do not block restart',async t=>{
  const {dir,defer}=scratch(t,'viva-note-read-boundaries-'),path=join(dir,'memory.db'),now=()=>Date.parse('2026-11-16T12:00:00Z')
  const calls:MemoryCompute[]=[]
  function open() {
    const store=openMemoryStore(path,now),resources=openMemoryRuntimeResources({store,now})
    const runtime=createMemoryRuntime({ ...offlineMemorySafety,store,resources,now,dailyNotes:{noteInterval:1,timezone:'UTC'},
      route:()=>({provider:'fake',model:'fake'}),changed:()=>{},compute(job){
        if(job.stage!=='note')return null
        calls.push(job)
        const data=JSON.parse(job.input) as {existing?:{state:string},turns:Array<{user:Array<{text:string}>}>}
        const turnTexts=data.turns.flatMap(turn=>turn.user.map(source=>source.text))
        return Promise.resolve(JSON.stringify({status:'write',title:'Notes',state:[data.existing?.state??'',...turnTexts].filter(Boolean).join('\n'),events:turnTexts}))
      }})
    return {store,runtime}
  }
  let state=open();defer(()=>state.runtime.close())
  async function turn(session:string,text:string) {
    const source=randomUUID(),origin={session,conversation:session}
    state.runtime.accept(text,origin,source);state.runtime.recordNoteTurn!(session,[source],'');await state.runtime.wake()
  }
  await turn('changed','I like drinking tea.')
  const row=state.store.db.prepare('SELECT * FROM memory_daily_notes').get()!,file=join(state.store.fileRoot,String(row.workspace),String(row.path)),original=readFileSync(file,'utf8')
  const marker='Unverified external fact about managing the finance team.'
  writeFileSync(file,original.replace('I like drinking tea.',marker))
  const callsBefore=calls.length
  await turn('changed','I also enjoy music.')
  assert.equal(calls.length,callsBefore,'a changed existing card waits for independent verification')
  assert.equal(calls.some(call=>call.input.includes(marker)),false)
  assert.equal(state.store.db.prepare('SELECT file_revision FROM memory_daily_notes WHERE key=?').get(String(row.key))?.file_revision,row.file_revision)
  assert.equal(readFileSync(file,'utf8').includes(marker),true,'the external file is not silently overwritten with a new card')

  await turn('independent','I keep orchids on the balcony.')
  assert.equal(calls.length,callsBefore+1)
  writeFileSync(file,'---\nunclosed: [')
  state.runtime.close();state=open()
  await state.runtime.wake()
  const origin={session:'independent',conversation:'independent'}
  const recalled=JSON.parse(state.runtime.handle({op:'recall',session:'independent',query:'orchids'},origin)) as {notes?:Array<{markdown:string}>}
  assert.ok(recalled.notes?.some(note=>note.markdown.includes('orchids')))
  await turn('independent','I water the orchids every weekend.')
  assert.ok(calls.at(-1)?.input.includes('water the orchids'))
  assert.equal(calls.some(call=>call.input.includes(marker)||call.input.includes('unclosed: [')),false)
})
