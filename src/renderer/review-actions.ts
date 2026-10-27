import { reviewTopics } from './review-state.ts'
import type { MessagePlace } from './stars.ts'

/**
 * 回顾 (review-state.ts, view/review.ts): reading the timeline back by time, a page at a time; a topic read in
 * place; the 收藏 list; and stars put on or taken off anywhere, with the stars of what is on screen read back.
 */
/** How many more pages 详情 reads back looking for a starred message's topic before it says where it is not. */
const MAX_FIND_PAGES = 20

export function createReviewActions({ api, getState, dispatch, showToast, errorMessage, reveal }: Pick<ActionDeps, 'getState' | 'dispatch' | 'errorMessage'> & {
  api: Pick<AgentApi, 'reviewTimeline' | 'segmentMessages' | 'starMessage' | 'starsIn' | 'starredMessages'>,
  showToast: (text: string) => void,
  /** Scrolls to a message of the topic read in 回顾 (its `data-msg`) and marks it a moment. */
  reveal: (msgId: string) => boolean,
}) {
  const report = (what: string) => (err: unknown) => showToast(`${what}：${errorMessage(err)}`)
  let starsAsked = ''

  async function loadReview(fresh: boolean) {
    const { review } = getState()
    if (review.loading || (!fresh && !review.hasMore)) return
    dispatch({ type: 'review_loading' })
    try {
      // The next page goes on after the last segment listed, not after its time: others may share that moment.
      const after = fresh ? undefined : review.segments.at(-1)?.id
      const page = await api.reviewTimeline(after)
      dispatch({ type: 'review_loaded', segments: page.segments, hasMore: page.hasMore, fresh })
    } catch (err) {
      dispatch({ type: 'review_failed' })
      report('回顾读取失败')(err)
    }
  }

  async function loadStarred() {
    try {
      dispatch({ type: 'review_starred', items: await api.starredMessages() })
    } catch (err) {
      report('收藏读取失败')(err)
    }
  }

  /** The messages of a topic opened to read, its segments one after another, each message with where it is kept. */
  async function readTopic(key: string) {
    const topic = reviewTopics(getState().review.segments).find((item) => item.key === key)
    if (!topic) return
    try {
      const parts = await Promise.all(topic.segments.map(async (segment) => {
        const { messages } = await api.segmentMessages(segment.id)
        return messages.map((message: SegmentMessage) => ({ ...message, segmentId: segment.id }))
      }))
      dispatch({ type: 'review_read', key, messages: parts.flat() })
    } catch (err) {
      report('这个话题读不出来')(err)
    }
  }

  return {
    /** The page opened (or opened again): the newest first, and the 收藏 list when that is what it shows. */
    refreshReview() {
      loadReview(true)
      if (getState().review.filter === 'stars') loadStarred()
    },
    reviewMore: () => loadReview(false),
    reviewFilter(filter: string) {
      dispatch({ type: 'review_filter', filter })
      if (filter === 'stars') loadStarred()
    },
    reviewOpen(key: string) {
      const opening = getState().review.open !== key
      dispatch({ type: 'review_open', key })
      if (opening) readTopic(key)
    },
    /**
     * 详情 on a starred message: its topic opened in 回顾 and the message marked. Read here rather than in the
     * timeline, which has neither background tasks nor what is older than a few pages.
     */
    async openStarred(place: MessagePlace) {
      dispatch({ type: 'review_filter', filter: 'all' })
      if (!getState().review.loaded) await loadReview(true)
      const topicOf = () => reviewTopics(getState().review.segments).find((topic) => topic.segments.some((segment) => segment.id === place.segmentId))
      for (let page = 0; !topicOf() && getState().review.hasMore && page < MAX_FIND_PAGES; page += 1) await loadReview(false)
      const topic = topicOf()
      if (!topic) return showToast('这条消息已经不在回顾里了')
      if (getState().review.open !== topic.key) {
        dispatch({ type: 'review_open', key: topic.key })
        await readTopic(topic.key)
      }
      if (!reveal(`${place.segmentId}-${place.seq}`)) showToast('这条消息已经不在这个话题里了')
      return undefined
    },
    async toggleStar(place: MessagePlace, starred: boolean) {
      try {
        const changed = await api.starMessage(place.segmentId, place.seq, starred)
        dispatch({ type: 'star_changed', ...place, starred, changed })
      } catch (err) {
        report(starred ? '没能收藏' : '没能取消收藏')(err)
      }
    },
    /** After a render: the stars of the segments now shown, read once for each set of them. */
    refreshStars(segmentIds: readonly string[]) {
      const ids = [...new Set(segmentIds.filter(Boolean))]
      const asked = ids.join(',')
      if (!ids.length || asked === starsAsked) return
      starsAsked = asked
      api.starsIn(ids).then((places) => dispatch({ type: 'stars_loaded', places }))
        .catch((err) => console.error('[stars] could not read the stars back:', errorMessage(err)))
    },
  }
}
