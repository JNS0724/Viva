

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


export type FeedShown = { kind: 'item', item: FeedItemView, fresh: boolean } | { kind: 'schedule', schedule: ScheduleView }
