import { t } from '../../shared/i18n/translate.ts'
import { feedGroups, feedLine, feedShown } from '../feed-state.ts'
import { h } from './dom.ts'
import { followupDetail, followupStanding, whenText } from './followups.ts'
import { maidFor } from './maid.ts'
import type { MaidSlots } from './maid.ts'

/**
 * 动态 (system-design §12.2): what the app brings on its own, its own page, opened from the title bar. Her line and
 * picture at its head, then what is new, what comes next and what was seen; the one picked on the right, whose
 * actions take it into the conversation or let it go. Nothing here becomes a background task (后台 is apart).
 */
const LINE_MAID_PX = 56
const lineMaids: MaidSlots = new Map()

function herLine(state: State) {
  const { fresh, next } = feedLine(state)
  const words = fresh ? t('feed.line.new', { count: fresh }) : next ? t('feed.line.next', { count: next }) : t('feed.line.quiet')
  return h('div', { class: 'feed-her' },
    maidFor(lineMaids, 'line', fresh ? 'done' : 'idle', { size: LINE_MAID_PX }),
    h('p', { class: 'feed-say', text: words }))
}

function group(name: string, items: readonly Untyped[], selected: string | null, handlers: Handlers, now: number) {
  if (!items.length) return []
  return [
    h('div', { class: 'tp-group' }, name, h('span', { class: 'tp-group-count', text: String(items.length) })),
    ...items.map((item) => h('button', {
      class: 'tp-row fu-row', type: 'button', 'data-status': item.status, 'aria-current': item.id === selected ? 'page' : null,
      onClick: () => handlers.selectFeed(item.id),
    }, h('span', { class: 'tp-name', text: item.title }), h('span', { class: 'tp-meta', text: followupStanding(item, now) }))),
  ]
}

/** One line on background preparation: preparing now, waiting on the user, or when it looks next. */
function prepareLine(state: State, now: number) {
  const prepare = state.followups.state
  if (prepare?.running) return h('p', { class: 'fu-state', 'data-on': 'true', text: t('tasks-page.preparing.in.background', { current: prepare.current }) })
  if (prepare?.waiting) return h('p', { class: 'fu-state', text: t('tasks-page.preparing.later', { waiting: prepare.waiting }) })
  if (prepare?.nextAt) return h('p', { class: 'fu-state', text: t('tasks-page.next.background.preparation', { value1: whenText(prepare.nextAt, now) }) })
  return null
}

export function renderFeedPage(container: HTMLElement, state: State, handlers: Handlers, now = Date.now()) {
  const { fresh, next, seen } = feedGroups(state)
  const shown = feedShown(state)
  const side = h('nav', { class: 'tp-side feed-side', 'aria-label': t('feed.title') },
    h('div', { class: 'tp-side-head' },
      h('h1', { class: 'feed-title', text: t('feed.title') }),
      h('button', { class: 'btn btn-text btn-small feed-close', type: 'button', onClick: () => handlers.closeHub() },
        h('span', { text: t('tasks-page.back') }), h('kbd', { text: 'Esc' }))),
    herLine(state),
    prepareLine(state, now),
    ...group(t('feed.new'), fresh, shown?.id ?? null, handlers, now),
    ...group(t('feed.next'), next, shown?.id ?? null, handlers, now),
    ...group(t('feed.seen'), seen, shown?.id ?? null, handlers, now))
  const main = shown
    ? followupDetail(shown, state.followups.state, handlers, now)
    : h('div', { class: 'tp-main feed-empty' }, h('p', { class: 'empty', text: t('feed.empty') }))
  container.replaceChildren(side, main)
}
