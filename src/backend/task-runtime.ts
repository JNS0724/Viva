import { randomUUID } from 'node:crypto'
import { t } from '../shared/i18n/translate.ts'
import type { Conversation } from './history-db.ts'
import type { Apply } from './journal.ts'
import type { EndedTask } from './task-reports.ts'
import type { StoredTask, TaskStore } from './task-store.ts'
import { createTaskRegistry, endedStatus, type TaskQuery, type TaskScope, type TaskSnapshot } from './task-registry.ts'
import { createTaskWords, type TaskWordsDeps } from './task-words.ts'
import type { KeptMessage, KeptTask, TaskStartResult, TaskSummary } from '../shared/ipc-results.ts'
import { MAX_MESSAGE_CHARS as MAX_TEXT_CHARS } from '../shared/text-limits.ts'

/**
 * TaskRuntime (docs/system-design.md §12.2): the one writer of the background tasks. 后台做 starts a task in a
 * session of its own, forked from the conversation (before the turn running there, if one is), its segment hanging
 * off the conversation, out of the timeline. It holds each task's life (task-registry.ts: at work, waiting, how it
 * ended), what the task says (task-words.ts) and what is kept of it (task-store.ts); no other module writes these.
 *
 * - Each change is one transaction with its event (`apply`): `task.started`, `task.restarted`, `task.ended`,
 *   `task.closed`, each with the `taskId` and, for a run, its `runId`. The window's snapshots go out once it commits.
 * - A run is a task's turn: from the turn that started it, or the message that set it going again (接着问, taken
 *   up), to that turn's end. Its `runId` is on the task's snapshots and events.
 * - Callers get narrow faces: `window` (task-ipc.ts), `agent` (the viva-tasks tools), `dsh` (what it reports),
 *   `reports` (task-reports.ts, for results back in the conversation).
 */
const MAX_TITLE_CHARS = 40

export const taskProblems = (): Readonly<Record<string, string>> & { going: string, gone: string, lost: string } => ({
  invalid: t("main.task-ipc.the.current.task.is.not.in.the"),
  missing: t("handoff.task.no.session"),
  connecting: t("handoff.task.connecting"),
  unavailable: t("main.task-ipc.this.assistant.version.does.not.support.background"),
  lost: t("main.task-ipc.cannot.resume.previous.record.missing.you.can"),
  gone: t("main.task-ipc.cannot.resume.previous.record.missing.you.can.2"),
  going: t("main.task-ipc.this.task.is.running.your.message.will"),
})

/** Without a store (tests that do not need one), nothing is kept between launches. */
const NO_STORE: TaskStore = Object.freeze({ list: () => [], add: () => {}, remove: () => {} })
/** Without the event core (tests that do not look at events), a change is only its write. */
const NO_EVENTS: Apply = (_kind, _data, write) => ({ value: write() })
/**
 * dsh says a turn ended once; an end that could not be kept (the database refused it) is kept again after these
 * waits, the last repeated, for as long as that run is the task's: a later run, or dsh gone, lets it go.
 */
export const END_RETRY_MS: readonly number[] = Object.freeze([1_000, 5_000, 30_000, 60_000])
/**
 * Ended tasks kept to be asked again, the latest so many: the user no longer closes each one once read (a task
 * seen stops reminding), so enough are kept that the 后台 page's 做完了 rarely offers one already let go.
 */
export const KEEP_ENDED = 30
/** At most this many tasks work at once; one more is refused, not queued. */
export const MAX_RUNNING = 5
const ENDED_STATUSES = new Set(['done', 'stopped', 'error'])

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS
const isEnded = (entry: StoredTask | null | undefined) => Number.isFinite(entry?.endedAt)
const summaryOf = ({ id, segmentId, title, words }: StoredTask) => ({ id, segmentId, title, words })
const titleOf = (words: string) => {
  const line = words.trim().split('\n')[0]
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS)}…` : line
}

/** A task's session as dsh started it (its id), or why not (acp-bridge.ts startTask). */
type StartedTask = { ok: boolean, taskId?: string, reason?: string }
type Maybe<T> = T | Promise<T>
/** What the runtime asks of dsh for its tasks (compose.ts taskAgent, over acp-bridge.ts). */
export interface TaskAgent {
  startTask: (how: { words?: string, afresh?: boolean }) => Maybe<StartedTask>
  promptTask: (taskId: string, text: string) => unknown
  steerTask: (taskId: string, text: string) => Maybe<{ ok: boolean } | null | undefined>
  resumeTask: (request: { taskId: string, cwd?: string }) => Maybe<{ ok: boolean }>
  cancelTask: (taskId: string) => unknown
  closeTask: (taskId: string) => unknown
}

/** What the background tasks need from the app: the history, the task store, the conversation on screen, the agent. */
export interface TaskRuntimeDeps {
  db: ReturnType<typeof import('./history-db.ts').openHistoryDb>
  store?: TaskStore
  current: () => Conversation
  agentInfo: () => { mode?: string, model?: string }
  agent: TaskAgent
  /** Timers for saving what tasks say along the way (tests pass their own). */
  timers?: Pick<TaskWordsDeps, 'later' | 'cancel'>
  /** What a task held still waits on the user for (acp-bridge.ts taskWaits), for a window that opens meanwhile. */
  waitsOf?: (taskId: string) => { permissions: readonly unknown[], questions: readonly unknown[] }
  /** To the window: what the agent did with a task, which the window did not ask for (task_created, …). */
  announce?: (event: { type: string, [field: string]: unknown }) => void
  /** A change and its event in one transaction (event-core.ts apply). The task store and the history are written only inside one. */
  apply?: Apply
  /** To the window, once a change has committed: a task's snapshot (`task_snapshot`). */
  publish?: (push: { type: 'task_snapshot', taskId: string, snapshot: TaskSnapshot }) => void
  /**
   * A task's run ended and that is kept (after the commit): its result goes back to the conversation, a gap follows
   * (compose.ts). Not called for an end that could not be kept yet.
   */
  onEnd?: (taskId: string, status: string) => void
  now?: () => number
  newRunId?: () => string
}

export function createTaskRuntime({ db, store = NO_STORE, current, agentInfo, agent, timers = {}, announce = () => {},
  waitsOf = () => ({ permissions: [], questions: [] }), apply = NO_EVENTS, publish = () => {}, onEnd = () => {}, now = Date.now, newRunId = randomUUID }: TaskRuntimeDeps) {
  const later = timers.later ?? setTimeout
  const cancel = timers.cancel ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  /** taskId → the end of its run still to be kept, and its next try. */
  const pendingEnds = new Map<string, { runId: string, timer: unknown }>()
  /** Snapshots of a change still being written, and what is let go of once it commits (`change`), not before. */
  let queued: TaskSnapshot[] = []
  let afterCommit: Array<() => void> = []
  let depth = 0
  const registry = createTaskRegistry({ now, changed: (snapshot) => {
    queued = [...queued, snapshot]
    ended(snapshot)
    if (depth === 0) pushQueued()
  } })
  function pushQueued() {
    const out = queued
    const then = afterCommit
    queued = []
    afterCommit = []
    for (const run of then) run()
    for (const snapshot of out) publish({ type: 'task_snapshot', taskId: snapshot.taskId, snapshot })
  }
  /**
   * One change of a task: its writes and its event in one transaction, then the window's snapshots. Undone, the
   * database is as it was, and so is the task in memory (how it stands, what it said): a later end can be kept.
   */
  function change<T>(kind: string, data: { taskId: string, [field: string]: unknown }, write: () => T): T {
    const undo = [registry.checkpoint(data.taskId), taskWords.checkpoint(data.taskId)]
    depth += 1
    try {
      return apply(kind, data, write).value
    } catch (err) {
      undo.forEach((restore) => restore())
      if (depth === 1) { queued = []; afterCommit = [] }
      throw err
    } finally {
      depth -= 1
      if (depth === 0) pushQueued()
    }
  }
  const restoredSummary = (entry: StoredTask) => {
    const host = db.sideTaskHost(entry.segmentId)
    return { ...summaryOf(entry), ...(host ? { host } : {}) }
  }
  for (const task of store.list()) registry.put({ ...task,
    resultPreview: task.resultPreview ?? db.get(task.segmentId)?.messages.slice(task.keep ?? 0).filter(message => message.role === 'assistant').at(-1)?.text ?? '',
  }, true)
  /** taskId → { id, segmentId, title, words, keep, next } (next: the segment the conversation went on in) */
  const tasks = new Map<string, StoredTask>()
  /** Tasks whose dsh session this launch holds: moved here, or taken up again. Others must be taken up first. */
  let attached = new Set<string>()

  /** What a task has said, from its own words on, into its segment after what came before them. */
  function persist(taskId: string, messages: readonly unknown[]) {
    const task = tasks.get(taskId)
    const found = task ? db.get(task.segmentId) : null
    if (!task || !found) return
    db.save(found.conversation, [...found.messages.slice(0, task.keep), ...messages])
  }
  const taskWords = createTaskWords({
    ...timers, persist,
    onError: (err) => console.error('[tasks] could not save what the task said:', err.message),
  })

  const taskById = (taskId: unknown) => {
    const task = tasks.get(taskId as string)
    if (!task) throw new Error('no such task')
    return task
  }

  const detach = (taskId: string) => { attached = new Set([...attached].filter((id) => id !== taskId)) }

  /**
   * 后台做: `text` goes to a task of its own, in a session forked from the conversation as it is (before the
   * turn running there, named by its `words`, if one is). The conversation on screen stays where it is; the
   * task's segment hangs off it, out of the timeline, and is kept like any task going on.
   */
  async function start(request: { text?: unknown, words?: unknown } | null | undefined): Promise<TaskStartResult> {
    const { text, words = null } = request ?? {}
    if (!isText(text) || (words !== null && !isText(words))) throw new Error('invalid task request')
    return begin(text, words === null ? {} : { words })
  }

  /** A task begun: from the conversation (后台做), or afresh from the agent's brief (start_background_task). */
  async function begin(text: string, how: { words?: string, afresh?: boolean }): Promise<TaskStartResult> {
    const main = current()
    const { mode, model } = agentInfo()
    if (mode === 'connecting') return { ok: false as const, problem: taskProblems().connecting }
    if (registry.live() >= MAX_RUNNING) return { ok: false as const, problem: t('main.task-ipc.full', { max: MAX_RUNNING }) }
    const started = await agent.startTask(how)
    if (!started.ok || !started.taskId) {
      const reason = started.reason ?? 'missing'
      return { ok: false as const, problem: taskProblems()[reason] ?? t("main.task-ipc.could.not.start.in.background", { reason }) }
    }
    const taskId = started.taskId
    const runId = newRunId()
    const task = change('task.started', { taskId, runId }, () => {
      // A conversation with only 后台做 requests has no foreground messages yet. Keep its identity too,
      // otherwise the task points at an absent parent and its history row cannot return after a restart.
      if (!db.get(main.id)) db.save(main, [], { keepEmpty: true })
      const segment = db.save(db.create({ sessionId: taskId, mode, model, cwd: main.cwd, parentId: main.id }), [{ role: 'user', text, receipt: null }])
      db.fold(segment.id, { into: main.id, at: db.get(main.id)?.messages.length ?? 0, kind: 'side' })
      const begun: TaskSummary = { id: taskId, segmentId: segment.id, title: titleOf(text), words: text }
      store.add({ ...begun, runId, keep: 0, next: main.id, cwd: main.cwd ?? '', startedAt: now() })
      registry.put({ ...begun, runId, cwd: main.cwd ?? '' })
      return begun
    })
    tasks.set(task.id, { ...task, keep: 0, next: main.id })
    attached = new Set([...attached, task.id])
    taskWords.track(task.id, [{ role: 'user', text }])
    agent.promptTask(task.id, text)
    return { ok: true as const, task }
  }

  /**
   * A task's run ended, as the registry decided it (its snapshot): the one place its ending is
   * kept, with the registry's status, time and last words, so the store and the window say the same. Beyond the
   * latest few ended, the oldest are let go. A snapshot already kept (a task restored at launch) changes nothing.
   */
  function ended(snapshot: TaskSnapshot) {
    if (snapshot.endedAt === null || !ENDED_STATUSES.has(snapshot.status)) return
    const entry = store.list().find((item) => item.id === snapshot.taskId)
    if (!entry || (entry.endedAt === snapshot.endedAt && entry.status === snapshot.status)) return
    store.add({ ...entry, runId: snapshot.runId, endedAt: snapshot.endedAt, status: snapshot.status, resultPreview: snapshot.resultPreview })
    store.list().filter(isEnded).sort((a, b) => b.endedAt - a.endedAt).slice(KEEP_ENDED).forEach((old) => {
      store.remove(old.id)
      afterCommit = [...afterCommit, () => registry.remove(old.id)]
    })
  }

  async function close(taskId: string): Promise<void> {
    taskById(taskId)
    change('task.closed', { taskId }, () => {
      store.remove(taskId)
      registry.remove(taskId)
    })
    letEndGo(taskId)
    taskWords.drop(taskId)
    tasks.delete(taskId)
    detach(taskId)
    await agent.closeTask(taskId)
  }

  /**
   * Every task kept, for a window that opens (at launch, or reloaded while tasks go on): with what it said, to be
   * closed or messaged by the agent. Those this launch holds and that have not ended are at work (no `endedAt`),
   * with what they said so far; those an earlier launch quit on are interrupted, taken up only when messaged.
   */
  function finished(): KeptTask[] {
    return store.list().flatMap((entry) => {
      const found = db.get(entry.segmentId)
      if (!found) return []
      if (!tasks.has(entry.id)) tasks.set(entry.id, entry)
      const ended = isEnded(entry)
      const held = attached.has(entry.id)
      const messages = (held ? taskWords.current(entry.id) : null) ?? found.messages.slice(entry.keep)
      if (ended) return [{ task: restoredSummary(entry), status: entry.status, endedAt: entry.endedAt, messages }]
      if (held) return [{ task: restoredSummary(entry), status: 'running', endedAt: null, startedAt: entry.startedAt ?? null, messages, waits: waitsOf(entry.id) }]
      return [{ task: restoredSummary(entry), status: 'interrupted', endedAt: entry.startedAt ?? Date.now(), messages }]
    })
  }

  /**
   * 接着问: a task that ended is asked `text` as its next question, in its own session, which remembers all it
   * did; taken up first when an earlier launch held it. It is going again, so kept as going.
   */
  async function ask(taskId: string, text: unknown) {
    if (!isText(text)) throw new Error('invalid task request')
    const kept = store.list().find((entry) => entry.id === taskId)
    // Let go since the window listed it (beyond the latest kept): said plainly, not as an error.
    if (!kept) return { ok: false, problem: taskProblems().gone }
    if (!isEnded(kept)) return { ok: false, problem: taskProblems().going }
    if (!attached.has(taskId)) {
      const taken = await agent.resumeTask({ taskId, ...(kept.cwd ? { cwd: kept.cwd } : {}) })
      if (!taken.ok) return { ok: false, problem: taskProblems().gone }
      attached = new Set([...attached, taskId])
    }
    const { endedAt: _endedAt, status: _status, ...going } = kept
    const runId = newRunId()
    const running = { ...going, runId }
    change('task.restarted', { taskId, runId }, () => {
      store.add(running)
      registry.restart(taskId, runId)
    })
    tasks.set(taskId, running)
    if (!taskWords.has(taskId)) taskWords.track(taskId, db.get(kept.segmentId)?.messages.slice(kept.keep) ?? [])
    taskWords.userSaid(taskId, text)
    agent.promptTask(taskId, text)
    return { ok: true }
  }

  /**
   * Taken up again: its dsh session is reattached as a task and asked `words` (the agent's); the window gets what
   * it had said, from its own words on, and those words, to show it as it was.
   */
  async function resume(taskId: string, words: string) {
    const kept = store.list().find((entry) => entry.id === taskId)
    if (!kept) throw new Error('no such task')
    const taken = await agent.resumeTask({ taskId, ...(kept.cwd ? { cwd: kept.cwd } : {}) })
    if (!taken.ok) return { ok: false, problem: taskProblems().lost }
    const runId = newRunId()
    const running = { ...kept, runId }
    change('task.restarted', { taskId, runId }, () => {
      store.add(running)
      registry.restart(taskId, runId)
    })
    tasks.set(taskId, running)
    attached = new Set([...attached, taskId])
    const before = db.get(kept.segmentId)?.messages.slice(kept.keep) ?? []
    const said = [...before, { role: 'user', text: words, receipt: null }]
    taskWords.track(taskId, said)
    agent.promptTask(taskId, words)
    return { ok: true, task: restoredSummary(kept), messages: said }
  }

  const keptTask = (taskId: string) => {
    const kept = store.list().find((entry) => entry.id === taskId)
    if (!kept) throw new Error(taskProblems().gone)
    return kept
  }

  /** start_background_task: afresh, from the agent's brief, its card in the conversation on screen. */
  async function agentStart(brief: string) {
    const started = await begin(brief, { afresh: true })
    if (!started.ok) throw new Error(started.problem)
    announce({ type: 'task_created', task: started.task, text: brief })
    return { taskId: started.task.id, title: started.task.title, status: 'running' }
  }

  /** stop_background_task: its turn stops; the task stays, to be messaged later. */
  async function agentStop(taskId: string) {
    const kept = keptTask(taskId)
    if (isEnded(kept) || !attached.has(taskId)) return { taskId, stopped: false, status: isEnded(kept) ? kept.status : 'interrupted' }
    await agent.cancelTask(taskId)
    return { taskId, stopped: true }
  }

  /**
   * message_background_task: into its turn while it works; its next question once it ended; taken up again
   * first when an earlier launch left it unfinished.
   */
  async function agentMessage(taskId: string, text: string) {
    const kept = keptTask(taskId)
    if (isEnded(kept)) {
      const asked = await ask(taskId, text)
      if (!asked.ok) throw new Error(asked.problem)
      announce({ type: 'task_asked', taskId, text })
      return { taskId, delivered: 'next question' }
    }
    if (!attached.has(taskId)) {
      const taken = await resume(taskId, text)
      if (!taken.ok) throw new Error(taken.problem)
      announce({ type: 'task_resumed', task: taken.task, messages: taken.messages })
      return { taskId, delivered: 'taken up again' }
    }
    taskWords.userSaid(taskId, text)
    const steered = await agent.steerTask(taskId, text)
    if (!steered?.ok) throw new Error(t('task-actions.this.task.has.stopped.your.message.was'))
    announce({ type: 'task_steered', taskId, text })
    return { taskId, delivered: 'into its turn' }
  }

  /**
   * What dsh reports of a task, in order: what it says and asks (streamed, no change of its own), and its turn's end.
   * The end is one change: what it said saved, how it ended kept (`ended`), and the `task.ended` event, together.
   */
  function receive(raw: unknown) {
    const event = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const taskId = typeof event.taskId === 'string' ? event.taskId : ''
    const runId = event.type === 'task_end' ? registry.runOf(taskId) : null
    if (runId === null) {
      taskWords.receive(event)
      registry.receive(event)
      return
    }
    endRun(taskId, runId, event, 0)
  }

  /**
   * A run's end, kept: what it said, how it ended and `task.ended` together; then the window's snapshot and its result
   * back to the conversation. Refused by the database, nothing changed, so it is tried again later, with the same run.
   */
  function endRun(taskId: string, runId: string, event: Record<string, unknown>, attempt: number) {
    const status = endedStatus(event.stopReason)
    try {
      change('task.ended', { taskId, runId, status }, () => {
        taskWords.receive(event, { strict: true })
        registry.receive(event)
      })
    } catch (err) {
      const wait = END_RETRY_MS[Math.min(attempt, END_RETRY_MS.length - 1)]
      console.error(`[tasks] could not keep how a task ended, trying again in ${wait / 1000}s:`, err instanceof Error ? err.message : String(err))
      const timer = later(() => {
        pendingEnds.delete(taskId)
        // Only the same run: one asked again, taken up, or interrupted since is not ended by this.
        if (registry.runOf(taskId) === runId) endRun(taskId, runId, event, attempt + 1)
      }, wait)
      pendingEnds.set(taskId, { runId, timer })
      return
    }
    onEnd(taskId, status)
  }

  /** An end still to be kept is let go: its task closed, or dsh gone. */
  function letEndGo(taskId: string) {
    const pending = pendingEnds.get(taskId)
    if (pending) cancel(pending.timer)
    pendingEnds.delete(taskId)
  }

  /**
   * dsh went (stopped, restarted, crashed): what tasks said is saved now; no task's session is held any more, so the
   * next message to one takes it up again in the new dsh first; those at work are interrupted.
   */
  function gone() {
    taskWords.flush()
    attached = new Set()
    ;[...pendingEnds.keys()].forEach(letEndGo)
    registry.interrupt()
  }

  /** A task that ended, as the note back in the conversation gives it (task-reports.ts); null once it is not known. */
  function describe(taskId: string, status: string): EndedTask | null {
    try {
      const { task } = registry.query({ op: 'get', taskId, includeOutput: true }, { taskId }) as { task: { title: string, resultPreview?: string } }
      return { taskId, title: task.title, status, host: tasks.get(taskId)?.next ?? null, output: task.resultPreview ?? '' }
    } catch {
      return null
    }
  }

  /** Whether a task is still as it ended: asked again or taken up since, its old result is not reported. */
  function stillEnded(taskId: string): boolean {
    try {
      const { task } = registry.query({ op: 'get', taskId }, { taskId }) as { task: { status: string } }
      return ENDED_STATUSES.has(task.status)
    } catch {
      return false
    }
  }

  return {
    /** The window's channels (task-ipc.ts). */
    window: {
      start,
      finished,
      close,
      /** Its turn stops; the task stays, to be asked again. */
      stop: async (taskId: unknown): Promise<void> => { await agent.cancelTask(taskById(taskId).id) },
    },
    /** The agent's tools (viva-tasks): its queries, and starting, stopping or messaging a task. */
    agent: {
      query: (request: TaskQuery, scope: TaskScope) => registry.query(request, scope),
      start: agentStart,
      stop: agentStop,
      message: agentMessage,
    },
    /** What dsh reports and asks of tasks. */
    dsh: {
      receive,
      /** The user's answer to a question dsh took: it joins the task that asked it. */
      answer: taskWords.answer,
      /** Before the answer goes to dsh (which closes the question as it takes it): how to keep it once taken. */
      holdQuestion: taskWords.holdQuestion,
      /** Viva quits: what tasks said is saved now. */
      flush: taskWords.flush,
      gone,
    },
    /** Results back in the conversation (task-reports.ts). */
    reports: {
      /** The conversation a task hangs off (its card is there), for its result to come back to; null when not held. */
      hostOf: (taskId: string): string | null => tasks.get(taskId)?.next ?? null,
      describe,
      stillEnded,
    },
  }
}
export type TaskRuntime = ReturnType<typeof createTaskRuntime>
export type TaskWindow = TaskRuntime['window']
