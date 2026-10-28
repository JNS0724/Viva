import type { ReaderMessage } from './review-state.ts'
import type { MessagePlace } from './stars.ts'

/**
 * 回顾 (review-state.ts, view/review.ts): the topics a page at a time; a topic or a task read in place; a message
 * named by a search hit, a link or a star read where it is kept (history-db.ts locate: straight there, however far
 * back); the 收藏 list; and stars put on or taken off anywhere, with the stars of what is on screen read back.
 * Reading never touches the agent: the conversation and its directory stay as they are.
 */
const NOTICE_MISSING = '原文已经不在了（可能被重新生成或撤回），下面是附近的记录'
const NOTICE_EMPTY = '原文已经不在了，这段记录里也没有别的内容'
const RETRY_MS = 8000
const TITLE_CHARS = 40

/** A message named by a hit, a link or a star. */
export type MessageRef = MessagePlace & { messageId?: number }
type Read = { title: string, at: number | null, head: string | null, messages: ReaderMessage[] }

const titleFrom = (messages: readonly ReaderMessage[]) => {
  const first = messages.find((message) => message.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? ''
  return first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS)}…` : first
}

export function createReviewActions({ api, getState, dispatch, showToast, errorMessage, reveal }: Pick<ActionDeps, 'getState' | 'dispatch' | 'errorMessage'> & {
  api: Pick<AgentApi, 'reviewTimeline' | 'topicMessages' | 'segmentMessages' | 'locateMessage' | 'starMessage' | 'starsIn' | 'starredMessages'>,
  showToast: (text: string, options?: { action?: ToastAction | null, ms?: number }) => void,
  /** Scrolls to a message read in 回顾 (its `data-msg`). False when it is not there. */
  reveal: (msgId: string) => boolean,
}) {
  const report = (what: string) => (err: unknown) => showToast(`${what}：${errorMessage(err)}`)
  let starsAsked = ''

  async function loadReview(fresh: boolean) {
    const { review } = getState()
    if (review.loading || (!fresh && !review.hasMore)) return
    dispatch({ type: 'review_loading' })
    try {
      // The next page goes on after the last topic listed: its time and id, as others may share that moment.
      const last = fresh ? undefined : review.topics.at(-1)
      const filter = review.filter === 'tasks' || review.filter === 'files' ? review.filter : 'all'
      const page = await api.reviewTimeline(last ? { lastAt: last.lastAt, topicId: last.id } : null, filter)
      dispatch({ type: 'review_loaded', topics: page.topics, hasMore: page.hasMore, fresh })
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

  /** What `key` holds to read: a topic's conversation, or a segment on its own (`whole`, with the talk it shares). */
  async function fetchRead(key: string, whole = false): Promise<Read | null> {
    if (key.startsWith('t:')) {
      const found = await api.topicMessages(key.slice(2))
      return found && { title: found.topic.title, at: found.topic.startedAt, head: found.topic.head, messages: found.messages }
    }
    const segmentId = key.slice(2)
    const { messages } = await api.segmentMessages(segmentId, whole)
    const read = messages.map((message: SegmentMessage) => ({ ...message, segmentId }))
    return { title: titleFrom(read), at: read[0]?.at ?? null, head: null, messages: read }
  }

  async function readKey(key: string) {
    try {
      const read = await fetchRead(key)
      if (!read) return showToast('这段记录已经删除了')
      dispatch({ type: 'review_read', key, messages: read.messages })
    } catch (err) {
      report('这段记录读不出来')(err)
    }
    return undefined
  }

  /**
   * A message named by a search hit, a link or a star, read in 回顾 at the top: its topic (or its task) read
   * straight from where it is kept, and the message marked. Not there any more: the messages near where it was,
   * said so, none marked; its segment deleted: said so. A read that failed says that, apart, with 重试.
   */
  async function openRef(ref: MessageRef) {
    try {
      const located = await api.locateMessage(ref.messageId === undefined
        ? { segmentId: ref.segmentId, seq: ref.seq } : { segmentId: ref.segmentId, seq: ref.seq, messageId: ref.messageId })
      if (located.status === 'deleted') return showToast('这条记录已经删除了')
      const { key } = located.reader
      let read = await fetchRead(key)
      // A star or link on the talk a moved turn shares with the conversation: read that segment whole.
      if (read && located.status === 'found' && !read.messages.some((m) => m.segmentId === located.segmentId && m.seq === located.seq)) {
        read = await fetchRead(key, true)
      }
      if (!read) return showToast('这条记录已经删除了')
      const notice = located.status === 'found' ? null : located.seq === null ? NOTICE_EMPTY : NOTICE_MISSING
      const msgId = located.seq === null ? null : `${located.segmentId}-${located.seq}`
      const found = located.status === 'found' ? msgId : null
      dispatch({ type: 'review_focus', key, title: read.title, at: read.at, head: read.head, found, notice })
      dispatch({ type: 'review_read', key, messages: read.messages })
      if (msgId !== null && !reveal(msgId) && found) showToast('这条消息找到了，但没能显示出来')
    } catch (err) {
      showToast(`读取失败：${errorMessage(err)}`, { action: { label: '重试', kind: 'open-ref', payload: ref }, ms: RETRY_MS })
    }
    return undefined
  }

  return {
    /** The page opened (or opened again): the newest first, and the 收藏 list when that is what it shows. */
    refreshReview() {
      loadReview(true)
      if (getState().review.filter === 'stars') loadStarred()
    },
    reviewMore: () => loadReview(false),
    reviewFilter(filter: string) {
      const before = getState().review.filter
      dispatch({ type: 'review_filter', filter })
      if (filter === 'stars') loadStarred()
      else if (getState().review.filter !== before) loadReview(true)
    },
    /** A topic of the list or one of its tasks (review-state.ts topicKey, segmentKey) opened to read, or closed. */
    reviewOpen(key: string) {
      const { open, focus } = getState().review
      dispatch({ type: 'review_open', key })
      if (open !== key || focus !== null) readKey(key)
    },
    reviewCloseFocus: () => dispatch({ type: 'review_unfocus' }),
    openRef,
    /** 详情 on a starred message: read where it is kept, marked (a star names its place; its id says it is still it). */
    openStarred: (place: MessageRef) => openRef(place),
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
