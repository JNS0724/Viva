import { dockFolded, dockSummary, dockTasks } from '../tasks-state.ts'
import { h } from './dom.ts'
import { taskTile } from './task-card.ts'

/**
 * The background tasks in the corner of the main area, floating over its empty side: there only while some go on
 * or have something to show, what waits on the user first. Folded, a quiet tag says how many go on (its dot orange
 * when one waits) and unfolds it on a click; it never unfolds by itself. Its cards answer a task where it stands
 * (允许 / 拒绝, 停下, 接着问, 详情 →); the cards in the conversation stay as the history.
 */
const MAX_TILES = 5
const MINUTE_MS = 60_000

function tag(state: State, handlers: Handlers): HTMLElement {
  const summary = dockSummary(state)
  // With room, unfolding is the user's choice and kept; without, a click only peeks, over the conversation.
  const unfold = state.tasks.dockRoom ? () => handlers.toggleDock(false) : () => handlers.peekDock(true)
  const words = [
    summary.live ? `${summary.live} 在后台` : null,
    summary.waiting ? `${summary.waiting} 等你` : null,
    !summary.live && summary.ended ? `✓ ${summary.ended} 做完了` : null,
  ].filter(Boolean).join(' · ')
  return h('button', {
    class: 'dock-tag', type: 'button', 'data-waits': String(summary.waiting > 0), title: '展开后台任务', 'aria-label': `后台任务：${words}`,
    onClick: unfold,
  }, h('i', { class: 'dock-dot', 'aria-hidden': 'true' }), h('span', { text: words }))
}

/** What the dock shows, so a render that changes none of it leaves its buttons (and a press on one) alone. */
const rendered = new WeakMap<HTMLElement, string>()

export function renderTaskDock(container: HTMLElement, state: State, handlers: Handlers, now = Date.now()) {
  const shown = dockTasks(state)
  const collapsed = dockFolded(state)
  const signature = JSON.stringify([collapsed, state.tasks.dockRoom, state.tasks.dockPeek, Math.floor(now / MINUTE_MS), shown.map(({ task, report }) =>
    [task.id, task.status, task.now, task.title, task.permission?.requestId ?? null, task.question?.requestId ?? null, report?.preview ?? null])])
  if (rendered.get(container) === signature) return
  rendered.set(container, signature)
  container.hidden = shown.length === 0
  container.dataset.collapsed = String(collapsed)
  if (!shown.length) return container.replaceChildren()
  if (collapsed) return container.replaceChildren(tag(state, handlers))
  const fold = state.tasks.dockPeek ? () => handlers.peekDock(false) : () => handlers.toggleDock(true)
  const head = h('div', { class: 'dock-head' },
    h('span', { class: 'dock-title', text: `后台 · ${shown.length}` }),
    shown.length > MAX_TILES ? h('button', { class: 'btn btn-text', type: 'button', text: '全部 →', onClick: () => handlers.openTasks() }) : null,
    h('button', { class: 'icon-btn dock-fold', type: 'button', 'aria-label': '收起', title: '收起', text: '–', onClick: fold }))
  container.replaceChildren(head, ...shown.slice(0, MAX_TILES).map(({ task, report }) => taskTile(task, report, handlers, now)))
}
