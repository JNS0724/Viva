/**
 * The one timeline in the window: reading back the segments before the one on screen, a page at a time, when
 * the window opens and as the user scrolls up to the top. What the user was looking at stays where it was as
 * the page goes in above it.
 */
import { reachedRecentEnd } from './earlier-state.ts'
import { hitTarget } from './timeline-search.ts'

const NEAR_TOP_PX = 160
/** A hit further back than this many pages is not worth the wait; the search says where it is instead. */
const MAX_JUMP_PAGES = 40

export function createTimelineActions({ api, getState, dispatch, scroll, reveal }: Pick<ActionDeps, 'getState' | 'dispatch'> & {
  api: Pick<AgentApi, 'earlierSegments'>, scroll: HTMLElement, reveal: (msgId: string) => void,
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

  /** A search hit: earlier pages come in until it is there, then it is scrolled to. False when it is nowhere. */
  async function jumpTo(hit: SearchHit) {
    for (let page = 0; page <= MAX_JUMP_PAGES; page += 1) {
      const target = hitTarget(getState(), hit)
      if (!target) return false
      if ('msgId' in target) {
        reveal(target.msgId)
        return true
      }
      const before = getState().earlier.segments.length
      await loadEarlier()
      if (getState().earlier.segments.length === before) return false
    }
    return false
  }

  return { loadEarlier, onScroll, jumpTo }
}
