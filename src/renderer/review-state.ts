/**
 * 回顾 (view/review.ts): the one timeline read back by time, newest first, a page of segments at a time
 * (history-review.ts), shown a topic a line by month and day; filtered to background tasks, topics with files, or
 * the starred messages; a topic read in place. Pure and immutable like the rest of `state.js`, which merges these
 * handlers into its reducer.
 */
import { starKey } from './stars.ts'

export const REVIEW_FILTERS =Object.freeze(['all', 'tasks', 'files', 'stars'] as const)

export const initialReview = Object.freeze({
  /** As history-review.ts lists them, newest first. */
  segments: [] as Untyped[],
  hasMore: true,
  loading: false,
  loaded: false,
  filter: 'all' as string,
  /** The topic being read (its key), and what it says once read: { key, messages } */
  open: null as string | null,
  reading: null as Untyped,
  /** The 收藏 list (history-review.ts starredMessages), once read. */
  starred: null as Untyped,
  /** Which messages shown anywhere are starred, as stars.ts starKey: read back for what is on screen. */
  starKeys: [] as string[],
})

/** A segment as 回顾 lists it (history-review.ts ReviewSegment). */
type ReviewSegment = {
  id: string, parentId: string | null, createdAt: number, title: string, cwd: string | null,
  kind: 'talk' | 'task', turns: number, hasFiles: boolean, stars: number,
}
/** Segments that read as one: key, its newest segment; title and time, its first's. */
export type ReviewTopic = {
  key: string, kind: 'talk' | 'task', segments: ReviewSegment[], title: string, at: number,
  turns: number, hasFiles: boolean, stars: number,
}

const topicOf = (segments: ReviewSegment[]): ReviewTopic => ({
  key: segments.at(-1)!.id,
  kind: segments[0].kind,
  segments,
  title: segments[0].title,
  at: segments[0].createdAt,
  turns: segments.reduce((sum, segment) => sum + segment.turns, 0),
  hasFiles: segments.some((segment) => segment.hasFiles),
  stars: segments.reduce((sum, segment) => sum + segment.stars, 0),
})

/**
 * Segments newest first as topics, the newest begun first: a segment that goes on from another listed one (a change
 * of directory) joins its topic, background tasks started in between or not. A background task is a topic of its own.
 */
export function reviewTopics(segments: readonly ReviewSegment[]): ReviewTopic[] {
  const runs: ReviewSegment[][] = []
  const runOf = new Map<string, number>()
  for (const segment of [...segments].reverse()) {
    const into = segment.kind === 'talk' && segment.parentId !== null ? runOf.get(segment.parentId) : undefined
    const index = into ?? runs.push([]) - 1
    runs[index] = [...runs[index], segment]
    if (segment.kind === 'talk') runOf.set(segment.id, index)
  }
  return runs.map(topicOf).reverse()
}

/** The topics a filter keeps; 收藏 shows the starred messages instead (view/review.ts). */
export function shownTopics(topics: readonly ReviewTopic[], filter: string): ReviewTopic[] {
  if (filter === 'tasks') return topics.filter((topic) => topic.kind === 'task')
  if (filter === 'files') return topics.filter((topic) => topic.hasFiles)
  return [...topics]
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const DAY_MS = 86_400_000
const startOfDay = (ts: number) => new Date(new Date(ts).toDateString()).getTime()

function dayLabel(ts: number, now: number) {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  const date = new Date(ts)
  return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAYS[date.getDay()]}`
}
const monthLabel = (ts: number) => `${new Date(ts).getFullYear()}年${new Date(ts).getMonth() + 1}月`

/** Topics newest first, by month and then by day, as the page heads them. */
export function reviewDays(topics: readonly ReviewTopic[], now = Date.now()) {
  const months: Array<{ label: string, days: Array<{ label: string, topics: ReviewTopic[] }> }> = []
  for (const topic of topics) {
    const month = monthLabel(topic.at)
    const day = dayLabel(topic.at, now)
    if (months.at(-1)?.label !== month) months.push({ label: month, days: [] })
    const { days } = months.at(-1)!
    if (days.at(-1)?.label !== day) days.push({ label: day, topics: [] })
    days.at(-1)!.topics.push(topic)
  }
  return months
}

const withReview = (state: State, changes: Partial<State['review']>): State => ({ ...state, review: { ...state.review, ...changes } })

export const REVIEW_ACTIONS: Record<string, Reducer> = {
  review_loading: (state) => withReview(state, { loading: true }),
  /** A page of older segments; `fresh`, the first page, read again each time the page opens. */
  review_loaded: (state, { segments, hasMore, fresh }) => {
    const before = fresh ? [] : state.review.segments
    const known = new Set(before.map((segment: ReviewSegment) => segment.id))
    const added = (segments ?? []).filter((segment: ReviewSegment) => !known.has(segment.id))
    return withReview(state, { segments: [...before, ...added], hasMore: Boolean(hasMore), loading: false, loaded: true })
  },
  review_failed: (state) => withReview(state, { loading: false }),
  review_filter: (state, { filter }) => withReview(state, { filter: (REVIEW_FILTERS as readonly string[]).includes(filter) ? filter : 'all' }),
  /** Opens a topic to read it, or closes it when it is the one open. */
  review_open: (state, { key }) => (state.review.open === key
    ? withReview(state, { open: null, reading: null })
    : withReview(state, { open: key, reading: null })),
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
    segments: state.review.segments.map((segment: ReviewSegment) => (segment.id === segmentId && changed
      ? { ...segment, stars: Math.max(0, segment.stars + (starred ? 1 : -1)) }
      : segment)),
    starred: starred || !state.review.starred ? state.review.starred
      : state.review.starred.filter((item: { segmentId: string, seq: number }) => item.segmentId !== segmentId || item.seq !== seq),
  }),
}
