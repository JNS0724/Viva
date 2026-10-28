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
    return h('span', { class: 'isl-bg isl-bg-ready', title: `准备好 ${prepare.ready} 件，等你看` },
      h('b', { text: String(prepare.ready) }), h('span', { text: '准备好' }))
  }
  if (!prepare.running || !QUIET.has(view.form)) return null
  return h('span', { class: 'isl-bg isl-bg-prep', title: '在后台准备，你一开始用就停' }, h('i', { class: 'isl-breath', 'aria-hidden': 'true' }), h('span', { text: '后台准备中' }))
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
    return h('span', { class: 'isl-bg isl-bg-waits', title: `还有 ${alsoWaiting} 件在等你` },
      h('b', { text: `+${alsoWaiting}` }), h('span', { text: '等你' }))
  }
  if (count) {
    return h('span', { class: 'isl-bg isl-bg-live', title: `${count} 件在后台`, 'aria-label': `${count} 件在后台` },
      h('i', { class: 'isl-bg-ring', 'aria-hidden': 'true' }), h('b', { text: String(count) }))
  }
  if (done) {
    return h('span', { class: 'isl-bg isl-bg-done', title: `${done} 件做完了`, 'aria-label': `${done} 件做完了` },
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
  return minutes < 1 ? '刚开始' : `${minutes} 分钟`
}

function itemLine(item: Untyped, act: IslandAct, now: number) {
  const asks = item.permission
  const doing = asks ? `想${asks.title}` : item.status === 'waiting' ? '在等你回答' : item.now ? `在${item.now}` : '在做'
  const actions = asks
    ? asks.options.map((option: { optionId: string, name: string, role: string }) => h('button', {
      type: 'button',
      class: `isl-mini ${option.role === 'primary' ? 'isl-mini-primary' : ''}`,
      text: option.name,
      onClick: () => act({ kind: 'permission', requestId: asks.requestId, optionId: option.optionId }),
    }))
    : [h('span', { class: 'isl-bg-time', text: runningFor(item.startedAt, now) }),
      h('button', { type: 'button', class: 'isl-mini', text: '停下', onClick: () => act({ kind: 'stop-task', taskId: item.id }) })]
  return h('li', { class: 'isl-bg-item', 'data-status': item.status },
    // The line opens what the task did, in the drawer.
    h('button', { type: 'button', class: 'isl-bg-mid', title: '查看过程', onClick: () => act({ kind: 'task', taskId: item.id }) },
      h('b', { text: `#${item.title}` }),
      h('span', { text: doing })),
    ...actions)
}

/** Opened: a section under the conversation's steps, one line a task, and how many are done. */
export function backgroundSection(view: IslandShown, act: IslandAct, now = Date.now()) {
  const items: Untyped[] = view.background?.items ?? []
  if (!items.length) return null
  const done = view.background.done ?? 0
  return h('section', { class: 'isl-bg-list', 'aria-label': '后台' },
    h('div', { class: 'isl-sect' }, h('span', { text: '后台 ' }), h('b', { text: String(items.length) }),
      done ? h('span', { text: ` · 做完了 ${done} 件` }) : null),
    h('ol', {}, items.map((item) => itemLine(item, act, now))))
}
