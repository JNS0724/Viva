import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { feedGroups, feedLine, feedShown, NEW_SOURCE_ID, type FeedItemView, type FeedSourceView, type ScheduleView } from '../feed-state.ts'
import { h, keepingInput } from './dom.ts'
import { whenText } from './proposal-card.ts'
import { maidFor } from './maid.ts'
import type { MaidSlots } from './maid.ts'
import { renderMarkdown } from './markdown.ts'
import { newSourceDetail, sourceDetail, sourceFreqText } from './feed-source-panel.ts'

/**
 * 动态 (system-design §12.2): what the app brings on its own, its own page, opened from the title bar. Her line and
 * picture at its head, then what is new, plugin data sources, what comes next (the schedules) and what was seen; the
 * one picked on the right. An item can go into the conversation or be let go; a data source binds a dsh plugin to an
 * explicit schedule and a natural-language rule; a schedule can be paused, resumed or deleted. Nothing here becomes a
 * background task (后台 is apart).
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

const sourceStanding = (source: FeedSourceView, now: number) => {
  if (source.lastStatus === 'plugin_unavailable') return t('feed.source.status.plugin.unavailable')
  if (source.status === 'paused') return t('feed.source.status.paused')
  return `${sourceFreqText(source.schedule)} · ${t('feed.schedule.next.at', { when: whenText(Date.parse(source.nextAt), now) })}`
}

interface Row { kind: 'item' | 'schedule' | 'source', id: string, title: string, meta: string, status: string, tone?: 'error' }
const itemRow = (item: FeedItemView, now: number): Row => ({ kind: 'item', id: item.id, title: item.title, meta: whenText(item.createdAt, now), status: item.seenAt === null ? 'new' : 'seen' })
const scheduleRow = (schedule: ScheduleView, now: number): Row => ({ kind: 'schedule', id: schedule.id, title: schedule.title, meta: scheduleStanding(schedule, now), status: schedule.status })
const sourceRow = (source: FeedSourceView, now: number): Row => ({
  kind: 'source',
  id: source.id,
  title: source.name,
  meta: sourceStanding(source, now),
  status: source.status,
  tone: source.lastStatus === 'plugin_unavailable' ? 'error' : undefined,
})

function group(name: string, rows: readonly Row[], shown: { kind: string, id: string } | null, handlers: Handlers) {
  if (!rows.length) return []
  return [
    h('div', { class: 'tp-group' }, name, h('span', { class: 'tp-group-count', text: String(rows.length) })),
    ...rows.map((row) => h('button', {
      class: 'tp-row fu-row', type: 'button', 'data-status': row.status, 'data-tone': row.tone ?? null,
      'aria-current': shown?.kind === row.kind && shown.id === row.id ? 'page' : null,
      onClick: () => handlers.selectFeed(row.kind, row.id),
    }, h('span', { class: 'tp-name', text: row.title }), h('span', { class: 'tp-meta', text: row.meta }))),
  ]
}

function sourcesGroup(sources: readonly FeedSourceView[], shown: { kind: string, id: string } | null, handlers: Handlers, now: number) {
  const rows = sources.map((source) => sourceRow(source, now))
  return [
    h('div', { class: 'tp-group' }, t('feed.sources'), sources.length ? h('span', { class: 'tp-group-count', text: String(sources.length) }) : null),
    ...rows.map((row) => h('button', {
      class: 'tp-row fu-row', type: 'button', 'data-status': row.status, 'data-tone': row.tone ?? null,
      'aria-current': shown?.kind === 'source' && shown.id === row.id ? 'page' : null,
      onClick: () => handlers.selectFeed('source', row.id),
    }, h('span', { class: 'tp-name', text: row.title }), h('span', { class: 'tp-meta', text: row.meta }))),
    h('button', {
      class: 'tp-row fu-row fs-add', type: 'button',
      'aria-current': shown?.kind === 'new-source' && shown.id === NEW_SOURCE_ID ? 'page' : null,
      onClick: () => handlers.openNewFeedSource(),
    }, h('span', { class: 'tp-name', text: t('feed.source.add') })),
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
  const { fresh, sources, next, seen } = feedGroups(state)
  const shown = feedShown(state)
  const picked = shown?.kind === 'item' ? { kind: 'item', id: shown.item.id }
    : shown?.kind === 'source' ? { kind: 'source', id: shown.source.id }
      : shown?.kind === 'new-source' ? { kind: 'new-source', id: NEW_SOURCE_ID }
        : shown?.kind === 'schedule' ? { kind: 'schedule', id: shown.schedule.id }
          : null

  const side = h('nav', { class: 'tp-side feed-side', 'aria-label': t('feed.title') },
    h('div', { class: 'tp-side-head' },
      h('h1', { class: 'feed-title', text: t('feed.title') }),
      h('button', { class: 'btn btn-text btn-small feed-close', type: 'button', onClick: () => handlers.closeHub() },
        h('span', { text: t('tasks-page.back') }), h('kbd', { text: 'Esc' }))),
    herLine(state),
    ...group(t('feed.new'), fresh.map((item) => itemRow(item, now)), picked, handlers),
    ...sourcesGroup(sources, picked, handlers, now),
    ...group(t('feed.next'), next.map((schedule) => scheduleRow(schedule, now)), picked, handlers),
    ...group(t('feed.seen'), seen.map((item) => itemRow(item, now)), picked, handlers))

  const main = shown?.kind === 'item'
    ? itemDetail(shown.item, shown.fresh, state, handlers, now)
    : shown?.kind === 'source'
      ? sourceDetail(shown.source, state, handlers, now)
      : shown?.kind === 'new-source'
        ? newSourceDetail(state, handlers)
        : shown?.kind === 'schedule'
          ? scheduleDetail(shown.schedule, state, handlers, now)
          : h('div', { class: 'tp-main feed-empty' }, h('p', { class: 'empty', text: t('feed.empty') }))

  keepingInput(container, () => container.replaceChildren(side, main))
}
