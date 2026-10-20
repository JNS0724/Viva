/** Read-only views over the state: status copy, trace rows, file/web lists, formatting. */

const TOOL_TONE = { pending: 'pending', in_progress: 'working', completed: 'done', failed: 'error' }
const ACTIVE_STATUSES = new Set(['pending', 'in_progress'])
const DETAIL_LIMIT = 280
const JSON_LIMIT = 160
const EVENT_LIMIT = 32

const pad = (n) => String(n).padStart(2, '0')

export function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

const KB = 1024

/** @param {number} bytes @returns {string} such as 248 KB */
export function formatSize(bytes) {
  if (bytes < KB) return `${bytes} B`
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / KB / KB).toFixed(1)} MB`
}

/** @param {number} ms @returns {string} mm:ss */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

export const formatHM = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
export const formatClock = (ts) => {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function greeting(date) {
  const hour = date.getHours()
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function workspaceName(cwd) {
  return String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || '—'
}

/** What gets saved: finished messages only, in the shape the main process stores. */
export const historyMessages = (state) => state.messages
  .filter((m) => !m.open)
  .map(({ role, text, receipt }) => ({ role, text, receipt: receipt ?? null }))

const DAY_MS = 86_400_000
const WEEK_DAYS = 7
const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0)
/** Whole calendar days between `ts` and `now` (0 = today). */
const daysAgo = (ts, now) => Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS)

/** Short time for a history row: 09:05 today, 昨天, 9月1日 this year, 2025/12/31 before. */
export function formatListTime(ts, now = Date.now()) {
  const date = new Date(ts)
  const days = daysAgo(ts, now)
  if (days <= 0) return formatHM(date)
  if (days === 1) return '昨天'
  if (date.getFullYear() === new Date(now).getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function groupLabel(item, now) {
  if (item.pinned) return '置顶'
  const days = daysAgo(item.updatedAt, now)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return days < WEEK_DAYS ? '7 天内' : '更早'
}

/** History rows grouped for the panel; empty groups are left out, order is kept. */
export function historyGroups(items, now = Date.now()) {
  return items.reduce((groups, item) => {
    const label = groupLabel(item, now)
    const last = groups[groups.length - 1]
    return last?.label === label
      ? [...groups.slice(0, -1), { ...last, items: [...last.items, item] }]
      : [...groups, { label, items: [item] }]
  }, [])
}

function formatSavedAt(ts, now) {
  const date = new Date(ts)
  const sameDay = date.toDateString() === new Date(now).toDateString()
  return `${sameDay ? '今天' : `${date.getMonth() + 1}月${date.getDate()}日`} ${formatHM(date)}`
}

/** Divider shown under last launch's messages, or null when the thread did not start from history. */
export function restoredNote(state, now = Date.now()) {
  if (!state.restored) return null
  const { remembersHistory } = state.info
  const memory = remembersHistory === undefined
    ? ''
    : remembersHistory ? '助手记得这些内容，可以接着聊' : '上次的会话没能恢复，助手已不记得这些内容'
  return { when: formatSavedAt(state.restored.savedAt, now), memory }
}

function compactJson(value) {
  if (value === null || value === undefined) return ''
  try {
    return truncate(typeof value === 'string' ? value : JSON.stringify(value), JSON_LIMIT)
  } catch {
    return '[无法显示的参数]'
  }
}

const urlOf = (tool) => tool.rawInput?.url ?? tool.rawInput?.query ?? ''
const firstPath = (tool) => tool.locations?.[0]?.path ?? ''

export function toolDetail(tool) {
  const target = firstPath(tool) || urlOf(tool) || compactJson(tool.rawInput)
  return [tool.kind, target].filter(Boolean).join(' · ')
}

function latestActiveTool(state) {
  for (let i = state.timeline.length - 1; i >= 0; i -= 1) {
    const entry = state.timeline[i]
    const tool = entry.kind === 'tool' ? state.tools[entry.ref] : null
    if (tool && ACTIVE_STATUSES.has(tool.status)) return tool
  }
  return null
}

/** What the agent is doing right now, in a few words: the running tool, or replying, or thinking. */
export function currentAction(state) {
  const active = latestActiveTool(state)
  if (active) return active.title
  return state.messages[state.messages.length - 1]?.open ? '正在回复' : '正在思考'
}

function workingEvent(state, now) {
  const what = currentAction(state)
  return state.turn ? `${truncate(what, EVENT_LIMIT)} · ${formatElapsed(now - state.turn.startedAt)}` : what
}

/**
 * What the cat (view/cat.js) is doing: thinking, typing (a tool runs or the answer is being written), holding
 * up a ! or ? sign while it waits on the user, pleased once a turn is done, worried after an error.
 * @returns {'idle' | 'thinking' | 'typing' | 'confirm' | 'ask' | 'done' | 'error'}
 */
export function catMood(state) {
  if (state.phase === 'waiting') return 'confirm'
  if (state.phase === 'asking') return 'ask'
  if (state.phase === 'error') return 'error'
  if (state.phase === 'working') return latestActiveTool(state) || state.messages.at(-1)?.open ? 'typing' : 'thinking'
  if (state.lastReceipt && state.lastReceipt.stopReason !== 'cancelled') return 'done'
  return 'idle'
}

/** Copy and tone for the avatar/status island. */
export function statusView(state, now = Date.now()) {
  if (state.phase === 'waiting') return { tone: 'waiting', label: '等待你确认', event: truncate(state.permission?.title, EVENT_LIMIT) }
  if (state.phase === 'asking') return { tone: 'waiting', label: '等你回答', event: truncate(state.question?.questions[0]?.question, EVENT_LIMIT) }
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
export function receiptLine(receipt) {
  const seconds = Math.max(1, Math.round(receipt.ms / 1000))
  return [
    receipt.stopReason === 'cancelled' ? '已停止' : `用时 ${seconds} 秒`,
    receipt.tools ? `${receipt.tools} 次工具` : '',
  ].filter(Boolean).join(' · ')
}

const FIXED_REASONS = {
  first: '画像、偏好和记忆规则（会话开始时）',
  changed: '更新后的画像和偏好',
  compacted: '画像、偏好和记忆规则（对话压缩后重新带上）',
}

/** One trace row for what the memory plugin sent: why the profile went along, and which memories and why. */
export function memoryTrace(injection) {
  const lines = [
    injection.fixed ? FIXED_REASONS[injection.fixed] ?? '画像和偏好' : '',
    ...(injection.pushed ?? []).map((item) => `因为提到「${item.names.join('、')}」：${item.text}`),
  ].filter(Boolean)
  return { title: '带上记忆', detail: truncate(lines.join('\n'), DETAIL_LIMIT), tone: 'done' }
}

const TRACE_BUILDERS = {
  memory: (_state, entry) => memoryTrace(entry.injection),
  thought: (state, entry) => {
    const thought = state.thoughts.find((t) => t.id === entry.ref)
    return thought && { title: '思考', detail: truncate(thought.text, DETAIL_LIMIT), tone: 'think' }
  },
  tool: (state, entry) => {
    const tool = state.tools[entry.ref]
    return tool && { title: tool.title, detail: toolDetail(tool), tone: TOOL_TONE[tool.status] ?? 'pending' }
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
export function traceItems(state) {
  return state.timeline
    .map((entry, index) => {
      const item = TRACE_BUILDERS[entry.kind]?.(state, entry)
      return item ? { key: `${entry.kind}-${entry.ref}-${index}`, time: formatClock(entry.at), ...item } : null
    })
    .filter(Boolean)
}

const toolsInOrder = (state) =>
  state.timeline.filter((e) => e.kind === 'tool').map((e) => state.tools[e.ref]).filter(Boolean)

/** Unique file paths the agent touched, last action wins. */
export function fileItems(state) {
  const byPath = toolsInOrder(state)
    .flatMap((tool) => (tool.locations ?? []).map((loc) => [loc.path, { path: loc.path, kind: tool.kind, tone: TOOL_TONE[tool.status] ?? 'pending' }]))
    .reduce((acc, [path, item]) => ({ ...acc, [path]: item }), {})
  return Object.values(byPath).map((item) => ({ ...item, name: workspaceName(item.path) }))
}

/** What the confirmation card shows of the tool's arguments: a command as itself, anything else pretty-printed. */
export function permissionDetail(permission) {
  if (!permission?.rawInput) return ''
  const { command } = permission.rawInput
  if (typeof command === 'string' && Object.keys(permission.rawInput).length === 1) return truncate(command, 600)
  try {
    return truncate(JSON.stringify(permission.rawInput, null, 2), 600)
  } catch {
    return '[无法显示的参数]'
  }
}

export function modeLine(info) {
  if (info.mode === 'live') return 'DeepSeek Harness · ACP'
  if (info.mode === 'setup') return '未连接'
  return '连接中…'
}

const SETUP_COPY = {
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
export const setupView = (info) => (info.mode === 'setup' ? SETUP_COPY[info.problem] ?? SETUP_COPY['no-key'] : null)

export function usageLabel(usage) {
  if (!usage?.size) return ''
  return `上下文已用 ${Math.round((usage.used / usage.size) * 100)}%`
}
