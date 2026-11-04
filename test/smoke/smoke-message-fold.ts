import { report, run, type SmokeWindow } from './smoke-kit.ts'

/**
 * Long messages fold (view/message-fold.ts), in the real renderer: a tall user message and a tall earlier answer show
 * their start and 展开; the latest answer and short messages stay whole; 展开 / 收起 open and fold again.
 */
export async function checkMessageFold(win: SmokeWindow): Promise<string[]> {
  const seen = await run(win, `(async () => {
    const { initialState, reduce } = await import('./state.js')
    const { renderThread } = await import('./view/thread.js')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px'
    document.body.append(host)
    const long = (word) => Array.from({ length: 60 }, (_, i) => word + ' ' + i).join('\\n\\n')
    const handlers = new Proxy({}, { get: () => () => {} })
    try {
      const state = reduce(initialState, { type: 'history_loaded', conversationId: 'fold-fixture', savedAt: 1, messages: [
        { role: 'user', text: long('很长的问题') }, { role: 'assistant', text: long('很长的回答') },
        { role: 'user', text: '短问题' }, { role: 'assistant', text: long('最新的回答') },
      ] })
      renderThread(host, state, handlers, Date.now())
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      const folds = [...host.querySelectorAll('.msg-fold')].map((el) => ({ folded: el.dataset.folded ?? null, text: el.textContent.slice(0, 6), height: Math.round(el.getBoundingClientRect().height) }))
      const toggle = host.querySelector('.msg-fold-toggle')
      toggle?.click()
      const opened = toggle?.getAttribute('aria-expanded') === 'true' && toggle.previousElementSibling?.dataset.folded === 'false'
      toggle?.click()
      const again = toggle?.previousElementSibling?.dataset.folded === 'true'
      return { folds, toggles: host.querySelectorAll('.msg-fold-toggle').length, opened, again }
    } finally { host.remove() }
  })()`) as { folds: Array<{ folded: string | null, text: string, height: number }>, toggles: number, opened: boolean, again: boolean }
  report(`message fold: ${JSON.stringify(seen)}`)
  const problems: string[] = []
  const byStart = (start: string) => seen.folds.find((fold) => fold.text.startsWith(start))
  if (byStart('很长的问题')?.folded !== 'true' || byStart('很长的回答')?.folded !== 'true') problems.push(`a long user message and a long earlier answer should fold: ${JSON.stringify(seen.folds)}`)
  if (byStart('短问题')?.folded === 'true') problems.push('a short message should not fold')
  if (seen.folds.some((fold) => fold.text.startsWith('最新的回答') && fold.folded === 'true')) problems.push('the latest answer should stay whole')
  if (seen.toggles !== 2 || !seen.opened || !seen.again) problems.push(`展开 / 收起 should open and fold again: ${JSON.stringify(seen)}`)
  return problems
}
