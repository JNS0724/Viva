import { t } from '../shared/i18n/translate.ts'

/**
 * 动态 (system-design §12.2): what the app brings on its own, apart from 后台 (what the user asked for). Its page is
 * opened from the title bar; it lists what is new (items not looked at yet), what comes next (the schedules) and what
 * was seen, and says in one line how things stand. Pure and immutable; `state.ts` merges it.
 */
/** An item as the main process lists it (backend/feed-store.ts). */
export interface FeedItemView { id: string, source: string, key: string, title: string, body: string, origin: { label: string, ref?: string }, createdAt: number, seenAt: number | null }
/** A schedule as the main process lists it (backend/schedules.ts). */
export interface ScheduleView { id: string, title: string, prompt: string, kind: string, nextAt: string, status: string }
/** What is shown on the right: an item, or a schedule. */
export interface FeedPick { kind: 'item' | 'schedule', id: string }

export const initialFeed = Object.freeze({
  open: false,
  /** The one shown on the right; none picked, the first new item. */
  selected: null as FeedPick | null,
  items: Object.freeze([]) as readonly FeedItemView[],
  schedules: Object.freeze([]) as readonly ScheduleView[],
  /** A change is on its way to the main process. */
  busy: false,
  error: null as string | null,
})

/** How many seen ones are listed, latest first. */
const SEEN_LISTED = 20

const itemsOf = (state: State): readonly FeedItemView[] => state.feed.items as readonly FeedItemView[]
const schedulesOf = (state: State): readonly ScheduleView[] => state.feed.schedules as readonly ScheduleView[]
/** Active ones by their next time, then the paused. */
const nextOrder = (a: ScheduleView, b: ScheduleView) => Number(a.status === 'paused') - Number(b.status === 'paused') || Date.parse(a.nextAt) - Date.parse(b.nextAt)

/** The page's three groups: new items (latest first), the schedules (soonest first), seen items (latest, the last few). */
export function feedGroups(state: State): { fresh: FeedItemView[], next: ScheduleView[], seen: FeedItemView[] } {
  const items = itemsOf(state)
  return {
    fresh: items.filter((item) => item.seenAt === null),
    next: schedulesOf(state).toSorted(nextOrder),
    seen: items.filter((item) => item.seenAt !== null).slice(0, SEEN_LISTED),
  }
}

/** The title bar's count: new items, waiting to be looked at. */
export const feedCount = (state: State): number => feedGroups(state).fresh.length

export type FeedShown = { kind: 'item', item: FeedItemView, fresh: boolean } | { kind: 'schedule', schedule: ScheduleView }

/** The one shown on the right: the one picked while it is listed, else the first new item, else none. */
export function feedShown(state: State): FeedShown | null {
  const { fresh, next, seen } = feedGroups(state)
  const picked = state.feed.selected as FeedPick | null
  if (picked?.kind === 'schedule') {
    const schedule = next.find((item) => item.id === picked.id)
    if (schedule) return { kind: 'schedule', schedule }
  }
  const item = (picked?.kind === 'item' ? [...fresh, ...seen].find((one) => one.id === picked.id) : null) ?? fresh[0]
  return item ? { kind: 'item', item, fresh: item.seenAt === null } : null
}

/** Her line at the page's head: what is new and what comes next, as counts (the view words them). */
export function feedLine(state: State): { fresh: number, next: number } {
  const { fresh, next } = feedGroups(state)
  return { fresh: fresh.length, next: next.filter((schedule) => schedule.status === 'active').length }
}

/** 在对话里继续: what goes into the input, for the user to read and send: where it came from, then the item. */
export const continueText = (item: Pick<FeedItemView, 'title' | 'body'>): string => `${t('feed.continue.from', { title: item.title })}\n\n${item.body}`

const withFeed = (state: State, changes: Partial<State['feed']>): State => ({ ...state, feed: { ...state.feed, ...changes } })
const pickOf = (kind: unknown, id: unknown): FeedPick | null => ((kind === 'item' || kind === 'schedule') && typeof id === 'string' ? { kind, id } : null)

export const FEED_ACTIONS: Readonly<Record<string, Reducer>> = {
  feed_open: (state, { kind, id }) => withFeed({ ...state, island: false }, { open: true, selected: pickOf(kind, id) ?? state.feed.selected }),
  feed_close: (state) => withFeed(state, { open: false }),
  feed_select: (state, { kind, id }) => withFeed(state, { selected: pickOf(kind, id) }),
  feed_loaded: (state, { items, schedules }) => withFeed(state, {
    ...(Array.isArray(items) ? { items } : {}), ...(Array.isArray(schedules) ? { schedules } : {}), busy: false, error: null,
  }),
  feed_busy: (state) => withFeed(state, { busy: true, error: null }),
  feed_failed: (state, { message }) => withFeed(state, { busy: false, error: typeof message === 'string' ? message : null }),
}
