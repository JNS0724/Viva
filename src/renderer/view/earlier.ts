import { earlierRows, formatListTime, workspaceName, type EarlierRow } from '../selectors.ts'
import { isBusy } from '../state.ts'
import { topicBlocks, topicStart } from '../topics.ts'
import { h } from './dom.ts'
import { markMessage, pastMessageView } from './thread.ts'
import { reconcileChildren } from './reconcile.ts'

/**
 * The earlier part of the one timeline, above the conversation on screen: a line for each day, a line where
 * the working directory changed, and the messages, read-only, in topics (topics.js). A topic the assistant no
 * longer has is a step quieter, its head says so, and it can be taken up again; where the topic on screen
 * starts, a line says so. More comes in when the user scrolls up to the top, or asks for it with the button there.
 */
const NEW_TOPIC_NOTE = '助手从这里重新开始，不带上面的内容；关于你的记忆照常'
const BACK_NOTE = '助手接着那个话题的内容聊，中间的不记得'

type RowOf<K extends EarlierRow['kind']> = Extract<EarlierRow, { kind: K }>
type TopicBlock = ReturnType<typeof topicBlocks>[number]
type Options = { now: number, busy: boolean }

function workdirLine(row: RowOf<'workdir'>) {
  return h('div', { class: 'timeline-workdir', role: 'separator', title: row.cwd },
    h('span', { class: 'timeline-workdir-ico', 'aria-hidden': 'true', text: '📁' }),
    ...(row.continues
      ? [h('span', { text: '换到 ' }), h('b', { text: workspaceName(row.cwd) }), h('span', { text: ' 目录 · 接着聊' })]
      : [h('span', { text: '工作目录换成 ' }), h('b', { text: workspaceName(row.cwd) }), h('span', { class: 'timeline-workdir-path mono', text: row.cwd })]))
}

const ROW_VIEWS: { [K in EarlierRow['kind']]: (row: RowOf<K>, handlers: Handlers) => View } = {
  day: (row) => h('div', { class: 'timeline-day', role: 'separator', text: row.label }),
  workdir: (row) => workdirLine(row),
  message: (row, handlers) => markMessage(pastMessageView(row, handlers), row.id),
}
const rowView = (row: EarlierRow, handlers: Handlers) => (ROW_VIEWS[row.kind] as (row: EarlierRow, handlers: Handlers) => View)(row, handlers)
const rowViews = (rows: readonly EarlierRow[], handlers: Handlers): View[] => rows.flatMap((row) => rowView(row, handlers))
const topicTime = (at: number | null, now: number) => (at ? formatListTime(at, now) : '')

/** An earlier topic the assistant no longer has: quieter, and 回到这个话题 takes it up again from its last segment. */
function oldTopic(block: TopicBlock, views: View[], handlers: Handlers, { now, busy }: Options) {
  return h('div', { class: 'topic-old' },
    h('div', { class: 'topic-head' },
      h('b', { text: `话题 · ${topicTime(block.at, now)}` }),
      h('span', { text: `${block.count} 条 · 助手不记得这段` }),
      h('button', {
        class: 'topic-back', type: 'button', disabled: busy, title: busy ? '等这一轮结束再回去' : null, text: '回到这个话题',
        onClick: () => handlers.resumeTopic(block.segments.at(-1)?.id),
      })),
    ...views)
}

/** Where the topic on screen starts: a new one (undoable until something is said), or back to an earlier one. */
function startLine(start: ReturnType<typeof topicStart>, handlers: Handlers, { now, busy }: Options): View[] {
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
 * @param state the renderer state (its `earlier` slice, the topic and the current directory)
 * @param handlers loadEarlier, and resumeTopic (segmentId)
 */
type BlockView = { inputs: unknown[], views: View[] }
const earlierViews = new WeakMap<HTMLElement, { inputs: unknown[], nodes: (Node | string)[], blocks: Map<string, BlockView>, rows: WeakMap<EarlierRow, View> }>()

export function updateEarlierControls(container: HTMLElement, state: State) {
  const busy = isBusy(state) || state.switching
  for (const button of container.querySelectorAll<HTMLButtonElement>('.topic-back')) {
    button.disabled = busy
    button.title = busy ? '等这一轮结束再回去' : ''
  }
}

export function renderEarlier(container: HTMLElement, state: State, handlers: Handlers, now = Date.now()) {
  const inputs = [state.earlier, state.info.cwd, state.topic.parentId]
  const cached = earlierViews.get(container)
  if (cached && inputs.every((value, i) => cached.inputs[i] === value)) {
    reconcileChildren(container, [...cached.nodes, ...startLine(topicStart(state), handlers, { now, busy: isBusy(state) || state.switching })].filter((view): view is Node | string => Boolean(view)))
    updateEarlierControls(container, state)
    return
  }
  const { earlier } = state
  const { parentId } = state.topic
  const last = earlier.segments.at(-1)
  const rows = earlierRows(earlier, { currentCwd: state.info.cwd || null, now, currentContinues: Boolean(last && parentId === last.id) })
  const blocks = topicBlocks(earlier.segments, parentId)
  const blockOf = new Map(blocks.flatMap((block, i) => block.segments.map((segment) => [segment.id, i])))
  const grouped: EarlierRow[][] = blocks.map(() => [])
  const tail: EarlierRow[] = []
  for (const row of rows) {
    const i = row.segment === null ? undefined : blockOf.get(row.segment)
    if (i === undefined) tail.push(row)
    else grouped[i].push(row)
  }
  const options = { now, busy: isBusy(state) || state.switching }
  const more = earlier.hasMore && earlier.segments.length > 0
    ? h('button', { class: 'timeline-more', type: 'button', disabled: earlier.loading, text: earlier.loading ? '正在读取…' : '更早的对话', onClick: () => handlers.loadEarlier() })
    : null
  const rowCache = cached?.rows ?? new WeakMap<EarlierRow, View>()
  const cachedRows = (rows: readonly EarlierRow[]) => rows.flatMap((row) => {
    if (!rowCache.has(row)) rowCache.set(row, rowView(row, handlers))
    return rowCache.get(row)!
  })
  const blockCache = new Map<string, BlockView>()
  const views = blocks.flatMap((block, i) => {
    const key = String(block.segments[0].id)
    // Segment identity covers message changes; boundary rows cover prepended history and directory dividers.
    const inputs = [block.remembered, grouped[i][0], grouped[i].at(-1), grouped[i].length, formatListTime(block.at ?? 0, now), ...block.segments]
    const previous = cached?.blocks.get(key)
    const hit = previous && inputs.length === previous.inputs.length && inputs.every((input, j) => input === previous.inputs[j])
    const views = hit ? previous.views : block.remembered ? cachedRows(grouped[i]) : [oldTopic(block, cachedRows(grouped[i]), handlers, options)]
    blockCache.set(key, { inputs, views })
    return views
  })
  container.hidden = rows.length === 0
  const nodes = [more, ...views, ...rowViews(tail, handlers)].filter((view): view is Node | string => Boolean(view))
  earlierViews.set(container, { inputs, nodes, blocks: blockCache, rows: rowCache })
  reconcileChildren(container, [...nodes, ...startLine(topicStart(state), handlers, options)].filter((view): view is Node | string => Boolean(view)))
  updateEarlierControls(container, state)
}
