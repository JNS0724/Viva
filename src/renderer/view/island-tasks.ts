import { t } from '../../shared/i18n/translate.ts'
import { h } from './dom.ts'

/**
 * Tasks in the background on the island (island-view.js background): the island stays one, with the
 * conversation on screen in front. At its tail, a cell says how many go on in the background (a turning ring)
 * or ended unseen (✓); opened, it lists them, those that wait on the user first, to be allowed right there.
 */
/** Forms in which the conversation on screen is quiet, so the cell has room for 后台准备中. */
const QUIET = new Set(['idle', 'done'])

/**
 * With no task to speak of, the follow-ups: how many are ready (N 准备好: no ✓, which says a task is done), or,
 * the conversation quiet, that preparation goes on in the background, breathing. Tasks and the conversation come first.
 */
function prepareCell(view: IslandShown): HTMLElement | null {
  const prepare = view.prepare
  if (!prepare) return null
  if (prepare.ready) {
    return h('span', { class: 'isl-bg isl-bg-ready', title: t("background.ready.count", { p0: prepare.ready }) },
      h('b', { text: String(prepare.ready) }), h('span', { text: t("island-tasks.ready") }))
  }
  if (!prepare.running || !QUIET.has(view.form)) return null
  return h('span', { class: 'isl-bg isl-bg-prep', title: t("island-tasks.preparing.in.the.background.pauses.when.you") }, h('i', { class: 'isl-breath', 'aria-hidden': 'true' }), h('span', { text: t("island-tasks.preparing.in.background") }))
}

/**
 * The cell at the island's tail, the way to the 后台 page, in a sign and a number: when the island shows what
 * the conversation waits on and tasks wait too, that they do (+N 等你, the one with words: it needs the user);
 * else, some at work, a turning ring and how many (◌ N); else ended ones not yet seen, ✓ N (seen, they are
 * not counted, so the cell goes once all are); with no task to speak of, the follow-ups (prepareCell).
 * @returns nothing with no task and no follow-up to speak of
 */
export function tailCell(view: IslandShown): HTMLElement | null {
  const { count = 0, done = 0, alsoWaiting = 0 } = view.background ?? {}
  if (alsoWaiting) {
    return h('span', { class: 'isl-bg isl-bg-waits', title: t("island-tasks.more.waiting.for.you", { alsoWaiting: alsoWaiting }) },
      h('b', { text: `+${alsoWaiting}` }), h('span', { text: t("island-tasks.waiting.for.you") }))
  }
  if (count) {
    return h('span', { class: 'isl-bg isl-bg-live', title: t("background.running.count", { p0: count }), 'aria-label': t("background.running.count", { p0: count }) },
      h('i', { class: 'isl-bg-ring', 'aria-hidden': 'true' }), h('b', { text: String(count) }))
  }
  if (done) {
    return h('span', { class: 'isl-bg isl-bg-done', title: t("background.completed.count", { p0: done }), 'aria-label': t("background.completed.count", { p0: done }) },
      h('b', { text: `✓ ${done}` }))
  }
  return prepareCell(view)
}

/** Whose request it is, when a task in the background asks. */
export const taskTag = (view: IslandShown) => (view.task ? h('span', { class: 'isl-task', text: `#${view.task}` }) : null)

const MINUTE_MS = 60_000
/** How long it has gone on, in minutes: the panel is not redrawn every second, so no seconds to go stale. */
const runningFor = (startedAt: number | undefined, now: number) => {
  const minutes = Math.floor((now - (startedAt ?? now)) / MINUTE_MS)
  return minutes < 1 ? t("island-tasks.just.started") : t("island-tasks.minutes", { minutes: minutes })
}

function itemLine(item: Untyped, act: IslandAct, now: number) {
  const asks = item.permission
  const doing = asks ? t("island-tasks.wants.to", { title: asks.title }) : item.status === 'waiting' ? t("island-tasks.waiting.for.your.answer") : item.now ? t("island-tasks.currently", { now: item.now }) : t("island-tasks.working")
  const actions = asks
    ? asks.options.map((option: { optionId: string, name: string, role: string }) => h('button', {
      type: 'button',
      class: `isl-mini ${option.role === 'primary' ? 'isl-mini-primary' : ''}`,
      text: option.name,
      onClick: () => act({ kind: 'permission', requestId: asks.requestId, optionId: option.optionId }),
    }))
    : [h('span', { class: 'isl-bg-time', text: runningFor(item.startedAt, now) }),
      h('button', { type: 'button', class: 'isl-mini', text: t("island-tasks.stop"), onClick: () => act({ kind: 'stop-task', taskId: item.id }) })]
  return h('li', { class: 'isl-bg-item', 'data-status': item.status },
    // The line opens what the task did, in the drawer.
    h('button', { type: 'button', class: 'isl-bg-mid', title: t("island-tasks.view.activity"), onClick: () => act({ kind: 'task', taskId: item.id }) },
      h('b', { text: `#${item.title}` }),
      h('span', { text: doing })),
    ...actions)
}

/** Opened: a section under the conversation's steps, one line a task, and how many are done. */
export function backgroundSection(view: IslandShown, act: IslandAct, now = Date.now()) {
  const items: Untyped[] = view.background?.items ?? []
  if (!items.length) return null
  const done = view.background.done ?? 0
  return h('section', { class: 'isl-bg-list', 'aria-label': t("island-tasks.background") },
    h('div', { class: 'isl-sect' }, h('span', { text: t("island-tasks.background.2") }), h('b', { text: String(items.length) }),
      done ? h('span', { text: t("island-tasks.done.2", { done: done }) }) : null),
    h('ol', {}, items.map((item) => itemLine(item, act, now))))
}
