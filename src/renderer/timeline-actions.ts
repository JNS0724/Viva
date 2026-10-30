/**
 * The one timeline in the window: reading back the segments before the one on screen, a page at a time, when
 * the window opens and as the user scrolls up to the top. What the user was looking at stays where it was as
 * the page goes in above it.
 */
import { reachedRecentEnd } from './earlier-state.ts'

const NEAR_TOP_PX = 160

export function createTimelineActions({ api, getState, dispatch, scroll }: Pick<ActionDeps, 'getState' | 'dispatch'> & {
  api: Pick<AgentApi, 'earlierSegments'>, scroll: HTMLElement,
}) {
  /** Segments are read before the oldest shown; at first, before the one on screen (or all, for a new one). */
  const anchor = () => getState().earlier.segments[0]?.id ?? getState().conversationId ?? 'current'

  async function loadEarlier() {
    const { earlier } = getState()
    if (earlier.loading || !earlier.hasMore) return
    dispatch({ type: 'earlier_loading' })
    try {
      const page = await api.earlierSegments(anchor())
      const height = scroll.scrollHeight
      const top = scroll.scrollTop
      dispatch({ type: 'earlier_loaded', segments: page.segments, hasMore: page.hasMore })
      scroll.scrollTop = top + (scroll.scrollHeight - height)
    } catch (err: any) {
      console.error('[timeline] could not read the earlier conversation:', err.message)
      dispatch({ type: 'earlier_failed' })
    }
  }

  /** Scrolled up to the top, the next page comes in by itself, as far back as the recent days (earlier-state.ts). */
  function onScroll() {
    if (scroll.scrollTop < NEAR_TOP_PX && !reachedRecentEnd(getState().earlier)) loadEarlier()
  }

  return { loadEarlier, onScroll }
}
