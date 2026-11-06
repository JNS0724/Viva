import { continueText, type FeedItemView } from './feed-state.ts'

/**
 * 动态 from the window: its items and schedules loaded, an item taken into the conversation (在对话里继续: into the
 * input, for the user to read and send) or let go (不用了), a schedule paused, resumed or deleted by hand.
 */
export function createFeedActions({ api, getState, dispatch, errorMessage, fillComposer }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'> & {
  /** Puts `text` in the input, the conversation in front. */
  fillComposer: (text: string) => void
}) {
  const fail = (err: unknown) => dispatch({ type: 'feed_failed', message: errorMessage(err) })

  async function loadFeed() {
    try {
      const [items, schedules] = await Promise.all([api.listFeed(), api.listSchedules()])
      dispatch({ type: 'feed_loaded', items, schedules })
    } catch (err) {
      fail(err)
    }
  }

  /** One change at a time; then 动态 as it is now. */
  async function change(request: () => Promise<unknown>) {
    if (getState().feed.busy) return
    dispatch({ type: 'feed_busy' })
    try {
      await request()
      await loadFeed()
    } catch (err) {
      fail(err)
    }
  }

  const itemOf = (id: string): FeedItemView | undefined => (getState().feed.items as readonly FeedItemView[]).find((item) => item.id === id)

  return {
    loadFeed,
    /** Looked at and taken on: into the input, and no longer new. */
    async continueItem(id: string) {
      const item = itemOf(id)
      if (!item) return
      fillComposer(continueText(item))
      if (item.seenAt === null) await change(() => api.markFeedSeen(id))
    },
    dismissItem: (id: string) => change(() => api.markFeedSeen(id)),
    pauseSchedule: (id: string, paused: boolean) => change(() => api.pauseSchedule(id, paused)),
    deleteSchedule: (id: string) => change(() => api.deleteSchedule(id)),
  }
}
