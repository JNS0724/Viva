import type { ReaderEdge, ReaderMessage } from './review-state.ts'
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
/** How many messages are read on at a time, at either end of what is read (review-state.ts READER_MAX keeps it bounded). */
const READ_ON = 30

/** A message named by a hit, a link or a star. */
export type MessageRef = MessagePlace & { messageId?: number }
type Read = { title: string, at: number | null, head: string | null, total: number, from: number, messages: ReaderMessage[] }
type ReadRequest = { from?: number, around?: { segmentId: string, seq: number }, count?: number, whole?: boolean }

const titleFrom = (messages: readonly ReaderMessage[]) => {
  const first = messages.find((message) => message.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? ''
  return first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS)}…` : first
}

export function createReviewActions({ api, getState, dispatch, showToast, errorMessage, reveal, keepPlace = (change) => change() }: Pick<ActionDeps, 'getState' | 'dispatch' | 'errorMessage'> & {
  api: Pick<AgentApi, 'reviewTimeline' | 'readHistory' | 'locateMessage' | 'starMessage' | 'starsIn' | 'starredMessages'>,
  showToast: (text: string, options?: { action?: ToastAction | null, ms?: number }) => void,
  /** Scrolls to a message read in 回顾 (its `data-msg`). False when it is not there. */
  reveal: (msgId: string) => boolean,
  /** Makes a change to what is read with the message being looked at staying where it is on screen. */
  keepPlace?: (change: () => void) => void,
}) {
  const report = (what: string) => (err: unknown) => showToast(`${what}：${errorMessage(err)}`)
  let starsAsked = ''
  /** Counts the lists asked for: an answer to any but the latest is out of date (another filter, the page opened again). */
  let asked = 0

  /**
   * A page of topics for the filter shown. A first page is always asked for, even while another answer is on its
   * way, and only the latest one asked for is kept: switching 全部 → 带文件 quickly never shows the 全部 list under
   * 带文件, nor goes on from its last topic. A next page waits for the one on its way.
   */
  async function loadReview(fresh: boolean) {
    const { review } = getState()
    if (!fresh && (review.loading || !review.hasMore)) return
    const mine = ++asked
    dispatch({ type: 'review_loading' })
    try {
      // The next page goes on after the last topic listed: its time and id, as others may share that moment.
      const last = fresh ? undefined : review.topics.at(-1)
      const filter = review.filter === 'tasks' || review.filter === 'files' ? review.filter : 'all'
      const page = await api.reviewTimeline(last ? { lastAt: last.lastAt, topicId: last.id } : null, filter)
      if (mine !== asked) return
      dispatch({ type: 'review_loaded', topics: page.topics, hasMore: page.hasMore, fresh })
    } catch (err) {
      if (mine !== asked) return
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

  /**
   * A part of what `key` holds (a topic's conversation, or a segment on its own; `whole`, with the talk it shares),
   * read from where it is kept (history-reader.ts): its name and when it began, and the messages asked for.
   */
  async function fetchRead(key: string, request: ReadRequest = {}): Promise<Read | null> {
    const part = await api.readHistory(key, request)
    if (!part) return null
    const messages = part.messages as ReaderMessage[]
    const named = part.topic ? { title: part.topic.title, at: part.topic.startedAt, head: part.topic.head }
      : { title: titleFrom(messages), at: messages[0]?.at ?? null, head: null }
    return { ...named, total: part.total, from: part.from, messages }
  }

  async function readKey(key: string) {
    try {
      const read = await fetchRead(key, { from: 0 })
      if (!read) return showToast('这段记录已经删除了')
      dispatch({ type: 'review_read', key, messages: read.messages, from: read.from, total: read.total })
    } catch (err) {
      report('这段记录读不出来')(err)
    }
    return undefined
  }

  /**
   * More of what is open, read on at one end as the user comes near it; past READER_MAX as many are let go at the
   * other end (review-state.ts readOn), the message being looked at staying where it is.
   */
  async function readMore(edge: ReaderEdge) {
    const reading = getState().review.reading
    if (!reading || reading.loading) return
    const end = reading.from + reading.messages.length
    const from = edge === 'before' ? Math.max(0, reading.from - READ_ON) : end
    const count = edge === 'before' ? reading.from - from : Math.min(READ_ON, reading.total - end)
    if (count <= 0) return
    dispatch({ type: 'review_read_loading', key: reading.key, edge })
    try {
      const part = await api.readHistory(reading.key, { from, count })
      keepPlace(() => dispatch({ type: 'review_read_more', key: reading.key, edge, part }))
    } catch (err) {
      dispatch({ type: 'review_read_more', key: reading.key, edge, part: null })
      report('这段记录读不出来')(err)
    }
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
      // The part around the message, however far into a long topic it is.
      const around = located.seq === null ? undefined : { segmentId: located.segmentId, seq: located.seq }
      let read = await fetchRead(key, around ? { around } : { from: 0 })
      // A star or link on the talk a moved turn shares with the conversation: read that segment whole.
      if (read && located.status === 'found' && !read.messages.some((m) => m.segmentId === located.segmentId && m.seq === located.seq)) {
        read = await fetchRead(key, { around, whole: true })
      }
      if (!read) return showToast('这条记录已经删除了')
      const notice = located.status === 'found' ? null : located.seq === null ? NOTICE_EMPTY : NOTICE_MISSING
      const msgId = located.seq === null ? null : `${located.segmentId}-${located.seq}`
      const found = located.status === 'found' ? msgId : null
      dispatch({ type: 'review_focus', key, title: read.title, at: read.at, head: read.head, found, notice })
      dispatch({ type: 'review_read', key, messages: read.messages, from: read.from, total: read.total })
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
    readerMore: readMore,
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
