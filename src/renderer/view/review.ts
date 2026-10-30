import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { REVIEW_FILTERS, begunEarlier, dayLabel, reviewDays, segmentKey, topicKey, type ReaderEdge, type ReaderMessage, type ReviewTask, type ReviewTopic } from '../review-state.ts'
import { formatListTime, workspaceName } from '../selectors.ts'
import { h } from './dom.ts'
import { markMessage, pastMessageView } from './thread.ts'
import { reconcileChildren } from './reconcile.ts'

/**
 * 回顾: the 搜索 page with nothing typed (view/history-panel.ts). The topics by month and day of when each was last
 * talked in, a topic a line (its first question, turns, time, when it began if another day, files, stars), its
 * background tasks under it; a topic or task opens in place to read (查看记录), with 继续这个话题 for a topic.
 * Filtered to topics with background tasks or files, or the starred messages. A message opened from a search hit,
 * a link or a star is read at the top. More comes in at the bottom.
 */
const FILTER_NAMES = (): Readonly<Record<string, string>> => ({ all: t("review.filter.all"), tasks: t("tasks-page.background.tasks"), files: t("review.filter.files"), stars: t("review.filter.bookmarks") })
const EMPTY = (): Readonly<Record<string, string>> => ({
  all: t("review.empty.conversations"),
  tasks: t("review.empty.tasks"),
  files: t("review.empty.files"),
})
const SPEAKERS = (): Readonly<Record<string, string>> => ({ user: t("history-panel.you"), assistant: 'Viva' })

const hint = (text: string) => h('div', { class: 'history-hint', text })
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)

function filterBar(filter: string, handlers: Handlers) {
  return h('div', { class: 'review-filters', role: 'group', 'aria-label': t("review.filter.label") },
    REVIEW_FILTERS.map((key) => h('button', {
      class: 'review-filter', type: 'button', 'aria-pressed': String(filter === key), text: FILTER_NAMES()[key],
      onClick: () => handlers.reviewFilter(key),
    })))
}

/**
 * Each message read, drawn once: reading on at one end keeps the messages already read (review-state.ts readOn),
 * so their views are kept with them and only the new ones are built (a long Markdown answer is not drawn again).
 */
let readViews = new WeakMap<ReaderMessage, View>()

/** A message read, marked with where it is kept; `found`, the one a hit, link or star named. */
function readMessage(message: ReaderMessage, found: string | null, handlers: Handlers): View {
  const msgId = `${message.segmentId}-${message.seq}`
  let view = readViews.get(message)
  if (view === undefined) {
    view = markMessage(pastMessageView(message as unknown as ThreadMessage, handlers), msgId)
    readViews.set(message, view)
  }
  const first = Array.isArray(view) ? view[0] : view
  if (first instanceof Element) first.classList.toggle('msg-found', msgId === found)
  return view
}

/**
 * The end of the part read where more is: it reads on by itself as it comes into view (app.ts watches
 * `.reader-edge`), or when pressed.
 */
function readerEdge(edge: ReaderEdge, count: number, handlers: Handlers) {
  return h('button', {
    class: 'reader-edge timeline-more', type: 'button', 'data-edge': edge,
    text: edge === 'before' ? t("review.reader.earlier", { p0: count }) : t("review.reader.more", { p0: count }),
    onClick: () => handlers.readerMore(edge),
  })
}

/** What is open read: the part of its messages drawn, each with its star, and where more is; or that it is being read. */
function readerBody(key: string, review: State['review'], handlers: Handlers, found: string | null): View[] {
  const reading = review.reading?.key === key ? review.reading : null
  if (reading === null) return [hint(t("earlier.loading"))]
  const after = reading.total - reading.from - reading.messages.length
  return [
    reading.from > 0 ? readerEdge('before', reading.from, handlers) : null,
    ...reading.messages.map((message: ReaderMessage) => readMessage(message, found, handlers)),
    after > 0 ? readerEdge('after', after, handlers) : null,
  ]
}

/** What a reader holds: the part read, and for a topic 继续这个话题 (the only thing here that changes the conversation). */
function readerParts(key: string, head: string | null, review: State['review'], handlers: Handlers, found: string | null): Array<Node | string> {
  return [
    ...readerBody(key, review, handlers, found),
    head ? h('div', { class: 'review-reader-actions' },
      h('span', { class: 'review-reader-note', text: t("review.reader.context.note") }),
      h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t("review.continue.topic"), onClick: () => handlers.resumeFromReview(head) })) : null,
  ].flat(2).filter((part): part is Node | string => part instanceof Node || (typeof part === 'string' && part !== ''))
}

/** The reader of `key`; it says what it reads, so a part read on is put into it in place (patchReader). */
function reader(key: string, head: string | null, review: State['review'], handlers: Handlers, found: string | null = null) {
  return h('div', { class: 'review-reader', 'data-key': key, 'data-head': head ?? '' }, ...readerParts(key, head, review, handlers, found))
}

/**
 * A part read on (or a star changed) and nothing else on the page: the reader on screen takes it in place, the
 * messages it had kept where they are rather than drawn again (a long topic reads on without the page being redrawn).
 * @returns false when there is no such reader on screen, and the page is drawn again instead
 */
export function patchReader(list: HTMLElement, state: State, handlers: Handlers): boolean {
  const key = state.review.open
  const el = key ? list.querySelector<HTMLElement>(`.review-reader[data-key="${CSS.escape(key)}"]`) : null
  if (!el || !key) return false
  const found = state.review.focus?.key === key ? state.review.focus.found : null
  reconcileChildren(el, readerParts(key, el.dataset.head || null, state.review, handlers, found))
  return true
}

/** A message opened from a search hit, a link or a star: its topic or task, read at the top, until closed. */
export function focusView(state: State, handlers: Handlers, now = Date.now()): View {
  const { focus } = state.review
  if (!focus) return null
  const isTopic = focus.key.startsWith('t:')
  const when = focus.at === null ? '' : formatListTime(focus.at, now)
  return h('section', { class: 'review-focus', 'aria-label': t("review.read.records") },
    h('div', { class: 'review-focus-head' },
      h('span', { class: 'review-kind', text: isTopic ? t("history-panel.record") : t("island-tasks.background") }),
      h('b', { class: 'review-title', text: focus.title || t("topic.no.question") }),
      when ? h('span', { class: 'review-meta mono', text: when }) : null,
      h('button', { class: 'btn btn-text btn-small review-focus-close', type: 'button', text: t("review.close"), onClick: () => handlers.reviewCloseFocus() })),
    focus.notice ? h('div', { class: 'review-notice', role: 'status', text: focus.notice }) : null,
    reader(focus.key, focus.head, state.review, handlers, focus.found))
}

function taskItem(task: ReviewTask, review: State['review'], handlers: Handlers) {
  const key = segmentKey(task.id)
  const open = review.open === key && !review.focus
  const marks = [task.hasFiles ? t("review.filter.files") : null, task.stars ? `★ ${task.stars}` : null].filter(Boolean).join(' · ')
  return h('li', { class: 'review-task', 'data-open': String(open) },
    h('button', { class: 'review-row review-task-row', type: 'button', 'aria-expanded': String(open), onClick: () => handlers.reviewOpen(key) },
      h('span', { class: 'review-kind', text: t("island-tasks.background") }),
      h('span', { class: 'review-title', text: task.title || t("topic.no.question") }),
      marks ? h('span', { class: 'review-marks', text: marks }) : null,
      h('span', { class: 'review-meta mono', text: t("topic.turns.time", { p0: task.turns, p1: clock(task.createdAt) }) })),
    open ? reader(key, null, review, handlers) : null)
}

function topicItem(topic: ReviewTopic, review: State['review'], handlers: Handlers, now: number) {
  const key = topicKey(topic.id)
  const open = review.open === key && !review.focus
  const marks = [
    topic.hasFiles ? t("review.filter.files") : null,
    topic.stars ? `★ ${topic.stars}` : null,
    topic.cwds.length > 1 ? t("review.folder.changed", { p0: topic.cwds.map((cwd) => workspaceName(cwd)).join(' → ') }) : null,
  ].filter(Boolean).join(' · ')
  const began = begunEarlier(topic) ? t("review.topic.started", { p0: dayLabel(topic.startedAt, now) }) : ''
  return h('li', { class: 'review-topic', 'data-open': String(open) },
    h('button', { class: 'review-row', type: 'button', 'aria-expanded': String(open), 'aria-label': t("review.read.topic.label", { p0: topic.title }), onClick: () => handlers.reviewOpen(key) },
      h('b', { class: 'review-title', text: topic.title || t("topic.no.question") }),
      marks ? h('span', { class: 'review-marks', text: marks }) : null,
      h('span', { class: 'review-meta mono', text: t("review.topic.turns.time", { p0: topic.turns, p1: clock(topic.lastAt), p2: began }) })),
    open ? reader(key, topic.head, review, handlers) : null,
    topic.tasks.length ? h('ul', { class: 'review-tasks' }, topic.tasks.map((task) => taskItem(task, review, handlers))) : null)
}

function topicList(review: State['review'], handlers: Handlers, now: number): View[] {
  if (!review.loaded) return [hint(t("earlier.loading"))]
  const months = reviewDays(review.topics, now).map((month) => h('section', { class: 'review-month' },
    h('h3', { class: 'review-month-head', text: month.label }),
    month.days.map((day) => h('div', { class: 'review-day' },
      h('div', { class: 'review-day-head', text: day.label }),
      h('ul', { class: 'review-items' }, day.topics.map((topic) => topicItem(topic, review, handlers, now)))))))
  const more = review.hasMore
    ? h('button', { class: 'timeline-more', type: 'button', disabled: review.loading, text: review.loading ? t("earlier.loading") : t("review.earlier"), onClick: () => handlers.reviewMore() })
    : review.topics.length ? hint(t("review.no.earlier")) : null
  return [...(months.length ? months : [hint(EMPTY()[review.filter] ?? EMPTY().all)]), more]
}

type StarredItem = { segmentId: string, seq: number, messageId?: number, role: string, text: string, at: number, title: string, deleted?: boolean }

/**
 * The starred messages, newest star first: who said it, when, in which topic; 详情 reads it where it is kept. A star
 * whose record was just deleted shows so, greyed, until the record is gone for good (or comes back with 撤销).
 */
function starredList(review: State['review'], handlers: Handlers, now: number): View[] {
  if (review.starred === null) return [hint(t("earlier.loading"))]
  if (!review.starred.length) return [hint(t("bookmarks.empty"))]
  return [h('ul', { class: 'review-items review-stars' }, review.starred.map((item: StarredItem) =>
    h('li', { class: 'review-star', 'data-deleted': String(Boolean(item.deleted)) },
      h('span', { class: 'history-meta mono' }, h('b', { class: 'history-title', text: SPEAKERS()[item.role] ?? t("history-panel.record") }),
        `${formatListTime(item.at, now)} · ${item.title}${item.deleted ? t("review.deleted.suffix") : ''}`),
      h('div', { class: 'review-star-text', text: item.text }),
      item.deleted ? null : h('div', { class: 'review-star-actions' },
        h('button', { class: 'btn btn-text btn-small', type: 'button', text: t("bookmarks.remove"), onClick: () => handlers.toggleStar({ segmentId: item.segmentId, seq: item.seq }, false) }),
        h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t("history-panel.details"),
          onClick: () => handlers.openStarred({ segmentId: item.segmentId, seq: item.seq, messageId: item.messageId }) })))))]
}

export function reviewView(state: State, handlers: Handlers, now = Date.now()): View[] {
  const { review } = state
  return [focusView(state, handlers, now), filterBar(review.filter, handlers),
    ...(review.filter === 'stars' ? starredList(review, handlers, now) : topicList(review, handlers, now))]
}

onLocaleChange(() => { readViews = new WeakMap<ReaderMessage, View>() })
