/** Read-only views over the state: status copy, trace rows, file/web lists, formatting. */

const TOOL_TONE: Readonly<Record<string, string>> = { pending: 'pending', in_progress: 'working', completed: 'done', failed: 'error' }
const ACTIVE_STATUSES = new Set(['pending', 'in_progress'])
const DETAIL_LIMIT = 280
const JSON_LIMIT = 160
const EVENT_LIMIT = 32

const pad = (n: number) => String(n).padStart(2, '0')

export function truncate(text: unknown, limit: number): string {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

const KB = 1024

/** Such as 248 KB. */
export function formatSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / KB / KB).toFixed(1)} MB`
}

/** mm:ss */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

export const formatHM = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
export const formatClock = (ts: number) => {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function greeting(date: Date): string {
  const hour = date.getHours()
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function workspaceName(cwd: string | null | undefined): string {
  return String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || '—'
}

/** What gets saved: finished messages only, in the shape the main process stores. */
export const historyMessages = (state: State) => state.messages
  .filter((m) => !m.open)
  .map(({ role, text, receipt, images }) => ({ role, text, receipt: receipt ?? null, ...(images?.length ? { images } : {}) }))

const DAY_MS = 86_400_000
const startOfDay = (ts: number) => new Date(ts).setHours(0, 0, 0, 0)
/** Whole calendar days between `ts` and `now` (0 = today). */
const daysAgo = (ts: number, now: number) => Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS)

/** Short time for a history row: 09:05 today, 昨天, 9月1日 this year, 2025/12/31 before. */
export function formatListTime(ts: number, now = Date.now()): string {
  const date = new Date(ts)
  const days = daysAgo(ts, now)
  if (days <= 0) return formatHM(date)
  if (days === 1) return '昨天'
  if (date.getFullYear() === new Date(now).getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function formatSavedAt(ts: number, now: number) {
  const date = new Date(ts)
  const sameDay = date.toDateString() === new Date(now).toDateString()
  return `${sameDay ? '今天' : `${date.getMonth() + 1}月${date.getDate()}日`} ${formatHM(date)}`
}

/** Divider shown under last launch's messages, or null when the thread did not start from history. */
export function restoredNote(state: State, now = Date.now()): { when: string, memory: string } | null {
  if (!state.restored) return null
  const { remembersHistory } = state.info
  const memory = remembersHistory === undefined
    ? ''
    : remembersHistory ? '助手记得这些内容，可以接着聊' : '上次的会话没能恢复，助手已不记得这些内容'
  return { when: formatSavedAt(state.restored.savedAt, now), memory }
}

/** What the window calls the app's own working directory. */
export const DEFAULT_DIR_NAME = 'Viva 的文件'

/**
 * The working-directory menu (the chip under the input): the folder in use first, then the others used lately,
 * then the app's own folder when it is in neither. Each with the name shown and its full path.
 * @param workDir workdir-state.js
 */
export function workDirMenu({ current, defaultDir, recent }: { current: string | null, defaultDir: string | null, recent: readonly string[] }): Array<{ dir: string, name: string, current: boolean, isDefault: boolean }> {
  const dirs = [current, ...recent.filter((dir) => dir !== current)]
  if (defaultDir && !dirs.includes(defaultDir)) dirs.push(defaultDir)
  return dirs.filter((dir): dir is string => Boolean(dir)).map((dir) => ({
    dir, name: dir === defaultDir ? DEFAULT_DIR_NAME : workspaceName(dir), current: dir === current, isDefault: dir === defaultDir,
  }))
}

/** The day a part of the timeline is from: 今天, 昨天, 9 月 21 日, or with the year before this one. */
function timelineDay(ts: number, now: number) {
  const days = daysAgo(ts, now)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  const date = new Date(ts)
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()} 年 ${day}`
}

/** A row of the earlier timeline: a day, a change of working directory, or a message; each names its segment. */
export type EarlierRow = { segment: string | null } & (
  | { kind: 'day', label: string }
  | { kind: 'workdir', cwd: string, continues: boolean }
  | { kind: 'message', id: string, role: string, text: string, receipt: Receipt | null, images?: Array<{ id: string }> }
)

/**
 * The earlier part of the one timeline as the window shows it, top to bottom: a line for each new day, a line
 * where the working directory changed (also before the current part, when it is in another one), and the messages.
 * Each row names the segment it belongs to (null: the line before the current part), so the view can group them
 * by topic (topics.js); a directory line says whether the conversation went on there (`continues`).
 * @param earlier earlier-state.js
 */
export function earlierRows(earlier: State['earlier'], { currentCwd = null, now = Date.now(), currentContinues = false }: {
  currentCwd?: string | null, now?: number, currentContinues?: boolean,
} = {}): EarlierRow[] {
  const rows: EarlierRow[] = []
  let lastDay: string | null = null
  let lastCwd: string | null = null
  earlier.segments.forEach((segment, i) => {
    const continues = i > 0 && segment.parentId === earlier.segments[i - 1].id
    if (segment.cwd && lastCwd && segment.cwd !== lastCwd) rows.push({ kind: 'workdir', cwd: segment.cwd, continues, segment: segment.id })
    lastCwd = segment.cwd ?? lastCwd
    for (const message of segment.messages) {
      const day = timelineDay(message.at, now)
      if (day !== lastDay) rows.push({ kind: 'day', label: day, segment: segment.id })
      lastDay = day
      rows.push({
        kind: 'message', id: `${segment.id}-${message.seq}`, role: message.role, text: message.text, receipt: message.receipt,
        segment: segment.id, ...(message.images ? { images: message.images } : {}),
      })
    }
  })
  if (currentCwd && lastCwd && currentCwd !== lastCwd) rows.push({ kind: 'workdir', cwd: currentCwd, continues: currentContinues, segment: null })
  return rows
}

function compactJson(value: unknown) {
  if (value === null || value === undefined) return ''
  try {
    return truncate(typeof value === 'string' ? value : JSON.stringify(value), JSON_LIMIT)
  } catch {
    return '[无法显示的参数]'
  }
}

const urlOf = (tool: ToolCall) => tool.rawInput?.url ?? tool.rawInput?.query ?? ''
const firstPath = (tool: ToolCall) => tool.locations?.[0]?.path ?? ''

export function toolDetail(tool: ToolCall): string {
  const target = firstPath(tool) || urlOf(tool) || compactJson(tool.rawInput)
  return [tool.kind, target].filter(Boolean).join(' · ')
}

function latestActiveTool(state: State): ToolCall | null {
  for (let i = state.timeline.length - 1; i >= 0; i -= 1) {
    const entry = state.timeline[i]
    const tool = entry.kind === 'tool' ? state.tools[entry.ref] : null
    if (tool && ACTIVE_STATUSES.has(tool.status ?? '')) return tool
  }
  return null
}

/** What the agent is doing right now, in a few words: the running tool, or replying, or thinking. */
export function currentAction(state: State): string {
  const active = latestActiveTool(state)
  if (active) return active.title
  return state.messages[state.messages.length - 1]?.open ? '正在回复' : '正在思考'
}

function workingEvent(state: State, now: number) {
  const what = currentAction(state)
  return state.turn ? `${truncate(what, EVENT_LIMIT)} · ${formatElapsed(now - state.turn.startedAt)}` : what
}

/** What the cat (view/cat.js) is doing: thinking, typing (a tool runs or the answer is being written), holding
 * up a ! or ? sign while it waits on the user, pleased once a turn is done, worried after an error. */
export type CatMood = 'idle' | 'thinking' | 'typing' | 'confirm' | 'ask' | 'done' | 'error' | 'sleeping'

export function catMood(state: State): CatMood {
  if (state.phase === 'waiting') return 'confirm'
  if (state.phase === 'asking') return 'ask'
  if (state.phase === 'error') return 'error'
  if (state.phase === 'working') return latestActiveTool(state) || state.messages.at(-1)?.open ? 'typing' : 'thinking'
  // Nothing of the user's going, and background preparation at work: the cat sleeps on it.
  if (state.followups?.state?.running) return 'sleeping'
  if (state.lastReceipt && state.lastReceipt.stopReason !== 'cancelled') return 'done'
  return 'idle'
}

/** What waits on the user is headed alike wherever it shows: the thread's card, the island, the status (prompt-card.js). */
export const PROMPT_HEADS = Object.freeze({ permission: '需要你确认', question: '需要你回答', secret: '需要你填写' })

/** Copy and tone for the avatar/status island. */
export function statusView(state: State, now = Date.now()): { tone: string, label: string, event: string } {
  if (state.phase === 'waiting') return { tone: 'waiting', label: PROMPT_HEADS.permission, event: truncate(state.permission?.title, EVENT_LIMIT) }
  if (state.phase === 'asking') return { tone: 'waiting', label: PROMPT_HEADS.question, event: truncate(state.question?.questions[0]?.question, EVENT_LIMIT) }
  if (state.phase === 'working') return { tone: 'working', label: '工作中', event: workingEvent(state, now) }
  if (state.phase === 'error') return { tone: 'error', label: '出错', event: truncate(state.error, EVENT_LIMIT) }
  if (state.info.mode === 'connecting') return { tone: 'pending', label: '连接中', event: 'DEEPSEEK HARNESS' }
  if (state.info.mode === 'setup') return { tone: 'pending', label: '未连接', event: state.info.problem === 'no-dsh' ? '未安装 DSH' : '需要配置模型' }
  if (state.lastReceipt) {
    const stopped = state.lastReceipt.stopReason === 'cancelled'
    return { tone: stopped ? 'idle' : 'done', label: stopped ? '已停止' : '已完成', event: formatElapsed(state.lastReceipt.ms) }
  }
  return { tone: 'idle', label: '空闲', event: state.info.model || '' }
}

/** One-line receipt under an answer, e.g. "用时 42 秒 · 3 次工具". */
export function receiptLine(receipt: Receipt): string {
  const seconds = Math.max(1, Math.round(receipt.ms / 1000))
  return [
    receipt.stopReason === 'cancelled' ? '已停止' : `用时 ${seconds} 秒`,
    receipt.tools ? `${receipt.tools} 次工具` : '',
  ].filter(Boolean).join(' · ')
}

const FIXED_REASONS: Readonly<Record<string, string>> = {
  first: '画像、偏好和记忆规则（会话开始时）',
  changed: '更新后的画像和偏好',
  compacted: '画像、偏好和记忆规则（对话压缩后重新带上）',
}

/** A trace row: a title, what it was about, and its tone. */
export type TraceRow = { title: string, detail: string, tone: string }

/** One trace row for what the memory plugin sent: why the profile went along, and which memories and why. */
export function memoryTrace(injection: { fixed?: string | null, pushed?: ReadonlyArray<{ names: string[], text: string }> }): TraceRow {
  const lines = [
    injection.fixed ? FIXED_REASONS[injection.fixed] ?? '画像和偏好' : '',
    ...(injection.pushed ?? []).map((item) => `因为提到「${item.names.join('、')}」：${item.text}`),
  ].filter(Boolean)
  return { title: '带上记忆', detail: truncate(lines.join('\n'), DETAIL_LIMIT), tone: 'done' }
}

/** The app's own tools that say something to the user, said plainly in the trace. */
const NAMED_TOOLS: Readonly<Record<string, (tool: ToolCall) => { title: string, detail: string }>> = {
  // The agent saying a job will take long (plugins/steer/lib/offer.js), with its reason.
  viva_offer_background: (tool) => ({ title: '提议放到后台', detail: truncate(String(tool.rawInput?.why ?? ''), DETAIL_LIMIT) }),
}

/** A timeline entry: what happened, which thing of the state it refers to, and when. */
type TimelineEntry = State['timeline'][number]

const TRACE_BUILDERS: Readonly<Record<string, (state: State, entry: TimelineEntry) => TraceRow | null | undefined>> = {
  memory: (_state, entry) => memoryTrace(entry.injection),
  thought: (state, entry) => {
    const thought = state.thoughts.find((t) => t.id === entry.ref)
    return thought && { title: '思考', detail: truncate(thought.text, DETAIL_LIMIT), tone: 'think' }
  },
  tool: (state, entry) => {
    const tool = state.tools[entry.ref]
    if (!tool) return null
    const named = NAMED_TOOLS[tool.title]?.(tool)
    return { title: named?.title ?? tool.title, detail: named ? named.detail : toolDetail(tool), tone: TOOL_TONE[tool.status ?? ''] ?? 'pending' }
  },
  permission: (_state, entry) => ({ title: '请求你确认', detail: entry.title, tone: 'waiting' }),
  question: (_state, entry) => ({ title: '向你提问', detail: entry.title, tone: 'waiting' }),
  answer: (_state, entry) => (entry.answered
    ? { title: '你的回答', detail: entry.title, tone: 'done' }
    : { title: '问题未回答', detail: entry.title, tone: 'idle' }),
  secret: (_state, entry) => ({ title: '请你填写密钥', detail: entry.title, tone: 'waiting' }),
  secret_answer: (_state, entry) => (entry.provided
    ? { title: '你填写了密钥', detail: entry.title, tone: 'done' }
    : { title: '没有填写密钥', detail: entry.title, tone: 'idle' }),
  decision: (_state, entry) => ({
    title: entry.allowed ? `你选择了「${entry.choice}」` : `未授权 · ${entry.choice}`,
    detail: entry.title,
    tone: entry.allowed ? 'done' : 'idle',
  }),
}

/** Rows for the drawer's 过程 tab, oldest first. */
export function traceItems(state: State): Array<TraceRow & { key: string, time: string }> {
  return state.timeline.flatMap((entry, index) => {
    const item = TRACE_BUILDERS[entry.kind]?.(state, entry)
    return item ? [{ key: `${entry.kind}-${entry.ref}-${index}`, time: formatClock(entry.at), ...item }] : []
  })
}

const toolsInOrder = (state: State) =>
  state.timeline.filter((e) => e.kind === 'tool').map((e) => state.tools[e.ref]).filter(Boolean)

/** Unique file paths the agent touched, last action wins. */
export function fileItems(state: State) {
  const byPath: Record<string, { path: string, kind: string, tone: string }> = toolsInOrder(state)
    .flatMap((tool) => (tool.locations ?? []).map((loc): [string, { path: string, kind: string, tone: string }] => [
      loc.path, { path: loc.path, kind: tool.kind ?? '', tone: TOOL_TONE[tool.status ?? ''] ?? 'pending' },
    ]))
    .reduce((acc, [path, item]) => ({ ...acc, [path]: item }), {})
  return Object.values(byPath).map((item) => ({ ...item, name: workspaceName(item.path) }))
}

/** What the confirmation card shows of the tool's arguments: a command as itself, anything else pretty-printed. */
export function permissionDetail(permission: { rawInput?: Record<string, unknown> | null } | null | undefined): string {
  if (!permission?.rawInput) return ''
  const { command } = permission.rawInput
  if (typeof command === 'string' && Object.keys(permission.rawInput).length === 1) return truncate(command, 600)
  try {
    return truncate(JSON.stringify(permission.rawInput, null, 2), 600)
  } catch {
    return '[无法显示的参数]'
  }
}

export function modeLine(info: AgentInfo): string {
  if (info.mode === 'live') return 'DeepSeek Harness · ACP'
  if (info.mode === 'setup') return '未连接'
  return '连接中…'
}

/** What the home card and composer say while the agent cannot start. */
export type SetupCopy = { title: string, body: string, action: string | null, placeholder: string }

const SETUP_COPY: Readonly<Record<string, SetupCopy>> = {
  'no-key': {
    title: '连接模型',
    body: '填写 DeepSeek API key，或在设置里添加其他模型，就能开始。key 用系统钥匙串加密保存，只留在这台电脑上。',
    action: '去设置',
    placeholder: '先配置模型才能发送…',
  },
  'no-dsh': {
    title: '没有找到 DeepSeek Harness',
    body: '助手依赖的 dsh 没有安装完整。请在项目目录运行 npm install，然后重新打开应用。',
    action: null,
    placeholder: '需要先安装 DeepSeek Harness…',
  },
}

/** What the home card and composer say while the agent cannot start, or null when it can. */
export const setupView = (info: AgentInfo): SetupCopy | null => (info.mode === 'setup' ? SETUP_COPY[info.problem ?? ''] ?? SETUP_COPY['no-key'] : null)

export function usageLabel(usage: { used: number, size: number } | null | undefined): string {
  if (!usage?.size) return ''
  return `上下文已用 ${Math.round((usage.used / usage.size) * 100)}%`
}
