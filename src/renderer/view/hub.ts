import { hubPage } from '../hub-state.ts'
import type { Dom } from '../page-elements.ts'

/**
 * 搜索 · 关于你 · 设置, one page over the conversation under the title bar. The sidebar and the pages are
 * static markup (index.html); this shows the open one and marks it in the sidebar. Each page renders itself.
 */
export function renderHub(dom: Dom, state: State) {
  const page = hubPage(state)
  dom.hub.dataset.open = String(Boolean(page))
  // 动态 is a page of its own (system-design §12.2): no hub sidebar beside it.
  dom.hub.dataset.page = page ?? ''
  dom.openProfile.setAttribute('aria-pressed', String(Boolean(page) && page !== 'feed'))
  dom.openFeed.setAttribute('aria-pressed', String(page === 'feed'))
  for (const nav of dom.hubNavs) {
    if (nav.dataset.page === page) nav.setAttribute('aria-current', 'page')
    else nav.removeAttribute('aria-current')
  }
  for (const section of dom.hubPages) section.hidden = section.dataset.page !== page
}
