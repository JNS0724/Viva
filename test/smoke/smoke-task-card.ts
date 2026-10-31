import { report, run, type Expect, type SmokeWindow } from './smoke-kit.ts'

/** Exercise actual renderer nodes: background answer chunks must leave the main conversation's task line alone. */
export const TASK_CARD_RETENTION = `(async()=>{
  const {initialState,reduce}=await import('./state.js')
  const {renderThread}=await import('./view/thread.js')
  const active=document.activeElement,container=document.createElement('div'),calls=[]
  container.style.cssText='position:fixed;left:-10000px;top:0;width:760px;height:600px;overflow:auto'
  document.body.append(container)
  const handlers=new Proxy({}, {get:(_,name)=>(...args)=>calls.push({name,args})})
  const taskId='smoke-card-retention'
  let state=reduce(initialState,{type:'history_loaded',conversationId:'card-fixture',messages:[{role:'assistant',text:'主对话保持不变'}],savedAt:1})
  state=reduce(state,{type:'task_started',task:{id:taskId,title:'后台整理',words:'后台整理'},text:'后台整理',at:1000})
  const chunk=text=>({type:'task_update',taskId,at:1100,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}})
  try{
    state=reduce(state,chunk('开始：'));renderThread(container,state,handlers,1200)
    const card=container.querySelector('.task-card'),answer=container.querySelector('.msg-agent')
    if(!card)throw new Error('No task card in renderer fixture')
    card.focus();let retained=0
    for(let i=0;i<100;i++){state=reduce(state,chunk(String(i)+','));renderThread(container,state,handlers,1500+i);if(container.querySelector('.task-card')===card)retained++}
    const focused=document.activeElement===card,mainKept=container.querySelector('.msg-agent')===answer
    const backgroundText=state.tasks.list[0].view.messages.at(-1).text
    card.click()
    renderThread(container,state,handlers,61000)
    const elapsed=container.querySelector('.task-card')?.textContent??''
    state=reduce(state,{type:'permission_request',taskId,requestId:'p-card',toolCall:{toolCallId:'tool-card',title:'运行校验'},options:[],at:62000})
    renderThread(container,state,handlers,62000)
    const waiting=container.querySelector('.task-card')?.dataset.status==='waiting'&&container.querySelector('.task-card')?.textContent.includes('运行校验')
    state=reduce(state,{type:'permission_request',taskId,requestId:'p-card-2',toolCall:{toolCallId:'tool-card-2',title:'检查输出'},options:[],at:62001})
    renderThread(container,state,handlers,62001)
    const permissionChanged=container.querySelector('.task-card')?.textContent.includes('检查输出')
    state=reduce(state,{type:'task_end',taskId,stopReason:'end_turn',at:63000})
    state=reduce(state,{type:'task_report_shown',taskId})
    renderThread(container,state,handlers,63000)
    const done=container.querySelector('.task-card')
    const report=state.tasks.reports.find(report=>report.taskId===taskId)
    done?.click()
    return{retained,focused,mainKept,allChunksKept:backgroundText.includes('99,'),elapsed:elapsed.includes('1 分钟'),waiting,permissionChanged,done:done?.dataset.status==='done',preview:Boolean(report?.preview)&&done?.querySelector('.task-line-text')?.textContent===report.preview,clicks:calls.filter(call=>call.name==='openTasks').map(call=>call.args[0])}
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
