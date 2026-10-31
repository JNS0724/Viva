import type { SmokeAppWindow } from './smoke-kit.ts'
import { capture, report, run, wait, UI_WAIT_MS } from './smoke-kit.ts'

/** Hover and persistent stars must remain reachable without making the timeline scroll sideways. */
export async function checkStarLayouts(win: SmokeAppWindow, outDir: string): Promise<string[]> {
  const size = (await win.getSize()), zoom = (await win.webContents.getZoomFactor())
  const failures: string[] = []
  try {
    await run(win, `(async()=>{
      const {h}=await import('./view/dom.js'),{attachStars}=await import('./view/star-buttons.js')
      // Keep synthetic star identities outside the application's real star observer. The same production
      // stylesheet is loaded inside the shadow tree; the actual scrollport still owns its surrounding lane.
      const host=h('div',{id:'smoke-star-layout'});host.style.display='contents'
      const shadow=host.attachShadow({mode:'open'}),sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href=new URL('./styles.css',location.href).href
      document.getElementById('scroll').append(host)
      const loaded=new Promise((resolve,reject)=>{sheet.onload=resolve;sheet.onerror=()=>reject(new Error('Star fixture stylesheet did not load'))});shadow.append(sheet);await loaded
      const fixture=h('div',{class:'thread'});shadow.append(fixture)
      fixture.append(
        h('div',{class:'msg-agent','data-msg':'star-assistant'},h('span',{class:'cat-avatar'}),h('div',{class:'msg-body'},h('p',{class:'msg-text',text:'助手消息的完整正文，收藏按钮应在右侧独立空间。'}))),
        h('div',{class:'msg-user-row','data-msg':'star-user-row'},h('div',{class:'msg-user',text:'当前话题用户消息'})),
        h('div',{class:'msg-user','data-msg':'star-past-user',text:'旧话题用户消息'}))
      const starred=new Set(),controller=attachStars(fixture,{placeOf:el=>({segmentId:'smoke-stars',seq:[...fixture.children].indexOf(el)}),isStarred:place=>starred.has(place.seq),toggle:(place,on)=>{if(on)starred.add(place.seq);else starred.delete(place.seq);controller.sync()}})
      for(const row of fixture.children)row.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))
      for(const button of fixture.querySelectorAll('.star-btn'))button.click()
      return true
    })()`)
    for (const [width, height, factor] of [[1360, 860, 1], [880, 640, 1], [880, 640, 1.5]]) {
      await win.setSize(width, height)
      await win.webContents.setZoomFactor(factor)
      await wait(UI_WAIT_MS)
      const seen = await run(win, `(()=>{
        const pane=document.getElementById('scroll'),fixture=document.getElementById('smoke-star-layout').shadowRoot,bounds=pane.getBoundingClientRect()
        // At fractional zoom innerWidth can truncate a CSS pixel while scrollWidth rounds it. Compare
        // the same layout viewport's rounded width so that a DPI rounding difference is not overflow.
        return {width:Math.ceil(document.documentElement.getBoundingClientRect().width),pane:pane.clientWidth,scroll:pane.scrollWidth,body:document.body.scrollWidth,buttons:[...fixture.querySelectorAll('.star-btn')].map(button=>{const r=button.getBoundingClientRect();return{left:r.left,right:r.right,inPane:r.left>=bounds.left&&r.right<=bounds.right,pressed:button.getAttribute('aria-pressed'),label:button.getAttribute('aria-label')}})}
      })()`) as { width: number, pane: number, scroll: number, body: number, buttons: Array<{ inPane: boolean, pressed: string, label: string }> }
      if (seen.scroll > seen.pane || seen.body > seen.width || seen.buttons.length !== 3 || seen.buttons.some(button => !button.inPane || button.pressed !== 'true' || button.label !== '取消收藏')) failures.push(`star layout ${width}x${height} zoom ${factor}: ${JSON.stringify(seen)}`)
      report(`star layout ${width}x${height} zoom ${factor}: ${JSON.stringify(seen)}`)
      if (factor === 1.5) {
        await run(win, `document.getElementById('smoke-star-layout').shadowRoot.querySelector('.thread').scrollIntoView({block:'start'});true`)
        await wait(UI_WAIT_MS)
        await capture(win, outDir, 'stars-minimum-150')
      }
    }
  } finally {
    await run(win, `document.getElementById('smoke-star-layout')?.remove();true`)
    await win.webContents.setZoomFactor(zoom)
    await win.setSize(size[0], size[1])
    await wait(UI_WAIT_MS)
  }
  return failures
}
