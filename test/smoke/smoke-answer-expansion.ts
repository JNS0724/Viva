import { report, run, type Expect, type SmokeWindow } from './smoke-kit.ts'

/** Actual Markdown and ResizeObserver: revealing a finished answer must keep the reader's place. */
export const ANSWER_EXPANSION = `(async()=>{
  const {initialState,reduce}=await import('./state.js')
  const {renderThread}=await import('./view/thread.js')
  const {createScrollFollower}=await import('./view/scroll-follow.js')
  const frame=()=>new Promise(requestAnimationFrame),settle=async()=>{await frame();await frame();await frame()}
  const fence=String.fromCharCode(96).repeat(3)
  const text=Array.from({length:100},(_,i)=>['### 第 '+(i+1)+' 节','','保留完整代码和表格，展开后从原来的位置继续阅读。'.repeat(8),'',fence+'ts','export const step'+i+' = (value: number) => value + '+i,fence,'','| 项目 | 负责人 |','| --- | --- |','| 校验 | 小林 |',''].join('\\n')).join('\\n')
  let state=reduce(initialState,{type:'history_loaded',conversationId:'expansion-fixture',messages:[{role:'assistant',text,receipt:{ms:1000,tools:0,thoughts:0,stopReason:'end_turn'}}],savedAt:1})
  const pane=document.createElement('div'),thread=document.createElement('div'),jump=document.createElement('button')
  pane.style.cssText='position:fixed;left:-10000px;top:0;width:760px;height:240px;overflow:auto;visibility:hidden'
  jump.style.cssText='position:fixed;left:-10000px;visibility:hidden'
  thread.className='thread';pane.append(thread);document.body.append(pane,jump)
  const follower=createScrollFollower(pane,jump),observer=new ResizeObserver(()=>follower.onContentResize())
  observer.observe(thread)
  const handlers=new Proxy({}, {get:()=>()=>{}})
  try{
    renderThread(thread,state,handlers,1);follower.jumpToLatest();await settle()
    const button=thread.querySelector('.answer-more'),answer=thread.querySelector('.msg-agent'),markdown=answer?.querySelector('.markdown')
    if(!button||!answer||!markdown)throw new Error('No finished long-answer preview')
    const anchor=button.previousElementSibling,before=pane.scrollTop,anchorTop=anchor?.getBoundingClientRect().top
    button.click();await settle()
    const after=pane.scrollTop,shift=anchor?.isConnected?Math.abs(anchor.getBoundingClientRect().top-anchorTop):null
    const revealed=markdown.querySelectorAll('table').length===100&&!markdown.querySelector('.answer-more')
    const followsAfterExpand=follower.isFollowing(),jumpOffered=!jump.hidden
    state=reduce(state,{type:'prepare_state',prepare:{running:true,current:null,queued:0,nextAt:null,waiting:null}})
    renderThread(thread,state,handlers,2);await settle()
    const during=thread.querySelector('.msg-agent'),preparationKept=during===answer&&during?.querySelector('.markdown')===markdown
    const stillExpanded=during?.querySelectorAll('table').length===100&&!during?.querySelector('.answer-more')
    const sleeping=Boolean(during?.querySelector('[data-mood="sleeping"]'))
    state=reduce(state,{type:'prepare_state',prepare:{running:false,current:null,queued:0,nextAt:null,waiting:null}})
    renderThread(thread,state,handlers,3);await settle()
    const restored=thread.querySelector('.msg-agent')
    const settledKept=restored===answer&&restored?.querySelector('.markdown')===markdown
    const awake=Boolean(restored?.querySelector('[data-mood="idle"],[data-mood="done"]'))
    follower.jumpToLatest();await settle()
    return{before,after,offsetShift:Math.abs(after-before),anchorShift:shift,revealed,followsAfterExpand,jumpOffered,preparationKept,stillExpanded,sleeping,settledKept,awake,jumpStillWorks:Math.abs(pane.scrollHeight-pane.scrollTop-pane.clientHeight)<=1&&follower.isFollowing()}
  }finally{observer.disconnect();pane.remove();jump.remove()}
})()`

interface ExpansionProbe {before:number,after:number,offsetShift:number,anchorShift:number|null,revealed:boolean,followsAfterExpand:boolean,jumpOffered:boolean,preparationKept:boolean,stillExpanded:boolean,sleeping:boolean,settledKept:boolean,awake:boolean,jumpStillWorks:boolean}
export async function checkAnswerExpansion(win: SmokeWindow, expect: Expect): Promise<void> {
  const seen=await run(win,ANSWER_EXPANSION) as ExpansionProbe
  report(`answer expansion: ${JSON.stringify(seen)}`)
  expect(seen.revealed&&seen.offsetShift<=2&&seen.anchorShift!==null&&seen.anchorShift<=2&&!seen.followsAfterExpand&&seen.jumpOffered&&seen.jumpStillWorks,
    'expanding at the preview bottom preserves the reading position and leaves the jump button working',seen)
  expect(seen.preparationKept&&seen.stillExpanded&&seen.sleeping&&seen.settledKept&&seen.awake,
    'background preparation updates the avatar without replacing or folding the expanded answer',seen)
}
