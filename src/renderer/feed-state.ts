import { localTimeZone, type FeedSourceSchedule, type FeedSourceView } from '../shared/feed-source.ts'
import type { FeedItemView, ScheduleView, FeedPick, FeedShown, FeedSourceDraft } from './feed-types.ts'
export type { FeedItemView, ScheduleView, FeedPick, FeedShown, FeedSourceDraft, FeedSourceView } from './feed-types.ts'
import type { ActionHandlers } from './action-types.ts'
export { continueText } from '../shared/feed-continuation.ts'

export const NEW_SOURCE_ID = '+add' as const

export const initialFeed = Object.freeze({
  open: false,
  /** The one shown on the right; none picked, the first new item. */
  selected: null as FeedPick | null,
  items: Object.freeze([]) as readonly FeedItemView[],
  sources: Object.freeze([]) as readonly FeedSourceView[],
  schedules: Object.freeze([]) as readonly ScheduleView[],
  /** Editable form draft for the selected or new data source. */
  draft: null as FeedSourceDraft | null,
  /** Source currently executing a manual run-now request. */
  runningSourceId: null as string | null,
  /** Brief status notice shown inside the data source form. */
  notice: null as string | null,
  /** A change is on its way to the main process. */
  busy: false,
  error: null as string | null,
})

/** How many seen ones are listed, latest first. */
const SEEN_LISTED = 20

const itemsOf = (state: State): readonly FeedItemView[] => state.feed.items as readonly FeedItemView[]
const sourcesOf = (state: State): readonly FeedSourceView[] => state.feed.sources as readonly FeedSourceView[]
const schedulesOf = (state: State): readonly ScheduleView[] => state.feed.schedules as readonly ScheduleView[]
/** Active ones by their next time, then the paused. */
const nextOrder = (a: ScheduleView, b: ScheduleView) => Number(a.status === 'paused') - Number(b.status === 'paused') || Date.parse(a.nextAt) - Date.parse(b.nextAt)

export function emptyFeedSourceDraft(pluginName = ''): FeedSourceDraft {
  return {
    sourceId: null,
    pluginName,
    name: '',
    instruction: '',
    freqKind: 'interval',
    intervalMin: 30,
    time: '09:00',
    weekdays: [1, 2, 3, 4, 5],
    cron: '*/30 * * * *',
  }
}

export function feedSourceDraftOf(source: FeedSourceView): FeedSourceDraft {
  const s = source.schedule
  return {
    sourceId: source.id,
    pluginName: source.pluginName,
    name: source.name,
    instruction: source.instruction,
    freqKind: s.kind,
    intervalMin: s.kind === 'interval' ? s.minutes : 30,
    time: s.kind === 'daily' || s.kind === 'weekly' ? s.time : '09:00',
    weekdays: s.kind === 'weekly' ? [...s.weekdays] : [1, 2, 3, 4, 5],
    cron: s.kind === 'cron' ? s.expression : '*/30 * * * *',
  }
}

export function scheduleFromDraft(draft: FeedSourceDraft, timeZone = localTimeZone()): FeedSourceSchedule {
  if (draft.freqKind === 'interval') return { kind: 'interval', minutes: draft.intervalMin, timeZone }
  if (draft.freqKind === 'daily') return { kind: 'daily', time: draft.time, timeZone }
  if (draft.freqKind === 'weekly') return { kind: 'weekly', weekdays: [...draft.weekdays], time: draft.time, timeZone }
  return { kind: 'cron', expression: draft.cron.trim(), timeZone }
}

export function isSourceDraftDirty(draft: FeedSourceDraft | null, source: FeedSourceView): boolean {
  if (!draft || draft.sourceId !== source.id) return false
  const base = feedSourceDraftOf(source)
  return draft.name !== base.name
    || draft.instruction !== base.instruction
    || draft.freqKind !== base.freqKind
    || (draft.freqKind === 'interval' && draft.intervalMin !== base.intervalMin)
    || ((draft.freqKind === 'daily' || draft.freqKind === 'weekly') && draft.time !== base.time)
    || (draft.freqKind === 'weekly' && JSON.stringify(draft.weekdays) !== JSON.stringify(base.weekdays))
    || (draft.freqKind === 'cron' && draft.cron.trim() !== base.cron.trim())
}

/** The page's groups: new items, plugin data sources, schedules, seen items. */
export function feedGroups(state: State): { fresh: FeedItemView[], sources: FeedSourceView[], next: ScheduleView[], seen: FeedItemView[] } {
  const items = itemsOf(state)
  return {
    fresh: items.filter((item) => item.seenAt === null),
    sources: [...sourcesOf(state)],
    next: schedulesOf(state).toSorted(nextOrder),
    seen: items.filter((item) => item.seenAt !== null).slice(0, SEEN_LISTED),
  }
}

/** The title bar's count: new items, waiting to be looked at. */
export const feedCount = (state: State): number => feedGroups(state).fresh.length

/** The one shown on the right: the one picked while it is listed, else the first new item, else none. */
export function feedShown(state: State): FeedShown | null {
  const { fresh, sources, next, seen } = feedGroups(state)
  const picked = state.feed.selected as FeedPick | null
  if (picked?.kind === 'new-source') return { kind: 'new-source' }
  if (picked?.kind === 'source') {
    const source = sources.find((item) => item.id === picked.id)
    if (source) return { kind: 'source', source }
  }
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

const withFeed = (state: State, changes: Partial<State['feed']>): State => ({ ...state, feed: { ...state.feed, ...changes } })
const pickOf = (kind: unknown, id: unknown): FeedPick | null => {
  if (kind === 'new-source') return { kind: 'new-source', id: NEW_SOURCE_ID }
  if ((kind === 'item' || kind === 'schedule' || kind === 'source') && typeof id === 'string') return { kind, id }
  return null
}

export const FEED_ACTIONS = {
  feed_open: (state, { kind, id }) => withFeed({ ...state, island: false }, { open: true, selected: pickOf(kind, id) ?? state.feed.selected }),
  feed_close: (state) => withFeed(state, { open: false }),
  feed_select: (state, { kind, id }) => {
    const selected = pickOf(kind, id)
    let draft = state.feed.draft as FeedSourceDraft | null
    if (selected?.kind === 'source') {
      const found = sourcesOf(state).find((source) => source.id === selected.id)
      if (found && draft?.sourceId !== found.id) draft = feedSourceDraftOf(found)
    }
    return withFeed(state, { selected, draft, error: null, notice: null })
  },
  feed_source_new: (state, { pluginName }) => withFeed(state, {
    selected: { kind: 'new-source', id: NEW_SOURCE_ID },
    draft: emptyFeedSourceDraft(pluginName ?? ''),
    error: null,
    notice: null,
  }),
  feed_source_draft: (state, { changes }) => {
    const base = (state.feed.draft as FeedSourceDraft | null) ?? emptyFeedSourceDraft()
    return withFeed(state, { draft: { ...base, ...changes }, error: null, notice: null })
  },
  feed_source_running: (state, { id }) => withFeed(state, { runningSourceId: id ?? null, error: null, notice: null }),
  feed_source_notice: (state, { message }) => withFeed(state, { notice: message ?? null }),
  feed_loaded: (state, { items, schedules, sources, select, resetDraft }) => {
    const nextSources = Array.isArray(sources) ? sources : sourcesOf(state)
    const selected = select ? pickOf(select.kind, select.id) : (state.feed.selected as FeedPick | null)
    let draft = state.feed.draft as FeedSourceDraft | null
    if (selected?.kind === 'source') {
      const found = nextSources.find((source) => source.id === selected.id)
      if (found && (resetDraft || draft?.sourceId !== found.id)) draft = feedSourceDraftOf(found)
    }
    return withFeed(state, {
      ...(Array.isArray(items) ? { items } : {}),
      ...(Array.isArray(schedules) ? { schedules } : {}),
      ...(Array.isArray(sources) ? { sources } : {}),
      selected,
      draft,
      busy: false,
      error: null,
    })
  },
  feed_busy: (state) => withFeed(state, { busy: true, error: null }),
  feed_failed: (state, { message }) => withFeed(state, { busy: false, runningSourceId: null, error: typeof message === 'string' ? message : null }),
} satisfies ActionHandlers
