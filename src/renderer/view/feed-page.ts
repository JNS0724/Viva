import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { feedGroups, feedLine, feedShown, type FeedItemView, type ScheduleView } from '../feed-state.ts'
import { h } from './dom.ts'
import { whenText } from './proposal-card.ts'
import { maidFor } from './maid.ts'
import type { MaidSlots } from './maid.ts'
import { renderMarkdown } from './markdown.ts'

/**
 * 动态 (system-design §12.2): what the app brings on its own, its own page, opened from the title bar. Her line and
 * picture at its head, then what is new, what comes next (the schedules) and what was seen; the one picked on the
 * right. An item can go into the conversation or be let go; a schedule can be paused, resumed or deleted (or changed
 * by asking in the conversation). Nothing here becomes a background task (后台 is apart).
 */
const LINE_MAID_PX = 56
const DETAIL_MAID_PX = 64
const lineMaids: MaidSlots = new Map()
const detailMaids: MaidSlots = new Map()
let KIND_NAMES: Readonly<Record<string, string>> = kindNames()
function kindNames() {
  return { at: t('feed.schedule.at'), daily: t('feed.schedule.daily'), weekly: t('feed.schedule.weekly'), cron: t('feed.schedule.cron') }
}
onLocaleChange(() => { KIND_NAMES = kindNames() })

function herLine(state: State) {
  const { fresh, next } = feedLine(state)
  const words = fresh ? t('feed.line.new', { count: fresh }) : next ? t('feed.line.next', { count: next }) : t('feed.line.quiet')
  return h('div', { class: 'feed-her' },
    maidFor(lineMaids, 'line', fresh ? 'done' : 'idle', { size: LINE_MAID_PX }),
    h('p', { class: 'feed-say', text: words }))
}

/** When a schedule comes next, or that it is paused. */
const scheduleStanding = (schedule: ScheduleView, now: number) => (schedule.status === 'paused'
  ? t('feed.schedule.paused')
  : t('feed.schedule.next.at', { when: whenText(Date.parse(schedule.nextAt), now) }))

interface Row { kind: 'item' | 'schedule', id: string, title: string, meta: string, status: string }
const itemRow = (item: FeedItemView, now: number): Row => ({ kind: 'item', id: item.id, title: item.title, meta: whenText(item.createdAt, now), status: item.seenAt === null ? 'new' : 'seen' })
const scheduleRow = (schedule: ScheduleView, now: number): Row => ({ kind: 'schedule', id: schedule.id, title: schedule.title, meta: scheduleStanding(schedule, now), status: schedule.status })

function group(name: string, rows: readonly Row[], shown: { kind: string, id: string } | null, handlers: Handlers) {
  if (!rows.length) return []
  return [
    h('div', { class: 'tp-group' }, name, h('span', { class: 'tp-group-count', text: String(rows.length) })),
    ...rows.map((row) => h('button', {
      class: 'tp-row fu-row', type: 'button', 'data-status': row.status,
      'aria-current': shown?.kind === row.kind && shown.id === row.id ? 'page' : null,
      onClick: () => handlers.selectFeed(row.kind, row.id),
    }, h('span', { class: 'tp-name', text: row.title }), h('span', { class: 'tp-meta', text: row.meta }))),
  ]
}

const button = (kind: string, text: string, disabled: boolean, onClick: () => unknown) => h('button', { class: `btn ${kind}`, type: 'button', text, disabled, onClick })

function detail(mood: 'done' | 'idle', title: string, standing: string, ...body: Array<Node | null>) {
  return h('div', { class: 'tp-main fu-main' },
    h('header', { class: 'tp-head' },
      maidFor(detailMaids, 'detail', mood, { size: DETAIL_MAID_PX }),
      h('h2', { class: 'tp-title', text: title }),
      h('span', { class: 'tp-status', text: standing })),
    h('div', { class: 'tp-scroll fu-scroll' }, ...body))
}

/** An item: where it came from and when, what it says, and 在对话里继续 / 不用了. */
function itemDetail(item: FeedItemView, fresh: boolean, state: State, handlers: Handlers, now: number) {
  const busy = Boolean(state.feed.busy)
  return detail(fresh ? 'done' : 'idle', item.title, `${item.origin.label} · ${whenText(item.createdAt, now)}`,
    h('article', { class: 'fu-draft' }, renderMarkdown(item.body, { openLink: handlers.openLink })),
    h('div', { class: 'confirm-actions fu-actions' },
      button('btn-accent', t('feed.continue'), busy, () => handlers.continueFeedItem(item.id)),
      fresh ? button('btn-text', t('feed.no'), busy, () => handlers.dismissFeedItem(item.id)) : null),
    state.feed.error ? h('p', { class: 'form-error', role: 'alert', text: state.feed.error }) : null)
}

/** A schedule: how often, when next, the prompt it runs; pause or resume, delete. */
function scheduleDetail(schedule: ScheduleView, state: State, handlers: Handlers, now: number) {
  const busy = Boolean(state.feed.busy)
  const paused = schedule.status === 'paused'
  return detail('idle', schedule.title, `${KIND_NAMES[schedule.kind] ?? schedule.kind} · ${scheduleStanding(schedule, now)}`,
    h('p', { class: 'fu-ask', text: schedule.prompt }),
    h('p', { class: 'fu-note', text: t('feed.schedule.how') }),
    h('div', { class: 'confirm-actions fu-actions' },
      button('btn-secondary', paused ? t('feed.schedule.resume') : t('feed.schedule.pause'), busy, () => handlers.pauseSchedule(schedule.id, !paused)),
      button('btn-text', t('feed.schedule.delete'), busy, () => handlers.deleteSchedule(schedule.id))),
    state.feed.error ? h('p', { class: 'form-error', role: 'alert', text: state.feed.error }) : null)
}

export function renderFeedPage(container: HTMLElement, state: State, handlers: Handlers, now = Date.now()) {
  const { fresh, next, seen } = feedGroups(state)
  const shown = feedShown(state)
  const picked = shown?.kind === 'item' ? { kind: 'item', id: shown.item.id } : shown ? { kind: 'schedule', id: shown.schedule.id } : null
  const side = h('nav', { class: 'tp-side feed-side', 'aria-label': t('feed.title') },
    h('div', { class: 'tp-side-head' },
      h('h1', { class: 'feed-title', text: t('feed.title') }),
      h('button', { class: 'btn btn-text btn-small feed-close', type: 'button', onClick: () => handlers.closeHub() },
        h('span', { text: t('tasks-page.back') }), h('kbd', { text: 'Esc' }))),
    herLine(state),
    ...group(t('feed.new'), fresh.map((item) => itemRow(item, now)), picked, handlers),
    ...group(t('feed.next'), next.map((schedule) => scheduleRow(schedule, now)), picked, handlers),
    ...group(t('feed.seen'), seen.map((item) => itemRow(item, now)), picked, handlers))
  const main = shown?.kind === 'item'
    ? itemDetail(shown.item, shown.fresh, state, handlers, now)
    : shown ? scheduleDetail(shown.schedule, state, handlers, now)
      : h('div', { class: 'tp-main feed-empty' }, h('p', { class: 'empty', text: t('feed.empty') }))
  container.replaceChildren(side, main)
}
