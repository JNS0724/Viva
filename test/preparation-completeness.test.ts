import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { openFollowups } from '../src/main/followups-main.ts'
import { DEFAULT_SCHEDULE } from '../src/main/prepare-schedule.ts'
import { PREPARE_MAX_TOKENS } from '../src/main/prepare-materials.ts'
import { preparationText } from '../plugins/followups/lib/result.ts'
import { MAX_TOKENS, prepareRequest } from '../plugins/followups/lib/channel.ts'
import type { PrepareCall } from '../src/main/followup-channel.ts'

test('a token-limited follow-up stays scheduled without a draft; a later complete response becomes ready', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viva-prepare-complete-'))
  const calls:Array<Omit<PrepareCall,'provider'|'model'>>=[]
  const errors:unknown[]=[]
  let truncated=true
  const followups=openFollowups({userData:dir,ipcMain:{handle:()=>{}},notify:()=>{},windowInFront:()=>true,onPending:()=>{},idleSeconds:()=>0,
    loadSchedule:()=>({...DEFAULT_SCHEDULE,chosen:true}),storeSchedule:()=>{},userBusy:()=>null,takenUp:()=>false,
    materials:{conversation:()=>null,profile:()=>null},workDir:()=>dir,conversationExists:()=>true,onState:()=>{},onError:error=>errors.push(error),
    prepareText:async call=>{
      calls.push(call)
      const assembler=new BlockAssembler()
      assembler.push({type:'block-start',index:0,blockType:'text'})
      assembler.push({type:'text-delta',index:0,text:truncated?'已按 2026/11/':'整理了三个要点：对账六成、退款补测、下周灰度。'})
      assembler.push({type:'finish',reason:{kind:truncated?'max-tokens':'stop'}})
      try{return{ok:true,text:preparationText(assembler,call.requireComplete)}}
      catch(error){return{ok:false,problem:String(error)}}
    }})
  t.after(()=>{
    followups.close()
    const resolved=fs.realpathSync(dir),parent=fs.realpathSync(os.tmpdir())
    assert.equal(path.dirname(resolved).toLowerCase(),parent.toLowerCase())
    assert.ok(path.basename(resolved).startsWith('viva-prepare-complete-'))
    fs.rmSync(resolved,{recursive:true,force:true})
  })
  const item=followups.store.add({title:'材料要点',ask:'整理材料中的三条进度',origin:{kind:'manual'},prepareBy:Date.now()+86400000})
  followups.scheduler.prepareNow(item.id)
  for(let i=0;i<3;i++)await new Promise<void>(resolve=>setImmediate(resolve))
  assert.equal(calls.length,1,'no immediate hidden retry')
  assert.equal(calls[0].requireComplete,true)
  assert.equal(calls[0].maxTokens,8192)
  assert.equal(followups.store.get(item.id)?.status,'scheduled')
  assert.equal(followups.store.get(item.id)?.draft,null,'a partial sentence is never delivered as ready')
  truncated=false
  followups.scheduler.prepareNow(item.id)
  for(let i=0;i<3;i++)await new Promise<void>(resolve=>setImmediate(resolve))
  assert.equal(calls.length,2)
  assert.equal(followups.store.get(item.id)?.status,'ready')
  assert.match(followups.store.get(item.id)?.draft??'',/对账六成、退款补测、下周灰度/)
  assert.equal(followups.store.countEvents('prepare_call',0),2,'both attempts count toward the daily budget')
  assert.deepEqual(errors,[])
})

test('the app and plugin retain the bounded preparation budget across their IPC contract',()=>{
  const base={type:'prepare',id:'draft-1',provider:'deepseek',model:'deepseek-flash',system:'prepare',input:'synthetic',requireComplete:true}
  assert.equal(MAX_TOKENS,8192)
  assert.equal(PREPARE_MAX_TOKENS,MAX_TOKENS)
  assert.equal(prepareRequest({...base,maxTokens:PREPARE_MAX_TOKENS})?.maxTokens,PREPARE_MAX_TOKENS)
  assert.equal(prepareRequest({...base,maxTokens:Number.MAX_SAFE_INTEGER})?.maxTokens,MAX_TOKENS)
})
