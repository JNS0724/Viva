/**
 * 动态 (system-design §12.2): what the app brings on its own, apart from 后台 (what the user asked for). Its page is
 * opened from the title bar; it lists what is new (ready to look at), what comes next (scheduled), and what was
 * seen, and says in one line how things stand. For now its items are the follow-ups (followup-state.ts); a source's
 * items join them later. Pure and immutable; `state.ts` merges it.
 */
export const initialFeed = Object.freeze({
  open: false,
  /** The follow-up shown on the right, by id; none picked, the first new one. */
  selected: null as string | null,
})

/** How many seen ones are listed, latest first. */
const SEEN_LISTED = 20
const NEW = new Set(['ready'])
const NEXT = new Set(['scheduled', 'preparing'])
const SEEN = new Set(['done', 'dismissed'])

type FeedFollowup = { id: string, status: string, draftAt?: number | null, createdAt?: number, remindAt?: number | null, prepareBy?: number | null }
const followupsOf = (state: State): FeedFollowup[] => state.followups.followups as FeedFollowup[]
/** When a scheduled one next comes: its preparation or its reminder, whichever is first. */
const dueOf = (item: FeedFollowup) => Math.min(item.prepareBy ?? Infinity, item.remindAt ?? Infinity)

/** The page's three groups: new (latest first), next (soonest first), seen (latest first, the last few). */
export function feedGroups(state: State): { fresh: FeedFollowup[], next: FeedFollowup[], seen: FeedFollowup[] } {
  const list = followupsOf(state)
  const latest = (a: FeedFollowup, b: FeedFollowup) => (b.draftAt ?? b.createdAt ?? 0) - (a.draftAt ?? a.createdAt ?? 0)
  return {
    fresh: list.filter((item) => NEW.has(item.status)).toSorted(latest),
    next: list.filter((item) => NEXT.has(item.status)).toSorted((a, b) => dueOf(a) - dueOf(b)),
    seen: list.filter((item) => SEEN.has(item.status)).toSorted(latest).slice(0, SEEN_LISTED),
  }
}

/** The title bar's count: what is new, waiting to be looked at. */
export const feedCount = (state: State): number => feedGroups(state).fresh.length

/** The one shown on the right: the one picked while it is listed, else the first new one, else none. */
export function feedShown(state: State): FeedFollowup | null {
  const { fresh, next, seen } = feedGroups(state)
  const listed = [...fresh, ...next, ...seen]
  return listed.find((item) => item.id === state.feed.selected) ?? fresh[0] ?? null
}

/** Her line at the page's head: what is new and what comes next, as counts (the view words them). */
export function feedLine(state: State): { fresh: number, next: number } {
  const { fresh, next } = feedGroups(state)
  return { fresh: fresh.length, next: next.length }
}

const withFeed = (state: State, changes: Partial<State['feed']>): State => ({ ...state, feed: { ...state.feed, ...changes } })

export const FEED_ACTIONS: Readonly<Record<string, Reducer>> = {
  feed_open: (state, { id = null }) => withFeed({ ...state, island: false }, { open: true, selected: typeof id === 'string' ? id : state.feed.selected }),
  feed_close: (state) => withFeed(state, { open: false }),
  feed_select: (state, { id }) => withFeed(state, { selected: typeof id === 'string' ? id : null }),
}
