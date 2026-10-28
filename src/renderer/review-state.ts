/**
 * 回顾 (view/review.ts): the topics, the one last talked in first, a page at a time (history-review.ts, which says
 * what each topic holds over all of it), shown by month and day; filtered to topics with background tasks or with
 * files (by the history, over each whole topic), or the starred messages; a topic or a task read in place; and a
 * message opened from a search hit, a link or a star, read at the top. Pure and immutable like the rest of
 * `state.js`, which merges these handlers into its reducer.
 */
import { starKey } from './stars.ts'

export const REVIEW_FILTERS = Object.freeze(['all', 'tasks', 'files', 'stars'] as const)

/** A background task of a topic (history-review.ts ReviewTask). */
export type ReviewTask = { id: string, createdAt: number, title: string, turns: number, hasFiles: boolean, stars: number }
/** A topic as the history lists it (history-review.ts ReviewTopic). */
export type ReviewTopic = {
  id: string, title: string, startedAt: number, lastAt: number, turns: number, hasFiles: boolean, stars: number,
  cwds: readonly string[], segments: readonly string[], head: string | null, tasks: readonly ReviewTask[],
}
/** A message read in 回顾, with the segment it is kept in. */
export type ReaderMessage = SegmentMessage & { segmentId: string }
/**
 * What is read at the top: opened from a hit, a link or a star; `found`, the message it named (its `data-msg`),
 * marked while it is open; `notice` when that message itself is not there.
 */
export type ReviewFocus = { key: string, title: string, at: number | null, head: string | null, found: string | null, notice: string | null }

/** What 回顾 reads: a topic's conversation, or one segment on its own (a task, a path left behind). */
export const topicKey = (topicId: string) => `t:${topicId}`
export const segmentKey = (segmentId: string) => `s:${segmentId}`

export const initialReview = Object.freeze({
  topics: [] as ReviewTopic[],
  hasMore: true,
  loading: false,
  loaded: false,
  filter: 'all' as string,
  /** What is open to read (topicKey or segmentKey), and what it says once read. */
  open: null as string | null,
  reading: null as { key: string, messages: ReaderMessage[] } | null,
  focus: null as ReviewFocus | null,
  /** The 收藏 list (history-review.ts starredMessages), once read. */
  starred: null as Untyped,
  /** Which messages shown anywhere are starred, as stars.ts starKey: read back for what is on screen. */
  starKeys: [] as string[],
})

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const DAY_MS = 86_400_000
const startOfDay = (ts: number) => new Date(new Date(ts).toDateString()).getTime()

export function dayLabel(ts: number, now: number) {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  const date = new Date(ts)
  return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAYS[date.getDay()]}`
}
const monthLabel = (ts: number) => `${new Date(ts).getFullYear()}年${new Date(ts).getMonth() + 1}月`

/** Whether a topic began on another day than it was last talked in (the page then says when it began). */
export const begunEarlier = (topic: ReviewTopic) => startOfDay(topic.startedAt) !== startOfDay(topic.lastAt)

/** Topics as listed (last talked in first), by month and then by day of when each was last talked in. */
export function reviewDays(topics: readonly ReviewTopic[], now = Date.now()) {
  const months: Array<{ label: string, days: Array<{ label: string, topics: ReviewTopic[] }> }> = []
  for (const topic of topics) {
    const month = monthLabel(topic.lastAt)
    const day = dayLabel(topic.lastAt, now)
    if (months.at(-1)?.label !== month) months.push({ label: month, days: [] })
    const { days } = months.at(-1)!
    if (days.at(-1)?.label !== day) days.push({ label: day, topics: [] })
    days.at(-1)!.topics.push(topic)
  }
  return months
}

/** Whether a topic holds a segment, in its conversation or as one of its tasks. */
export const topicHolds = (topic: ReviewTopic, segmentId: string) => topic.segments.includes(segmentId) || topic.tasks.some((task) => task.id === segmentId)

const withReview = (state: State, changes: Partial<State['review']>): State => ({ ...state, review: { ...state.review, ...changes } })
const counted = (stars: number, starred: boolean) => Math.max(0, stars + (starred ? 1 : -1))

/** A star put on or taken off a message of `segmentId`: counted on its topic, and on its task when it is in one. */
function recount(topic: ReviewTopic, segmentId: string, starred: boolean): ReviewTopic {
  if (!topicHolds(topic, segmentId)) return topic
  return {
    ...topic,
    stars: counted(topic.stars, starred),
    tasks: topic.tasks.map((task) => (task.id === segmentId ? { ...task, stars: counted(task.stars, starred) } : task)),
  }
}

export const REVIEW_ACTIONS: Record<string, Reducer> = {
  review_loading: (state) => withReview(state, { loading: true }),
  /** A page of topics; `fresh`, the first page, read again each time the page opens or the filter changes. */
  review_loaded: (state, { topics, hasMore, fresh }) => {
    const before = fresh ? [] : state.review.topics
    const known = new Set(before.map((topic: ReviewTopic) => topic.id))
    const added = (topics ?? []).filter((topic: ReviewTopic) => !known.has(topic.id))
    return withReview(state, { topics: [...before, ...added], hasMore: Boolean(hasMore), loading: false, loaded: true })
  },
  review_failed: (state) => withReview(state, { loading: false }),
  /** Another filter: the topics are read again for it (the history filters over whole topics); 收藏 lists stars. */
  review_filter: (state, { filter }) => {
    const next = (REVIEW_FILTERS as readonly string[]).includes(filter) ? filter : 'all'
    if (next === state.review.filter) return state
    return next === 'stars' ? withReview(state, { filter: next }) : withReview(state, { filter: next, topics: [], hasMore: true, loaded: false })
  },
  /** Opens a topic or a task of the list to read, or closes it when it is the one open. */
  review_open: (state, { key }) => (state.review.open === key && !state.review.focus
    ? withReview(state, { open: null, reading: null })
    : withReview(state, { open: key, reading: null, focus: null })),
  /** A message opened from a search hit, a link or a star: its topic (or task) read at the top. */
  review_focus: (state, { key, title, at = null, head = null, found = null, notice = null }) => withReview(state, {
    open: key, focus: { key, title: title ?? '', at, head, found, notice }, reading: state.review.reading?.key === key ? state.review.reading : null,
  }),
  review_unfocus: (state) => withReview(state, { open: null, reading: null, focus: null }),
  review_read: (state, { key, messages }) => (state.review.open === key ? withReview(state, { reading: { key, messages } }) : state),
  review_starred: (state, { items }) => withReview(state, { starred: items }),
  /** Stars read back for messages now shown (history-review.ts starsIn). */
  stars_loaded: (state, { places }) => {
    const keys = new Set([...state.review.starKeys, ...(places ?? []).map(starKey)])
    return keys.size === state.review.starKeys.length ? state : withReview(state, { starKeys: [...keys] })
  },
  /**
   * A star put on or taken off (in the timeline or here): the message, its topic's count, and the 收藏 list. The
   * count moves only when the star did (`changed`: the history says whether it was there already).
   */
  star_changed: (state, { segmentId, seq, starred, changed = true }) => withReview(state, {
    starKeys: [...state.review.starKeys.filter((key: string) => key !== starKey({ segmentId, seq })), ...(starred ? [starKey({ segmentId, seq })] : [])],
    topics: changed ? state.review.topics.map((topic: ReviewTopic) => recount(topic, segmentId, starred)) : state.review.topics,
    starred: starred || !state.review.starred ? state.review.starred
      : state.review.starred.filter((item: { segmentId: string, seq: number }) => item.segmentId !== segmentId || item.seq !== seq),
  }),
}
