import { dockAway, dockFolded, dockSummary, dockTasks } from '../tasks-state.ts'
import { h } from './dom.ts'
import { taskTile } from './task-card.ts'

/**
 * The background tasks in the corner of the main area, floating over its empty side: one soft panel, there only
 * while some go on or have something to show, what waits on the user first. Folded, a tag says how many go on and
 * unfolds it on a click; it never unfolds by itself. When the column presses in, the panel folds by itself: what
 * waits on the user (or failed) keeps a clear tag that says so, and with nothing such the dock steps away. Its rows
 * answer a task where it stands (允许 / 拒绝, 停下, 接着问, 详情); the cards in the conversation stay as the history.
 */
export const MAX_TILES = 3
const MINUTE_MS = 60_000

/** What the folded tag says: what needs the user first, plainly; otherwise how many go on or ended. */
export function dockTagWords(summary: ReturnType<typeof dockSummary>): string {
  const working = summary.live - summary.waiting
  const done = summary.ended - summary.failed
  if (summary.waiting || summary.failed) {
    return [
      summary.waiting ? `${summary.waiting} 件等你处理` : null,
      summary.failed ? `${summary.failed} 件出错` : null,
      working ? `${working} 在后台` : null,
    ].filter(Boolean).join(' · ')
  }
  return working ? `${working} 在后台` : `✓ ${done} 做完了`
}

function tag(state: State, handlers: Handlers): HTMLElement {
  const summary = dockSummary(state)
  // With room, unfolding is the user's choice and kept; without, a click only peeks, over the conversation.
  const unfold = state.tasks.dockRoom ? () => handlers.toggleDock(false) : () => handlers.peekDock(true)
  const words = dockTagWords(summary)
  // What needs the user stands out even folded: a failure in red, a wait in orange; the rest stays quiet.
  const tone = summary.failed ? 'error' : summary.waiting ? 'waits' : 'quiet'
  return h('button', {
    class: 'dock-tag', type: 'button', 'data-tone': tone, title: '展开后台任务', 'aria-label': `后台任务：${words}`,
    onClick: unfold,
  }, h('i', { class: 'dock-dot', 'aria-hidden': 'true' }), h('span', { text: words }), tone === 'quiet' ? null : h('span', { class: 'dock-tag-go', text: '看看 →' }))
}

/** Past the rows the dock has room for: how many more there are, a way to all of them on the 后台 page; none, null. */
export const dockMore = (count: number): string | null => (count > MAX_TILES ? `还有 ${count - MAX_TILES} 件 · 全部 →` : null)

/** What the dock shows, so a render that changes none of it leaves its buttons (and a press on one) alone. */
const rendered = new WeakMap<HTMLElement, string>()

function panel(container: HTMLElement, state: State, handlers: Handlers, now: number, shown: ReturnType<typeof dockTasks>) {
  const fold = state.tasks.dockPeek ? () => handlers.peekDock(false) : () => handlers.toggleDock(true)
  const more = dockMore(shown.length)
  const head = h('div', { class: 'dock-head' },
    h('span', { class: 'dock-title', text: `后台 · ${shown.length}` }),
    // Whatever was put away from the dock is still on the 后台 page: the way there is the last line when some are
    // cut off, here otherwise.
    more ? null : h('button', { class: 'btn btn-text dock-all', type: 'button', text: '全部 →', onClick: () => handlers.openTasks() }),
    h('button', { class: 'icon-btn dock-fold', type: 'button', 'aria-label': '收起', title: '收起', text: '–', onClick: fold }))
  // What waits on the user comes first, so it is the last to be cut off.
  container.replaceChildren(head, ...shown.slice(0, MAX_TILES).map(({ task, report }) => taskTile(task, report, handlers, now)),
    ...(more ? [h('button', { class: 'dock-more', type: 'button', text: more, onClick: () => handlers.openTasks() })] : []))
}

export function renderTaskDock(container: HTMLElement, state: State, handlers: Handlers, now = Date.now()) {
  const shown = dockTasks(state)
  const collapsed = dockFolded(state)
  const away = dockAway(state)
  const signature = JSON.stringify([collapsed, away, state.tasks.dockRoom, state.tasks.dockPeek, Math.floor(now / MINUTE_MS), shown.map(({ task, report }) =>
    [task.id, task.status, task.now, task.title, task.permission?.requestId ?? null, task.question?.requestId ?? null, report?.preview ?? null])])
  if (rendered.get(container) === signature) return
  rendered.set(container, signature)
  container.hidden = shown.length === 0 || away
  container.dataset.collapsed = String(collapsed)
  // Peeked at without room: unfolded above the input, never over it.
  container.dataset.peek = String(!collapsed && state.tasks.dockPeek)
  if (container.hidden) return container.replaceChildren()
  if (collapsed) return container.replaceChildren(tag(state, handlers))
  panel(container, state, handlers, now, shown)
}
