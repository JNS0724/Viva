import { reachedRecentEnd } from '../earlier-state.ts'
import { earlierRows, formatListTime, workspaceName, type EarlierRow } from '../selectors.ts'
import { isBusy } from '../state.ts'
import { rowPlace } from '../stars.ts'
import { topicBlocks, topicStart, topicTitle, turnsOf } from '../topics.ts'
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
/** Its own session gone: a new conversation, the topic's latest turns going with the first question as records. */
const carriedNote = (turns: number) => `原来的会话已经接不上，这是新对话；会带上这个话题最近 ${turns} 轮记录，仅供助手参考`

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

const messagesOf = (block: TopicBlock) => block.segments.flatMap((segment) => segment.messages)

/**
 * How many messages an earlier topic opened in place draws at most: its latest. The rest of a long one is read in
 * 回顾, a part at a time.
 */
export const OPENED_TOPIC_MAX = 100

/** What a folded topic draws once opened, kept by its element: it is drawn then, not before (see oldTopic). */
const fillers = new WeakMap<HTMLDetailsElement, () => void>()

/** The rows an opened topic draws: its latest OPENED_TOPIC_MAX messages, with a line to read the rest in 回顾. */
function openedRows(rows: readonly EarlierRow[], handlers: Handlers, cachedRows: (rows: readonly EarlierRow[]) => View[]): View[] {
  const messages = rows.filter((row): row is RowOf<'message'> => row.kind === 'message')
  if (messages.length <= OPENED_TOPIC_MAX) return cachedRows(rows)
  const first = messages[messages.length - OPENED_TOPIC_MAX]
  const hidden = messages.length - OPENED_TOPIC_MAX
  // Read in 回顾 from the last one not drawn here, so reading on there goes on from where this part starts.
  const place = rowPlace(messages[hidden - 1].id)
  return [
    h('button', {
      class: 'timeline-more topic-rest', type: 'button', text: `这个话题前面还有 ${hidden} 条，在回顾里看 →`,
      onClick: () => place && handlers.jumpToHit(place),
    }),
    ...cachedRows(rows.slice(rows.indexOf(first))),
  ]
}

/**
 * An earlier topic the assistant no longer has: folded to one line (its first question, how many turns, when),
 * opened in place; 回到这个话题 takes it up again from its last segment. Folded, its messages are not drawn: they are
 * drawn when it is first opened (by hand, or by openEarlierRow to show a message in it).
 */
function oldTopic(block: TopicBlock, build: () => View[], handlers: Handlers, { now, busy }: Options) {
  const messages = messagesOf(block)
  const title = topicTitle(messages)
  const when = topicTime(block.at, now)
  const body = h('div', { class: 'topic-body' })
  let drawn = false
  const fill = () => {
    if (drawn) return
    drawn = true
    body.replaceChildren(...[build()].flat(2).filter((view): view is Node | string => Boolean(view)))
  }
  const fold = h('details', {
    class: 'topic-old', 'data-title': `${when} · ${title}`, 'data-segments': block.segments.map((segment) => segment.id).join(' '),
    onToggle: (event: Event) => { if ((event.currentTarget as HTMLDetailsElement).open) fill() },
  },
    h('summary', { class: 'topic-head', title: '助手不记得这段，点开看全文' },
      h('b', { class: 'topic-title', text: title }),
      // The day is on the line above it; the line itself says when in the day.
      h('span', { class: 'topic-meta mono', text: `${turnsOf(messages)} 轮 · ${new Date(block.at ?? 0).toTimeString().slice(0, 5)}` }),
      h('button', {
        class: 'topic-back', type: 'button', disabled: busy, title: busy ? '等这一轮结束再回去' : null, text: '回到这个话题',
        onClick: (event: MouseEvent) => {
          // A button in the folded line: it takes the topic up, it does not open or close it.
          event.preventDefault()
          handlers.resumeTopic(block.segments.at(-1)?.id)
        },
      }),
      h('span', { class: 'topic-chevron', 'aria-hidden': 'true' })),
    body) as HTMLDetailsElement
  fillers.set(fold, fill)
  return fold
}

/**
 * The row of a message in the earlier part (its `data-msg`, `<segment>-<seq>`), the folded topic it is in opened
 * and drawn first; null when it is not drawn there (not read back, or past the part an opened topic draws).
 */
export function openEarlierRow(container: HTMLElement, msgId: string): HTMLElement | null {
  const selector = `[data-msg="${CSS.escape(msgId)}"]`
  const drawn = container.querySelector<HTMLElement>(selector)
  if (drawn) {
    // Drawn in a topic opened before and closed again: open it, or the row is there but not seen.
    const fold = drawn.closest<HTMLDetailsElement>('details.topic-old')
    if (fold) fold.open = true
    return drawn
  }
  const segmentId = msgId.slice(0, msgId.lastIndexOf('-'))
  const fold = [...container.querySelectorAll<HTMLDetailsElement>('details.topic-old')]
    .find((el) => (el.dataset.segments ?? '').split(' ').includes(segmentId))
  if (!fold) return null
  fillers.get(fold)?.()
  fold.open = true
  return container.querySelector<HTMLElement>(selector)
}

/** The day a folded topic began stays outside it, so the folded lines still read by day. */
const leadingDay = (rows: readonly EarlierRow[]) => (rows[0]?.kind === 'day' ? 1 : 0)

/** Where the topic on screen starts: a new one (undoable until something is said), or back to an earlier one. */
function startLine(start: ReturnType<typeof topicStart>, handlers: Handlers, { now, busy }: Options): View[] {
  if (!start) return []
  const when = topicTime(start.at, now)
  if (start.kind === 'back') {
    const note = start.carried === null ? BACK_NOTE : carriedNote(start.carried)
    return [h('div', { class: 'topic-start', role: 'separator' }, `回到 话题 · ${when}`), h('div', { class: 'topic-note', text: note })]
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
  // Scrolling up reads back the recent part only; what is older is read in 回顾 (view/review.ts), by day.
  const more = !earlier.hasMore || earlier.segments.length === 0 ? null
    : reachedRecentEnd(earlier, now)
      ? h('button', { class: 'timeline-more', type: 'button', text: '更早的记录在回顾里 →', onClick: () => handlers.openReview() })
      : h('button', { class: 'timeline-more', type: 'button', disabled: earlier.loading, text: earlier.loading ? '正在读取…' : '更早的对话', onClick: () => handlers.loadEarlier() })
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
    const day = leadingDay(grouped[i])
    const views = hit ? previous.views : block.remembered
      ? cachedRows(grouped[i])
      : [...cachedRows(grouped[i].slice(0, day)), oldTopic(block, () => openedRows(grouped[i].slice(day), handlers, cachedRows), handlers, options)]
    blockCache.set(key, { inputs, views })
    return views
  })
  container.hidden = rows.length === 0
  const nodes = [more, ...views, ...rowViews(tail, handlers)].filter((view): view is Node | string => Boolean(view))
  earlierViews.set(container, { inputs, nodes, blocks: blockCache, rows: rowCache })
  reconcileChildren(container, [...nodes, ...startLine(topicStart(state), handlers, options)].filter((view): view is Node | string => Boolean(view)))
  updateEarlierControls(container, state)
}
