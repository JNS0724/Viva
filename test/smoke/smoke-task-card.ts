import { report, run, type Expect, type SmokeWindow } from './smoke-kit.ts'

/** Exercise actual renderer nodes: background answer chunks must leave the main conversation's task line alone. */
export const TASK_CARD_RETENTION = `(async()=>{
  const {initialState,reduce}=await import('./state.js')
  const {renderThread}=await import('./view/thread.js')
  const {taskPreview}=await import('./tasks-state.js')
  const {decodeAgentEvent}=await import('./agent-event-decoder.js')
  const {createEventActions}=await import('./agent-event-actions.js')
  const active=document.activeElement,container=document.createElement('div'),calls=[]
  container.style.cssText='position:fixed;left:-10000px;top:0;width:760px;height:600px;overflow:auto'
  document.body.append(container)
  const handlers=new Proxy({}, {get:(_,name)=>(...args)=>calls.push({name,args})})
  const taskId='smoke-card-retention',map=createEventActions()
  let piece=0
  const push=(event,at=1100)=>{const decoded=decodeAgentEvent(event);if(!decoded)throw new Error('Malformed task-card fixture '+event.type);const action=map(decoded,at);if(action)state=reduce(state,action)}
  let state=reduce(initialState,{type:'history_loaded',conversationId:'card-fixture',messages:[{role:'assistant',text:'主对话保持不变'}],savedAt:1})
  // Made as the backend makes a task (task-runtime.ts): by the snapshot that begins it, its line on the conversation of this session.
  state={...state,info:{...state.info,sessionId:'card-session'}}
  push({type:'task_snapshot',snapshot:{taskId:taskId,runId:'run-1',title:'后台整理',status:'running',currentAction:null,waitingFor:null,startedAt:1000,updatedAt:1000,endedAt:null,resultPreview:'',revision:1,taskSeq:0,opening:{words:'后台整理',task:{id:taskId,segmentId:'card-task-segment',title:'后台整理',words:'后台整理'},hostSession:'card-session'}}})
  const chunk=text=>({type:'task_update',taskId,runId:'run-1',taskSeq:++piece,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}})
  // How it stands, as the backend's snapshots say it after each wait and its end (task-runtime.ts).
  const stands=(revision,fields)=>({type:'task_snapshot',snapshot:{taskId,runId:'run-1',title:'后台整理',status:'running',currentAction:null,waitingFor:null,startedAt:1000,updatedAt:1000,endedAt:null,resultPreview:'',revision,taskSeq:piece,...fields}})
  try{
    push(chunk('开始：'));renderThread(container,state,handlers,1200)
    const card=container.querySelector('.task-card'),answer=container.querySelector('.msg-agent')
    if(!card)throw new Error('No task card in renderer fixture')
    card.focus();let retained=0
    for(let i=0;i<100;i++){push(chunk(String(i)+','));renderThread(container,state,handlers,1500+i);if(container.querySelector('.task-card')===card)retained++}
    const focused=document.activeElement===card,mainKept=container.querySelector('.msg-agent')===answer
    const backgroundText=state.tasks.list[0].view.messages.at(-1).text
    card.click()
    renderThread(container,state,handlers,61000)
    const elapsed=container.querySelector('.task-card')?.textContent??''
    push({type:'permission',taskId,runId:'run-1',taskSeq:++piece,requestId:'p-card',toolCall:{toolCallId:'tool-card',title:'运行校验'},options:[]},62000);push(stands(2,{status:'waiting',waitingFor:'permission'}))
    renderThread(container,state,handlers,62000)
    const waiting=container.querySelector('.task-card')?.dataset.status==='waiting'&&container.querySelector('.task-card')?.textContent.includes('运行校验')
    push({type:'permission',taskId,runId:'run-1',taskSeq:++piece,requestId:'p-card-2',toolCall:{toolCallId:'tool-card-2',title:'检查输出'},options:[]},62001);push(stands(3,{status:'waiting',waitingFor:'permission'}))
    renderThread(container,state,handlers,62001)
    const permissionChanged=container.querySelector('.task-card')?.textContent.includes('检查输出')
    push({type:'task_end',taskId,runId:'run-1',taskSeq:++piece,stopReason:'end_turn'},63000);push(stands(4,{status:'done',endedAt:63000}))
    renderThread(container,state,handlers,63000)
    const done=container.querySelector('.task-card')
    const preview=taskPreview(state.tasks.list[0].view)
    done?.click()
    return{retained,focused,mainKept,allChunksKept:backgroundText.includes('99,'),elapsed:elapsed.includes('1 分钟'),waiting,permissionChanged,done:done?.dataset.status==='done',preview:Boolean(preview)&&done?.querySelector('.task-line-text')?.textContent===preview,clicks:calls.filter(call=>call.name==='openTasks').map(call=>call.args[0])}
  }finally{container.remove();if(active instanceof HTMLElement&&active.isConnected)active.focus({preventScroll:true})}
})()`

interface CardProbe {retained:number,focused:boolean,mainKept:boolean,allChunksKept:boolean,elapsed:boolean,waiting:boolean,permissionChanged:boolean,done:boolean,preview:boolean,clicks:string[]}
export async function checkTaskCardRetention(win: SmokeWindow, expect: Expect): Promise<void> {
  const seen=await run(win,TASK_CARD_RETENTION) as CardProbe
  report(`task-card retention: ${JSON.stringify(seen)}`)
  expect(seen.retained===100&&seen.focused&&seen.mainKept&&seen.allChunksKept,
    '100 background chunks keep the unchanged task card, its focus and the main answer nodes',seen)
  expect(seen.elapsed&&seen.waiting&&seen.permissionChanged&&seen.done&&seen.preview&&seen.clicks.length===2&&seen.clicks.every(id=>id==='smoke-card-retention'),
    'retained task cards still refresh elapsed time, approvals and completion, and open the task',seen)
}
