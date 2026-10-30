import { calendarDays, formatDate } from '../shared/i18n/format.ts'
import { onLocaleChange, localeRevision, getLocale } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
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
  if (hour < 5) return t("selectors.it.s.late")
  if (hour < 11) return t("selectors.good.morning")
  if (hour < 13) return t("selectors.good.afternoon")
  if (hour < 18) return t("selectors.good.afternoon.2")
  return t("selectors.good.evening")
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
const daysAgo = (ts: number, now: number) => calendarDays(ts, now)

/** Short time for a history row: 09:05 today, 昨天, 9月1日 this year, 2025/12/31 before. */
export function formatListTime(ts: number, now = Date.now()): string {
  const date = new Date(ts)
  const days = daysAgo(ts, now)
  if (days <= 0) return formatHM(date)
  if (days === 1) return t("selectors.yesterday")
  if (getLocale() === 'en') return formatDate(date, { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}) })
  if (date.getFullYear() === new Date(now).getFullYear()) return t("selectors.label", { value1: date.getMonth() + 1, value2: date.getDate() })
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function formatSavedAt(ts: number, now: number) {
  const date = new Date(ts)
  const sameDay = date.toDateString() === new Date(now).toDateString()
  return t("selectors.label.2", { value1: sameDay ? t("selectors.today") : t("selectors.label", { value1: date.getMonth() + 1, value2: date.getDate() }), value2: formatHM(date) })
}

/** Divider shown under last launch's messages, or null when the thread did not start from history. */
export function restoredNote(state: State, now = Date.now()): { when: string, memory: string } | null {
  if (!state.restored) return null
  const { remembersHistory } = state.info
  const memory = remembersHistory === undefined
    ? ''
    : remembersHistory ? t("selectors.the.assistant.remembers.this.content.you.can") : t("selectors.the.previous.session.could.not.be.restored")
  return { when: formatSavedAt(state.restored.savedAt, now), memory }
}

/** What the window calls the app's own working directory. */
export let DEFAULT_DIR_NAME = t("selectors.viva.files")

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
  if (days === 0) return t("selectors.today")
  if (days === 1) return t("selectors.yesterday")
  const date = new Date(ts)
  if (getLocale() === 'en') return formatDate(date, { month: 'long', day: 'numeric', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}) })
  const day = t("selectors.label.3", { value1: date.getMonth() + 1, value2: date.getDate() })
  return date.getFullYear() === new Date(now).getFullYear() ? day : t("selectors.label.4", { value1: date.getFullYear(), day: day })
}

/** A row of the earlier timeline: a day, a change of working directory, or a message; each names its segment. */
export type EarlierRow = { segment: string | null } & (
  | { kind: 'day', label: string }
  | { kind: 'workdir', cwd: string, continues: boolean }
  | { kind: 'message', id: string, role: string, text: string, receipt: Receipt | null, images?: Array<{ id: string }> }
)

// Immutable segments keep their row objects across new topics; only a changed day/boundary is rebuilt.
const segmentRows = new WeakMap<Segment, { day: number, locale: number, beforeDay: string | null, beforeCwd: string | null, continues: boolean, rows: EarlierRow[], lastDay: string | null, lastCwd: string | null }>()

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
  const today = startOfDay(now)
  earlier.segments.forEach((segment, i) => {
    const continues = i > 0 && segment.parentId === earlier.segments[i - 1].id
    const cached = segmentRows.get(segment)
    if (cached && cached.locale === localeRevision() && cached.day === today && cached.beforeDay === lastDay && cached.beforeCwd === lastCwd && cached.continues === continues) {
      for (const row of cached.rows) rows.push(row)
      lastDay = cached.lastDay
      lastCwd = cached.lastCwd
      return
    }
    const beforeDay = lastDay
    const beforeCwd = lastCwd
    const own: EarlierRow[] = []
    if (segment.cwd && lastCwd && segment.cwd !== lastCwd) own.push({ kind: 'workdir', cwd: segment.cwd, continues, segment: segment.id })
    lastCwd = segment.cwd ?? lastCwd
    for (const message of segment.messages) {
      const day = timelineDay(message.at, now)
      if (day !== lastDay) own.push({ kind: 'day', label: day, segment: segment.id })
      lastDay = day
      own.push({
        kind: 'message', id: `${segment.id}-${message.seq}`, role: message.role, text: message.text, receipt: message.receipt,
        segment: segment.id, ...(message.images ? { images: message.images } : {}),
      })
    }
    segmentRows.set(segment, { locale: localeRevision(), day: today, beforeDay, beforeCwd, continues, rows: own, lastDay, lastCwd })
    for (const row of own) rows.push(row)
  })
  if (currentCwd && lastCwd && currentCwd !== lastCwd) rows.push({ kind: 'workdir', cwd: currentCwd, continues: currentContinues, segment: null })
  return rows
}

function compactJson(value: unknown) {
  if (value === null || value === undefined) return ''
  try {
    return truncate(typeof value === 'string' ? value : JSON.stringify(value), JSON_LIMIT)
  } catch {
    return t("selectors.arguments.cannot.be.displayed")
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
  return state.messages[state.messages.length - 1]?.open ? t("selectors.replying") : t("selectors.thinking")
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
export let PROMPT_HEADS = Object.freeze({ permission: t("selectors.needs.your.approval"), question: t("selectors.needs.your.answer"), secret: t("selectors.needs.your.input") })

/** Copy and tone for the avatar/status island. */
export function statusView(state: State, now = Date.now()): { tone: string, label: string, event: string } {
  if (state.phase === 'waiting') return { tone: 'waiting', label: PROMPT_HEADS.permission, event: truncate(state.permission?.title, EVENT_LIMIT) }
  if (state.phase === 'asking') return { tone: 'waiting', label: PROMPT_HEADS.question, event: truncate(state.question?.questions[0]?.question, EVENT_LIMIT) }
  if (state.phase === 'working') return { tone: 'working', label: t("island-view.working"), event: workingEvent(state, now) }
  if (state.phase === 'error') return { tone: 'error', label: t("island-view.error"), event: truncate(state.error, EVENT_LIMIT) }
  if (state.info.mode === 'connecting') return { tone: 'pending', label: t("island-view.connecting"), event: 'DEEPSEEK HARNESS' }
  if (state.info.mode === 'setup') return { tone: 'pending', label: t("island-view.not.connected"), event: state.info.problem === 'no-dsh' ? t("selectors.dsh.not.installed") : t("selectors.set.up.a.model") }
  if (state.lastReceipt) {
    const stopped = state.lastReceipt.stopReason === 'cancelled'
    return { tone: stopped ? 'idle' : 'done', label: stopped ? t("island-view.stopped") : t("island-view.completed"), event: formatElapsed(state.lastReceipt.ms) }
  }
  return { tone: 'idle', label: t("island-view.idle"), event: state.info.model || '' }
}

/** One-line receipt under an answer, e.g. "用时 42 秒 · 3 次工具". */
export function receiptLine(receipt: Receipt): string {
  const seconds = Math.max(1, Math.round(receipt.ms / 1000))
  return [
    receipt.stopReason === 'cancelled' ? t("island-view.stopped") : t("selectors.seconds", { seconds: seconds }),
    receipt.tools ? t("selectors.tool.calls", { tools: receipt.tools }) : '',
  ].filter(Boolean).join(' · ')
}

let FIXED_REASONS: Readonly<Record<string, string>> = {
  first: t("selectors.profile.preferences.and.memory.rules.session.start"),
  changed: t("selectors.updated.profile.and.preferences"),
  compacted: t("selectors.profile.preferences.and.memory.rules.restored.after"),
}

/** A trace row: a title, what it was about, and its tone. */
export type TraceRow = { title: string, detail: string, tone: string }

/** One trace row for what the memory plugin sent: why the profile went along, and which memories and why. */
export function memoryTrace(injection: { fixed?: string | null, pushed?: ReadonlyArray<{ names: string[], text: string }> }): TraceRow {
  const lines = [
    injection.fixed ? FIXED_REASONS[injection.fixed] ?? t("selectors.profile.and.preferences") : '',
    ...(injection.pushed ?? []).map((item) => t("selectors.mentioned", { value1: item.names.join('、'), text: item.text })),
  ].filter(Boolean)
  return { title: t("selectors.recall.memories"), detail: truncate(lines.join('\n'), DETAIL_LIMIT), tone: 'done' }
}

/** The app's own tools that say something to the user, said plainly in the trace. */
const NAMED_TOOLS: Readonly<Record<string, (tool: ToolCall) => { title: string, detail: string }>> = {
  // The agent saying a job will take long (plugins/steer/lib/offer.js), with its reason.
  viva_offer_background: (tool) => ({ title: t("selectors.suggest.moving.to.background"), detail: truncate(String(tool.rawInput?.why ?? ''), DETAIL_LIMIT) }),
}

/** A timeline entry: what happened, which thing of the state it refers to, and when. */
type TimelineEntry = State['timeline'][number]

const TRACE_BUILDERS: Readonly<Record<string, (state: State, entry: TimelineEntry) => TraceRow | null | undefined>> = {
  memory: (_state, entry) => memoryTrace(entry.injection),
  thought: (state, entry) => {
    const thought = state.thoughts.find((t) => t.id === entry.ref)
    return thought && { title: t("selectors.thinking.2"), detail: truncate(thought.text, DETAIL_LIMIT), tone: 'think' }
  },
  tool: (state, entry) => {
    const tool = state.tools[entry.ref]
    if (!tool) return null
    const named = NAMED_TOOLS[tool.title]?.(tool)
    return { title: named?.title ?? tool.title, detail: named ? named.detail : toolDetail(tool), tone: TOOL_TONE[tool.status ?? ''] ?? 'pending' }
  },
  permission: (_state, entry) => ({ title: t("selectors.request.approval"), detail: entry.title, tone: 'waiting' }),
  question: (_state, entry) => ({ title: t("selectors.ask.you.a.question"), detail: entry.title, tone: 'waiting' }),
  answer: (_state, entry) => (entry.answered
    ? { title: t("selectors.your.answer"), detail: entry.title, tone: 'done' }
    : { title: t("selectors.question.not.answered"), detail: entry.title, tone: 'idle' }),
  secret: (_state, entry) => ({ title: t("selectors.request.credentials"), detail: entry.title, tone: 'waiting' }),
  secret_answer: (_state, entry) => (entry.provided
    ? { title: t("selectors.credentials.provided"), detail: entry.title, tone: 'done' }
    : { title: t("selectors.no.credentials.provided"), detail: entry.title, tone: 'idle' }),
  decision: (_state, entry) => ({
    title: entry.allowed ? t("selectors.you.chose", { choice: entry.choice }) : t("selectors.not.authorized", { choice: entry.choice }),
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
  if (typeof command === 'string' && Object.keys(permission.rawInput).length === 1) return command
  try {
    return JSON.stringify(permission.rawInput, null, 2)
  } catch {
    return t("selectors.arguments.cannot.be.displayed")
  }
}

export function modeLine(info: AgentInfo): string {
  if (info.mode === 'live') return 'DeepSeek Harness · ACP'
  if (info.mode === 'setup') return t("island-view.not.connected")
  return t("selectors.connecting")
}

/** What the home card and composer say while the agent cannot start. */
export type SetupCopy = { title: string, body: string, action: string | null, placeholder: string }

let SETUP_COPY: Readonly<Record<string, SetupCopy>> = {
  'no-key': {
    title: t("selectors.connect.a.model"),
    body: t("selectors.enter.a.deepseek.api.key.or.add"),
    action: t("selectors.open.settings"),
    placeholder: t("selectors.set.up.a.model.before.sending"),
  },
  'no-dsh': {
    title: t("selectors.deepseek.harness.not.found"),
    body: t("selectors.the.required.dsh.installation.is.incomplete.run"),
    action: null,
    placeholder: t("selectors.install.deepseek.harness.first"),
  },
}

/** What the home card and composer say while the agent cannot start, or null when it can. */
export const setupView = (info: AgentInfo): SetupCopy | null => (info.mode === 'setup' ? SETUP_COPY[info.problem ?? ''] ?? SETUP_COPY['no-key'] : null)

export function usageLabel(usage: { used: number, size: number } | null | undefined): string {
  if (!usage?.size) return ''
  return t("selectors.context.used", { value1: Math.round((usage.used / usage.size) * 100) })
}

onLocaleChange(() => {
  DEFAULT_DIR_NAME = t("selectors.viva.files")
  PROMPT_HEADS = Object.freeze({ permission: t("selectors.needs.your.approval"), question: t("selectors.needs.your.answer"), secret: t("selectors.needs.your.input") })
  FIXED_REASONS = {
  first: t("selectors.profile.preferences.and.memory.rules.session.start"),
  changed: t("selectors.updated.profile.and.preferences"),
  compacted: t("selectors.profile.preferences.and.memory.rules.restored.after"),
}
  SETUP_COPY = {
  'no-key': {
    title: t("selectors.connect.a.model"),
    body: t("selectors.enter.a.deepseek.api.key.or.add"),
    action: t("selectors.open.settings"),
    placeholder: t("selectors.set.up.a.model.before.sending"),
  },
  'no-dsh': {
    title: t("selectors.deepseek.harness.not.found"),
    body: t("selectors.the.required.dsh.installation.is.incomplete.run"),
    action: null,
    placeholder: t("selectors.install.deepseek.harness.first"),
  },
}
})
