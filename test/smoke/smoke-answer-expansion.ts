import { expect as assert, type Page } from '@playwright/test'
import { report, run, type Expect, type SmokeWindow } from './smoke-kit.ts'

/** Actual Markdown and ResizeObserver: revealing a finished answer must keep the reader's place. */
export const ANSWER_EXPANSION = `(async()=>{
  const {initialState,reduce}=await import('./state.js')
  const {renderThread}=await import('./view/thread.js')
  const {createScrollFollower}=await import('./view/scroll-follow.js')
  const frame=()=>new Promise(requestAnimationFrame),settle=async()=>{await frame();await frame();await frame()}
  const fence=String.fromCharCode(96).repeat(3)
  const text=Array.from({length:100},(_,i)=>['### 第 '+(i+1)+' 节','','保留完整代码和表格，展开后从原来的位置继续阅读。'.repeat(27),'',fence+'ts','export const step'+i+' = (value: number) => value + '+i,fence,'','| 项目 | 负责人 |','| --- | --- |','| 校验 | 小林 |',''].join('\\n')).join('\\n')
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
    const begin=performance.now();button.click()
    const clickMs=performance.now()-begin,busyShown=markdown.getAttribute('aria-busy')==='true'
    let prior=performance.now(),maxFrameMs=0
    for(let i=0;i<180&&button.isConnected;i++){
      await frame()
      const at=performance.now();maxFrameMs=Math.max(maxFrameMs,at-prior);prior=at
    }
    const revealMs=performance.now()-begin;await settle()
    const after=pane.scrollTop,shift=anchor?.isConnected?Math.abs(anchor.getBoundingClientRect().top-anchorTop):null
    const revealed=markdown.querySelectorAll('table').length===100&&!markdown.querySelector('.answer-more')
    const followsAfterExpand=follower.isFollowing(),jumpOffered=!jump.hidden
    const settled=state
    state={...state,phase:'error',error:'连接中断'}
    renderThread(thread,state,handlers,2);await settle()
    const during=thread.querySelector('.msg-agent'),errorKept=during===answer&&during?.querySelector('.markdown')===markdown
    const stillExpanded=during?.querySelectorAll('table').length===100&&!during?.querySelector('.answer-more')
    const errorShown=Boolean(thread.querySelector('.msg-error'))
    state=settled
    renderThread(thread,state,handlers,3);await settle()
    const restored=thread.querySelector('.msg-agent')
    const settledKept=restored===answer&&restored?.querySelector('.markdown')===markdown
    const errorCleared=!thread.querySelector('.msg-error')
    follower.jumpToLatest();await settle()
    return{clickMs,busyShown,maxFrameMs,revealMs,before,after,offsetShift:Math.abs(after-before),anchorShift:shift,revealed,followsAfterExpand,jumpOffered,errorKept,stillExpanded,errorShown,settledKept,errorCleared,jumpStillWorks:Math.abs(pane.scrollHeight-pane.scrollTop-pane.clientHeight)<=1&&follower.isFollowing()}
  }finally{observer.disconnect();pane.remove();jump.remove()}
})()`

interface ExpansionProbe {clickMs:number,busyShown:boolean,maxFrameMs:number,revealMs:number,before:number,after:number,offsetShift:number,anchorShift:number|null,revealed:boolean,followsAfterExpand:boolean,jumpOffered:boolean,errorKept:boolean,stillExpanded:boolean,errorShown:boolean,settledKept:boolean,errorCleared:boolean,jumpStillWorks:boolean}
export async function checkAnswerExpansion(win: SmokeWindow, expect: Expect): Promise<void> {
  const seen=await run(win,ANSWER_EXPANSION) as ExpansionProbe
  report(`answer expansion: ${JSON.stringify(seen)}`)
  expect(seen.busyShown && seen.clickMs < 50 && seen.revealMs < 2500,
    'expanding a 200 KB answer yields immediately and finishes drawing', seen)
  expect(seen.revealed&&seen.offsetShift<=2&&seen.anchorShift!==null&&seen.anchorShift<=2&&!seen.followsAfterExpand&&seen.jumpOffered&&seen.jumpStillWorks,
    'expanding at the preview bottom preserves the reading position and leaves the jump button working',seen)
  expect(seen.errorKept&&seen.stillExpanded&&seen.errorShown&&seen.settledKept&&seen.errorCleared,
    'an error updates its notice without replacing or folding the expanded answer',seen)

  for (const kind of ['list', 'table'] as const) {
    const large = await run(win, largeBlockProbe(kind)) as LargeBlockProbe
    report(`answer expansion ${kind}: ${JSON.stringify(large)}`)
    expect(large.completed && large.kept && large.drawnAcrossFrames,
      `a single large ${kind} retains its preview and draws across frames`, large)
    // Full accessibility updates add occasional longer frames at this scale. Also gate sustained frame pacing.
    if (process.platform === 'darwin') expect(large.frameGapMs < 100 && large.frameP95Ms < 50,
      `a large ${kind} stays within its frame budgets with accessibility enabled`, large)
  }
}

interface LargeBlockProbe { completed: boolean, kept: boolean, drawnAcrossFrames: boolean, frameGapMs: number, frameP95Ms: number }

function largeBlockProbe(kind: 'list' | 'table') {
  const count = 7_000
  const content = kind === 'list'
    ? Array.from({ length: count }, (_, i) => `- Entry ${i} with a [label](https://example.com/${i}) and some text`).join('\n')
    : `| First | Second |\n| :-- | --: |\n${Array.from({ length: count }, (_, i) => `| Row ${i} | Test value ${i} with some text |`).join('\n')}`
  const selector = kind === 'list' ? 'ul > li' : 'tbody > tr'
  return `(async () => {
    const {renderMarkdown, revealMarkdown} = await import('./view/markdown.js')
    const {answerStart} = await import('./long-answer.js')
    const text = ${JSON.stringify(content)}, selector = ${JSON.stringify(selector)}, options = {openLink() {}}
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:50px 20px 20px;background:var(--bg);z-index:99999;overflow:auto'
    const markdown = renderMarkdown(answerStart(text), options), first = markdown.querySelector(selector)
    const button = document.createElement('button')
    markdown.append(button); host.append(markdown); document.body.append(host)
    const frame = () => new Promise(requestAnimationFrame)
    try {
      await frame(); await frame()
      const preview = markdown.querySelectorAll(selector).length
      const gaps = []
      let prior = performance.now(), drawnAcrossFrames = false, finished = false
      const work = revealMarkdown(markdown, button, text, options.openLink, 350).then(() => finished = true)
      for (let i = 0; i < 180 && !finished; ++i) {
        await frame()
        const now = performance.now()
        gaps.push(now - prior); prior = now
        const count = markdown.querySelectorAll(selector).length
        if (count > preview && count < ${count}) drawnAcrossFrames = true
      }
      await work; await frame()
      gaps.push(performance.now() - prior); gaps.sort((a, b) => a - b)
      return { completed: !button.isConnected && markdown.querySelectorAll(selector).length === ${count}, kept: first === markdown.querySelector(selector),
        drawnAcrossFrames, frameGapMs: gaps.at(-1), frameP95Ms: gaps[Math.floor((gaps.length - 1) * .95)] }
    } finally { host.remove() }
  })()`
}

/** Exercise focus and Worker failure in Electron, independently of the frame timings. */
export async function checkExpansionInteractions(page: Page) {
  const host = page.locator('#expansion-focus-fixture')
  try {
    const scroll = await page.evaluate(`(async () => {
      const {renderMarkdown, revealMarkdown} = await import('./view/markdown.js')
      const prefix = '[Earlier link](https://example.com/earlier)\\n\\n' + '[x][later]\\n\\n'.repeat(1900) + 'End of preview'
      const full = prefix + '\\n\\n[New link](https://example.com/new)\\n\\n[later]: https://example.com/reference'
      const host = document.createElement('div'); host.id = 'expansion-focus-fixture'
      host.style.cssText = 'position:fixed;inset:50px 20px 20px;background:var(--bg);z-index:99999;overflow:auto'
      const openLink = () => {}, target = renderMarkdown(prefix, {openLink}), button = document.createElement('button')
      button.textContent = 'Expand'; target.append(button); host.append(target); document.body.append(host)
      const frame = () => new Promise(requestAnimationFrame)
      await frame(); host.scrollTop = host.scrollHeight; button.focus({preventScroll:true}); await frame()
      const before = host.scrollTop
      let lowest = before, done = false
      const draw = revealMarkdown(target, button, full, openLink, 1).then(() => done = true)
      while (!done) { await frame(); lowest = Math.min(lowest, host.scrollTop) }
      await draw; await frame()
      return { before, lowest, after: host.scrollTop, newFocus: document.activeElement?.textContent }
    })()`) as { before: number, lowest: number, after: number, newFocus: string }
    assert(scroll.before - scroll.lowest, 'late definitions should never contract the preview mid-reveal').toBeLessThanOrEqual(2)
    assert(Math.abs(scroll.after - scroll.before), 'late definitions should preserve the reading position').toBeLessThanOrEqual(2)
    assert(scroll.newFocus, 'keyboard focus should transfer to the start of the newly revealed content').toBe('New link')
    await page.keyboard.press('Tab')
    await assert(host.locator('a[href="https://example.com/new"]')).toBeFocused()

    const split = await page.evaluate(`(async () => {
      const {renderMarkdown, revealMarkdown} = await import('./view/markdown.js')
      const host = document.getElementById('expansion-focus-fixture')
      const prefix = '[Readable label][later] '.repeat(650) + '[Explicit link](https://example.com/explicit)', openLink = () => {}
      const full = prefix + '\\n\\n' + 'Full answer continues. '.repeat(44) + '\\n\\n[later]: https://example.com/reference'
      const target = renderMarkdown(prefix, {openLink}), button = document.createElement('button')
      const explicit = target.querySelector('a'), references = 'a[href="https://example.com/reference"]'
      target.append(button); host.replaceChildren(target)
      const frame = () => new Promise(requestAnimationFrame)
      await frame(); host.scrollTop = host.scrollHeight; await frame()
      const before = host.scrollTop
      let lowest = before, done = false, partial = false
      const draw = revealMarkdown(target, button, full, openLink, 1).then(() => done = true)
      while (!done) {
        await frame()
        lowest = Math.min(lowest, host.scrollTop)
        const links = target.querySelectorAll(references).length
        if (links && links < 650) partial = true
      }
      await draw; await frame()
      return {before, lowest, after: host.scrollTop, partial, links: target.querySelectorAll(references).length,
        retained: explicit === target.querySelector('a[href="https://example.com/explicit"]')}
    })()`) as { before: number, lowest: number, after: number, partial: boolean, links: number, retained: boolean }
    assert(split.links).toBe(650)
    assert(split.retained, 'the explicit link after the converted preview text should keep its DOM node').toBe(true)
    assert(split.partial, 'the text to link conversion should preserve the existing paragraph until its replacement is ready').toBe(false)
    assert(Math.min(split.before, split.after) - split.lowest, 'a single paragraph should never collapse partway through its replacement').toBeLessThanOrEqual(2)

    const paragraphFocused = await page.evaluate(`(async () => {
      const {renderMarkdown, revealMarkdown} = await import('./view/markdown.js')
      const host = document.getElementById('expansion-focus-fixture')
      const prefix = 'One long paragraph. '.repeat(900), openLink = () => {}
      const target = renderMarkdown(prefix, {openLink}), button = document.createElement('button')
      target.append(button); host.replaceChildren(target); button.focus()
      await revealMarkdown(target, button, prefix + 'The end.', openLink, 1)
      return document.activeElement === target.firstElementChild && !button.isConnected
    })()`)
    assert(paragraphFocused, 'an answer that only extends a paragraph should keep keyboard focus').toBe(true)
  } finally { await host.evaluateAll(nodes => nodes.forEach(node => node.remove())) }

  const outcome = await page.evaluate(`(async () => {
    const {renderMarkdown, revealMarkdown} = await import('./view/markdown.js')
    const host = document.createElement('div'); host.hidden = true; document.body.append(host)
    const NativeWorker = window.Worker, nativeTimeout = window.setTimeout
    let stopped = 0, timeouts = 0
    class StalledWorker extends NativeWorker {
      postMessage() {}
      terminate() { ++stopped; super.terminate() }
    }
    const prefix = 'Preview', full = 'Preview\\n\\nFull text', openLink = () => {}
    function answer() {
      const target = renderMarkdown(prefix, {openLink}), button = document.createElement('button')
      target.append(button); host.append(target)
      return {target, button, draw: () => revealMarkdown(target, button, full, openLink, 1)}
    }
    window.Worker = StalledWorker
    window.setTimeout = (callback, ms, ...args) => nativeTimeout(ms === 10_000 ? () => { ++timeouts; callback(...args) } : callback, ms === 10_000 ? 25 : ms, ...args)
    try {
      const cancelled = answer(), cancelledWork = cancelled.draw()
      cancelled.target.remove(); await cancelledWork
      const detached = stopped === 1 && timeouts === 0 && !cancelled.target.hasAttribute('aria-busy') && !cancelled.button.dataset.expandFailed
      const retry = answer(), preview = retry.target.firstChild
      await retry.draw()
      const failed = stopped === 2 && timeouts === 1 && retry.button.dataset.expandFailed === 'true' && !retry.target.hasAttribute('aria-busy')
        && retry.button.isConnected && retry.target.firstChild === preview && retry.target.querySelectorAll('p').length === 1
      window.Worker = NativeWorker
      await retry.draw()
      return {detached, failed, retried: !retry.button.isConnected && retry.target.firstChild === preview && retry.target.querySelectorAll('p').length === 2}
    } finally { window.Worker = NativeWorker; window.setTimeout = nativeTimeout; host.remove() }
  })()`)
  assert(outcome).toEqual({ detached: true, failed: true, retried: true })
}
