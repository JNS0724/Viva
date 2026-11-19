import { t } from '../shared/i18n/translate.ts'
import type { FeedSourceCreateInput, FeedSourceUpdateInput } from '../shared/feed-source.ts'
import type { FeedItemView, FeedPick } from './feed-state.ts'

/**
 * 动态 from the window: its items, plugin data sources and schedules loaded; an item taken into the conversation
 * (在对话里继续) or let go (不用了); a schedule paused, resumed or deleted; a plugin data source added, edited,
 * paused, deleted or run immediately.
 */
export function createFeedActions({ api, getState, dispatch, errorMessage, fillComposer, loadPlugins }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'> & {
  /** Puts `text` in the input, the conversation in front. */
  fillComposer: (text: string, feedItemId: string) => void
  /** Loads installed dsh plugins when opening the data source form. */
  loadPlugins?: () => Promise<unknown>
}) {
  const fail = (err: unknown) => dispatch({ type: 'feed_failed', message: errorMessage(err) })
  let query = 0

  async function loadFeed(options?: { select?: FeedPick | null, resetDraft?: boolean }) {
    const request = ++query
    try {
      const [items, schedules, sources] = await Promise.all([
        api.listFeed(),
        api.listSchedules(),
        typeof api.listFeedSources === 'function' ? api.listFeedSources() : Promise.resolve([]),
      ])
      if (request === query) dispatch({ type: 'feed_loaded', items, schedules, sources, select: options?.select, resetDraft: options?.resetDraft })
    } catch (err) {
      if (request === query) fail(err)
    }
  }

  /** One change at a time; then 动态 as it is now. */
  async function change(request: () => Promise<unknown>, after?: (result: unknown) => { select?: FeedPick | null, resetDraft?: boolean, notice?: string | null } | void) {
    if (getState().feed.busy) return
    dispatch({ type: 'feed_busy' })
    try {
      const result = await request()
      const opts = after?.(result) ?? undefined
      await loadFeed(opts ? { select: opts.select, resetDraft: opts.resetDraft } : undefined)
      if (opts?.notice) dispatch({ type: 'feed_source_notice', message: opts.notice })
    } catch (err) {
      fail(err)
    }
  }

  const itemOf = (id: string): FeedItemView | undefined => (getState().feed.items as readonly FeedItemView[]).find((item) => item.id === id)

  return {
    loadFeed,
    erased(ids: readonly string[]) {
      query++
      dispatch({ type: 'feed_erased', ids })
      return loadFeed()
    },
    /** Looked at and taken on: into the input, and no longer new. */
    async continueItem(id: string) {
      const item = itemOf(id)
      if (!item) return
      await change(async () => {
        const origin = getState().conversationId
        const text = await api.continueFeed(id)
        if (getState().conversationId !== origin || getState().newTopicPending || !getState().feed.open
          || getState().feed.erasedIds.includes(id) || !itemOf(id)) return
        fillComposer(text, id)
        if (item.seenAt === null) await api.markFeedSeen(id)
      })
    },
    dismissItem: (id: string) => change(() => api.markFeedSeen(id)),
    pauseSchedule: (id: string, paused: boolean) => change(() => api.pauseSchedule(id, paused)),
    deleteSchedule: (id: string) => change(() => api.deleteSchedule(id)),
    async openNewSource() {
      if (loadPlugins) {
        try { await loadPlugins() } catch { /* plugin view handles disconnected state */ }
      }
      const plugins = (getState().plugins?.plugins ?? []) as ReadonlyArray<{ name: string, enabled: boolean }>
      const firstEnabled = plugins.find((plugin) => plugin.enabled)?.name ?? ''
      dispatch({ type: 'feed_source_new', pluginName: firstEnabled })
    },
    createSource: (input: FeedSourceCreateInput) => change(
      () => api.createFeedSource(input as unknown as Record<string, unknown>),
      (created) => {
        const view = created as { id?: string } | undefined
        return view?.id ? { select: { kind: 'source', id: view.id }, resetDraft: true } : undefined
      },
    ),
    updateSource: (id: string, changes: FeedSourceUpdateInput) => change(
      () => api.updateFeedSource(id, changes as unknown as Record<string, unknown>),
      () => ({ resetDraft: true, notice: t('feed.source.saved') }),
    ),
    pauseSource: (id: string, paused: boolean) => change(() => api.pauseFeedSource(id, paused)),
    deleteSource: (id: string) => change(() => api.deleteFeedSource(id), () => ({ select: null })),
    async runSourceNow(id: string) {
      if (getState().feed.runningSourceId || getState().feed.busy) return
      dispatch({ type: 'feed_source_running', id })
      try {
        const result = await api.runFeedSourceNow(id)
        dispatch({ type: 'feed_source_running', id: null })
        await loadFeed()
        if (result.status === 'published') {
          dispatch({ type: 'feed_source_notice', message: t('feed.source.run.published', { count: result.publishedCount }) })
        } else if (result.status === 'skipped') {
          dispatch({ type: 'feed_source_notice', message: t('feed.source.run.skipped') })
        } else if (result.message) {
          dispatch({ type: 'feed_failed', message: result.message })
        }
      } catch (err) {
        fail(err)
      }
    },
  }
}
