import { earlierRows, formatListTime, workspaceName } from '../selectors.js'
import { isBusy } from '../state.js'
import { topicBlocks, topicStart } from '../topics.js'
import { h } from './dom.js'
import { markMessage, pastMessageView } from './thread.js'

/**
 * The earlier part of the one timeline, above the conversation on screen: a line for each day, a line where
 * the working directory changed, and the messages, read-only, in topics (topics.js). A topic the assistant no
 * longer has is a step quieter, its head says so, and it can be taken up again; where the topic on screen
 * starts, a line says so. More comes in when the user scrolls up to the top, or asks for it with the button there.
 */
const NEW_TOPIC_NOTE = '助手从这里重新开始，不带上面的内容；关于你的记忆照常'
const BACK_NOTE = '助手接着那个话题的内容聊，中间的不记得'

function workdirLine(row) {
  return h('div', { class: 'timeline-workdir', role: 'separator', title: row.cwd },
    h('span', { class: 'timeline-workdir-ico', 'aria-hidden': 'true', text: '📁' }),
    ...(row.continues
      ? [h('span', { text: '换到 ' }), h('b', { text: workspaceName(row.cwd) }), h('span', { text: ' 目录 · 接着聊' })]
      : [h('span', { text: '工作目录换成 ' }), h('b', { text: workspaceName(row.cwd) }), h('span', { class: 'timeline-workdir-path mono', text: row.cwd })]))
}

const ROW_VIEWS = {
  day: (row) => h('div', { class: 'timeline-day', role: 'separator', text: row.label }),
  workdir: (row) => workdirLine(row),
  message: (row, handlers) => markMessage(pastMessageView(row, handlers), row.id),
}
const rowViews = (rows, handlers) => rows.flatMap((row) => ROW_VIEWS[row.kind](row, handlers))
const topicTime = (at, now) => (at ? formatListTime(at, now) : '')

/** An earlier topic the assistant no longer has: quieter, and 回到这个话题 takes it up again from its last segment. */
function oldTopic(block, rows, handlers, { now, busy }) {
  return h('div', { class: 'topic-old' },
    h('div', { class: 'topic-head' },
      h('b', { text: `话题 · ${topicTime(block.at, now)}` }),
      h('span', { text: `${block.count} 条 · 助手不记得这段` }),
      h('button', {
        class: 'topic-back', type: 'button', disabled: busy, title: busy ? '等这一轮结束再回去' : null, text: '回到这个话题',
        onClick: () => handlers.resumeTopic(block.segments.at(-1).id),
      })),
    ...rowViews(rows, handlers))
}

/** Where the topic on screen starts: a new one (undoable until something is said), or back to an earlier one. */
function startLine(start, handlers, { now, busy }) {
  if (!start) return []
  const when = topicTime(start.at, now)
  if (start.kind === 'back') {
    return [h('div', { class: 'topic-start', role: 'separator' }, `回到 话题 · ${when}`), h('div', { class: 'topic-note', text: BACK_NOTE })]
  }
  return [
    h('div', { class: 'topic-start', role: 'separator' }, '新话题', when ? h('time', { text: when }) : null,
      start.undo ? h('button', { class: 'topic-back', type: 'button', disabled: busy, text: '撤销', onClick: () => handlers.resumeTopic(start.undo) }) : null),
    h('div', { class: 'topic-note', text: NEW_TOPIC_NOTE }),
  ]
}

/**
 * @param {HTMLElement} container
 * @param {object} state the renderer state (its `earlier` slice, the topic and the current directory)
 * @param {{ loadEarlier: () => void, resumeTopic: (segmentId: string) => void }} handlers
 */
export function renderEarlier(container, state, handlers, now = Date.now()) {
  const { earlier } = state
  const { parentId } = state.topic
  const last = earlier.segments.at(-1)
  const rows = earlierRows(earlier, { currentCwd: state.info.cwd || null, now, currentContinues: Boolean(last && parentId === last.id) })
  const blocks = topicBlocks(earlier.segments, parentId)
  const blockOf = new Map(blocks.flatMap((block, i) => block.segments.map((segment) => [segment.id, i])))
  const grouped = blocks.map((_, i) => rows.filter((row) => row.segment !== null && blockOf.get(row.segment) === i))
  const tail = rows.filter((row) => row.segment === null)
  const options = { now, busy: isBusy(state) }
  const more = earlier.hasMore && earlier.segments.length > 0
    ? h('button', { class: 'timeline-more', type: 'button', disabled: earlier.loading, text: earlier.loading ? '正在读取…' : '更早的对话', onClick: () => handlers.loadEarlier() })
    : null
  const views = blocks.flatMap((block, i) => (block.remembered ? rowViews(grouped[i], handlers) : [oldTopic(block, grouped[i], handlers, options)]))
  container.hidden = rows.length === 0
  container.replaceChildren(...[more, ...views, ...rowViews(tail, handlers), ...startLine(topicStart(state), handlers, options)].filter(Boolean))
}
