import { report, run, type SmokeWindow } from './smoke-kit.ts'

/**
 * The renderer's own nodes: her face in the title-bar island follows the done notice (done-notice-actions.ts), as
 * the desktop island does. News: done, moving; held with nobody looking: done, still; seen: at rest.
 */
const DONE_FACE = `(async () => {
  const { initialState, reduce } = await import('./state.js')
  const { renderIsland } = await import('./view/island.js')
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;left:-10000px;top:0;width:380px'
  document.body.append(container)
  const handlers = new Proxy({}, { get: () => () => {} })
  const ready = reduce(initialState, { type: 'ready', info: { mode: 'live', model: 'deepseek-chat', cwd: '/w', reason: '' } })
  const said = reduce(ready, { type: 'history_loaded', conversationId: 'done-face', savedAt: 1,
    messages: [{ role: 'user', text: '整理一下周报' }, { role: 'assistant', text: '周报整理好了。' }] })
  const read = () => {
    const maid = container.querySelector('.isl-face .maid')
    return maid ? maid.dataset.mood + (maid.querySelector('img').src.includes('-motion') ? ' moving' : ' still') : 'none'
  }
  // A new picture takes her place once decoded (maid.ts showMaid): wait for it, up to a second.
  const face = async (doneNotice, expected) => {
    renderIsland(container, { ...said, lastReceipt: { ms: 1000, tools: 0, thoughts: 0, stopReason: 'end_turn' }, doneNotice }, handlers, Date.now())
    for (let i = 0; i < 20 && read() !== expected; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    return read()
  }
  try { return { fresh: await face('fresh', 'done moving'), still: await face('still', 'done still'), seen: await face('seen', 'idle moving') } } finally { container.remove() }
})()`

/** @returns failures */
export async function checkDoneFace(win: SmokeWindow): Promise<string[]> {
  const seen = await run(win, DONE_FACE) as { fresh: string, still: string, seen: string }
  report(`done face: ${JSON.stringify(seen)}`)
  return seen.fresh === 'done moving' && seen.still === 'done still' && seen.seen === 'idle moving'
    ? [] : [`her face in the title-bar island should follow the done notice: ${JSON.stringify(seen)}`]
}
