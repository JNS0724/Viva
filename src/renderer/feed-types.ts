import type { FeedSourceSchedule, FeedSourceView } from '../shared/feed-source.ts'
export type { FeedSourceSchedule, FeedSourceView } from '../shared/feed-source.ts'

/**
 * 动态 (system-design §12.2): what the app brings on its own, apart from 后台 (what the user asked for). Its page is
 * opened from the title bar; it lists what is new (items not looked at yet), plugin data sources, what comes next
 * (the schedules) and what was seen, and says in one line how things stand. Pure and immutable; `state.ts` merges it.
 */
/** An item as the main process lists it (backend/feed-store.ts). */
export interface FeedItemView { id: string, source: string, key: string, title: string, body: string, origin: { label: string, ref?: string }, createdAt: number, seenAt: number | null }

/** A schedule as the main process lists it (backend/schedules.ts). */
export interface ScheduleView { id: string, title: string, prompt: string, kind: string, nextAt: string, status: string }

/** Editable form state for creating or editing a plugin-backed data source. */
export interface FeedSourceDraft {
  sourceId: string | null
  pluginName: string
  name: string
  instruction: string
  freqKind: FeedSourceSchedule['kind']
  intervalMin: number
  time: string
  weekdays: readonly number[]
  cron: string
}

/** What is shown on the right: an item, a data source, the new-source form, or a schedule. */
export type FeedPick =
  | { kind: 'item' | 'schedule' | 'source', id: string }
  | { kind: 'new-source', id: '+add' }

export type FeedShown =
  | { kind: 'item', item: FeedItemView, fresh: boolean }
  | { kind: 'schedule', schedule: ScheduleView }
  | { kind: 'source', source: FeedSourceView }
  | { kind: 'new-source' }
