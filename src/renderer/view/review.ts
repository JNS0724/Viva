import { REVIEW_FILTERS, reviewDays, reviewTopics, shownTopics, type ReviewTopic } from '../review-state.ts'
import { formatListTime } from '../selectors.ts'
import { h } from './dom.ts'
import { markMessage, pastMessageView } from './thread.ts'

/**
 * 回顾: the 搜索 page with nothing typed (view/history-panel.ts). The timeline by month and day, newest first, a
 * topic a line (its first question, turns, time, files, stars); a topic opens in place to read, with 回到这个话题;
 * filtered to background tasks, topics with files, or the starred messages. More comes in at the bottom.
 */
const FILTER_NAMES: Readonly<Record<string, string>> = { all: '全部', tasks: '后台任务', files: '带文件', stars: '收藏' }
const EMPTY: Readonly<Record<string, string>> = {
  all: '还没有聊过什么。',
  tasks: '这段时间没有交给后台的事。',
  files: '这段时间没有带文件或图片的话题。',
}
const SPEAKERS: Readonly<Record<string, string>> = { user: '你', assistant: 'Viva' }

const hint = (text: string) => h('div', { class: 'history-hint', text })
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)

function filterBar(filter: string, handlers: Handlers) {
  return h('div', { class: 'review-filters', role: 'group', 'aria-label': '筛选' },
    REVIEW_FILTERS.map((key) => h('button', {
      class: 'review-filter', type: 'button', 'aria-pressed': String(filter === key), text: FILTER_NAMES[key],
      onClick: () => handlers.reviewFilter(key),
    })))
}

/** A topic opened: its messages as they were, each with its star; 回到这个话题 for a conversation. */
function reader(topic: ReviewTopic, review: State['review'], handlers: Handlers) {
  const messages = review.reading?.key === topic.key ? review.reading.messages : null
  return h('div', { class: 'review-reader' },
    messages === null ? hint('正在读取…') : messages.map((message: SegmentMessage & { segmentId: string }) =>
      markMessage(pastMessageView(message as unknown as ThreadMessage, handlers), `${message.segmentId}-${message.seq}`)),
    topic.kind === 'talk' ? h('div', { class: 'review-reader-actions' },
      h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '回到这个话题', onClick: () => handlers.resumeFromReview(topic.key) })) : null)
}

function topicItem(topic: ReviewTopic, review: State['review'], handlers: Handlers) {
  const open = review.open === topic.key
  const marks = [topic.hasFiles ? '带文件' : null, topic.stars ? `★ ${topic.stars}` : null].filter(Boolean).join(' · ')
  return h('li', { class: 'review-topic', 'data-open': String(open) },
    h('button', { class: 'review-row', type: 'button', 'aria-expanded': String(open), onClick: () => handlers.reviewOpen(topic.key) },
      topic.kind === 'task' ? h('span', { class: 'review-kind', text: '后台' }) : null,
      h('b', { class: 'review-title', text: topic.title || '（没有提问）' }),
      marks ? h('span', { class: 'review-marks', text: marks }) : null,
      h('span', { class: 'review-meta mono', text: `${topic.turns} 轮 · ${clock(topic.at)}` })),
    open ? reader(topic, review, handlers) : null)
}

function topicList(review: State['review'], handlers: Handlers, now: number): View[] {
  if (!review.loaded) return [hint('正在读取…')]
  const topics = shownTopics(reviewTopics(review.segments), review.filter)
  const months = reviewDays(topics, now).map((month) => h('section', { class: 'review-month' },
    h('h3', { class: 'review-month-head', text: month.label }),
    month.days.map((day) => h('div', { class: 'review-day' },
      h('div', { class: 'review-day-head', text: day.label }),
      h('ul', { class: 'review-items' }, day.topics.map((topic) => topicItem(topic, review, handlers)))))))
  const more = review.hasMore
    ? h('button', { class: 'timeline-more', type: 'button', disabled: review.loading, text: review.loading ? '正在读取…' : '更早的', onClick: () => handlers.reviewMore() })
    : topics.length ? hint('再往前就没有了') : null
  return [...(months.length ? months : [hint(EMPTY[review.filter] ?? EMPTY.all)]), more]
}

/** The starred messages, newest star first: who said it, when, in which topic; 详情 goes to it in the timeline. */
function starredList(review: State['review'], handlers: Handlers, now: number): View[] {
  if (review.starred === null) return [hint('正在读取…')]
  if (!review.starred.length) return [hint('还没有收藏。把鼠标移到一条消息上，点旁边的 ☆。')]
  return [h('ul', { class: 'review-items review-stars' }, review.starred.map((item: { segmentId: string, seq: number, role: string, text: string, at: number, title: string }) =>
    h('li', { class: 'review-star' },
      h('span', { class: 'history-meta mono' }, h('b', { class: 'history-title', text: SPEAKERS[item.role] ?? '记录' }), `${formatListTime(item.at, now)} · ${item.title}`),
      h('div', { class: 'review-star-text', text: item.text }),
      h('div', { class: 'review-star-actions' },
        h('button', { class: 'btn btn-text btn-small', type: 'button', text: '取消收藏', onClick: () => handlers.toggleStar({ segmentId: item.segmentId, seq: item.seq }, false) }),
        h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '详情 →', onClick: () => handlers.jumpToHit({ segmentId: item.segmentId, seq: item.seq }) })))))]
}

export function reviewView(state: State, handlers: Handlers, now = Date.now()): View[] {
  const { review } = state
  return [filterBar(review.filter, handlers), ...(review.filter === 'stars' ? starredList(review, handlers, now) : topicList(review, handlers, now))]
}
