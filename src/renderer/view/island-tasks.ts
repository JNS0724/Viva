import { t } from '../../shared/i18n/translate.ts'
import { h } from './dom.ts'
import { localeRevision } from '../../shared/i18n/locale.ts'
import type { IslandView } from '../island-view.ts'
import { reconcileChildren } from './reconcile.ts'

type IslandTask = NonNullable<IslandView['background']>['items'][number]

/**
 * Tasks going on in the background on the island (island-view.js background): the island stays one, with the
 * conversation on screen in front. At its tail, a cell says how many go on in the background (a turning ring);
 * opened, it lists them, those that wait on the user first, to be allowed right there. Ended ones are not here:
 * the conversation tells their results.
 */
/**
 * The cell at the island's tail, the way to the 后台 page, in a sign and a number: when the island shows what
 * the conversation waits on and tasks wait too, that they do (+N 等你, the one with words: it needs the user);
 * else, some at work, a turning ring and how many (◌ N).
 * @returns nothing with no task and no follow-up to speak of
 */
export function createTailCell(interactive = false) {
  const el = h(interactive ? 'button' : 'span', interactive ? { type: 'button' } : {})
  let signature = ''
  function update(view: IslandShown): HTMLElement | null {
    const { count = 0, alsoWaiting = 0 } = view.background ?? {}
    if (!count && !alsoWaiting) return null
    const next = JSON.stringify([count, alsoWaiting, localeRevision()])
    if (next === signature) return el
    signature = next
    const label = alsoWaiting ? t('island-tasks.more.waiting.for.you', { alsoWaiting }) : t('background.running.count', { p0: count })
    el.title = label
    el.setAttribute('aria-label', label)
    el.className = `isl-bg ${alsoWaiting ? 'isl-bg-waits' : 'isl-bg-live'}`
    el.replaceChildren(...(alsoWaiting
      ? [h('b', { text: `+${alsoWaiting}` }), h('span', { text: t('island-tasks.waiting.for.you') })]
      : [h('i', { class: 'isl-bg-ring', 'aria-hidden': 'true' }), h('b', { text: String(count) })]))
    return el
  }
  return { el, update }
}

/** Whose request it is, when a task in the background asks. */
export const taskTag = (view: IslandShown) => (view.task ? h('span', { class: 'isl-task', text: `#${view.task}` }) : null)

const MINUTE_MS = 60_000
/** How long it has gone on, in minutes: the panel is not redrawn every second, so no seconds to go stale. */
const runningFor = (startedAt: number | undefined, now: number) => {
  const minutes = Math.floor((now - (startedAt ?? now)) / MINUTE_MS)
  return minutes < 1 ? t("island-tasks.just.started") : t("island-tasks.minutes", { minutes: minutes })
}

/** desk: on the desktop card, a task is named as it is (no #) and stopping it is a quiet text button. */
function createItemLine(id: string, act: IslandAct, desk: boolean) {
  const title = h('b'), detail = h('span'), time = h('span', { class: 'isl-bg-time' })
  const open = h('button', { type: 'button', class: 'isl-bg-mid', onClick: () => act({ kind: 'task', taskId: id }) }, title, detail)
  const stop = h('button', { type: 'button', class: desk ? 'isl-mini isl-mini-text' : 'isl-mini', onClick: () => act({ kind: 'stop-task', taskId: id }) })
  const el = h('li', { class: 'isl-bg-item' }, open)
  let signature = '', actions: HTMLElement[] = []
  function update(item: IslandTask, now: number) {
    el.dataset.status = item.status
    const name = desk ? item.title : `#${item.title}`
    if (title.textContent !== name) title.textContent = name
    const asks = item.permission
    const doing = asks ? t('island-tasks.wants.to', { title: asks.title }) : item.status === 'waiting' ? t('island-tasks.waiting.for.your.answer')
      : item.now ? t('island-tasks.currently', { now: item.now }) : t('island-tasks.working')
    if (detail.textContent !== doing) detail.textContent = doing
    open.title = t('island-tasks.view.activity')
    stop.textContent = t(desk ? 'desk.interaction.stop.current' : 'island-tasks.stop')
    const elapsed = runningFor(item.startedAt, now)
    if (time.textContent !== elapsed) time.textContent = elapsed
    // A request owns its option handlers. A different request receives new buttons and ids.
    const next = JSON.stringify([localeRevision(), asks?.requestId, asks?.options])
    if (signature !== next) {
      signature = next
      actions = asks ? asks.options.map(option => h('button', {
        type: 'button', class: `isl-mini ${option.role === 'primary' ? 'isl-mini-primary' : ''}`, text: option.name,
        onClick: () => act({ kind: 'permission', requestId: asks.requestId, optionId: option.optionId }),
      })) : [time, stop]
    }
    reconcileChildren(el, [open, ...actions])
  }
  return { el, update }
}

/**
 * Opened: a section under the conversation's steps, one line a task going on.
 * desk: the desktop card says how many in its head (island-desk-card.ts), so the section has no heading of its own.
 */
export function createBackgroundSection(act: IslandAct, { desk = false } = {}) {
  const label = h('span'), count = h('b')
  const head = h('div', { class: 'isl-sect' }, label, count)
  const list = h('ol')
  const el = h('section', { class: 'isl-bg-list' }, ...(desk ? [] : [head]), list)
  const rows = new Map<string, ReturnType<typeof createItemLine>>()
  function update(view: IslandShown, now: number): HTMLElement | null {
    const items: readonly IslandTask[] = view.background?.items ?? []
    const present = new Set(items.map(item => item.id))
    for (const id of rows.keys()) if (!present.has(id)) rows.delete(id)
    if (!items.length) { reconcileChildren(list, []); return null }
    el.setAttribute('aria-label', t('island-tasks.background'))
    label.textContent = t('island-tasks.background.2')
    count.textContent = String(items.length)
    reconcileChildren(list, items.map(item => {
      let row = rows.get(item.id)
      if (!row) { row = createItemLine(item.id, act, desk); rows.set(item.id, row) }
      row.update(item, now)
      return row.el
    }))
    return el
  }
  return { update }
}
