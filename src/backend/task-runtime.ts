import { randomUUID } from 'node:crypto'
import { t } from '../shared/i18n/translate.ts'
import type { Conversation } from './history-db.ts'
import type { Apply } from './journal.ts'
import type { Effects } from './effects.ts'
import { GATHER_MS, REPORT, reportId, reportsOf, REQUEST_CHARS, type ReportPayload } from './task-reports.ts'
import type { StoredTask, TaskStore } from './task-store.ts'
import { createTaskRegistry, endedStatus, type TaskQuery, type TaskScope, type TaskSnapshot } from './task-registry.ts'
import { createTaskWords, type TaskWordsDeps } from './task-words.ts'
import type { KeptMessage, KeptTask, TaskOpening, TaskStartResult, TaskSummary } from '../shared/ipc-results.ts'
import { MAX_MESSAGE_CHARS as MAX_TEXT_CHARS } from '../shared/text-limits.ts'

/**
 * TaskRuntime (docs/system-design.md §11.2): the one writer of the background tasks. 后台做 starts a task in a
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
 * - A run's end queues its `report` (effects.ts) in the same transaction, keyed by the run (`reportId`); a new run,
 *   or the task closed, cancels the report of the run before.
 * - The window's order (§11.3): what a task's run says reaches the window from here, each piece numbered (`taskSeq`,
 *   one count per task; not the event core's `seq`, which a push to the window carries too) with its `runId`, after it is taken in and before the snapshot it changed; each snapshot says the
 *   last piece it already includes. The snapshot that makes a task, or begins a new run of it, goes out (with what
 *   the run begins with: `opening`) before the run's first piece, since the run is asked only once it is kept. What
 *   dsh says of a task unknown, or no longer at work, is no task's and goes nowhere: nothing waits for a task to be
 *   known.
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
 * waits, the last repeated, for as long as that run is the task's (dsh restarting meanwhile too): a later run of the
 * task, or its closing, lets it go.
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
  /** A change and its event in one transaction (event-core.ts apply). The task store and the history are written only inside one. */
  apply?: Apply
  /** To the window, in order: a piece of a task's stream, and, once a change has committed, a task's snapshot. */
  publish?: (push: TaskPush) => void
  /**
   * A task's run ended and that is kept (after the commit): its result goes back to the conversation, a gap follows
   * (compose.ts). Not called for an end that could not be kept yet.
   */
  onEnd?: (taskId: string, status: string) => void
  /** The effects queue (effects.ts): a run's report is queued with its end. Without it, no report is queued. */
  effects?: Pick<Effects, 'queue' | 'cancel' | 'cancelStarting'> | null
  now?: () => number
  newRunId?: () => string
}

/** A snapshot as the window gets it: the last piece of the task's stream it includes, and what a run begins with. */
export type WindowSnapshot = TaskSnapshot & { taskSeq: number, opening?: TaskOpening }
/**
 * What goes to the window of a task, in order: a piece of its run's stream (what dsh said: task_update, task_end, a
 * wait beginning or ending), numbered, or its snapshot.
 */
export type TaskPiece = { type: string, taskId: string, runId: string, taskSeq: number, [field: string]: unknown }
export type TaskPush = { type: 'task_snapshot', taskId: string, snapshot: WindowSnapshot } | TaskPiece

export function createTaskRuntime({ db, store = NO_STORE, current, agentInfo, agent, timers = {},
  waitsOf = () => ({ permissions: [], questions: [] }), apply = NO_EVENTS, publish = () => {}, onEnd = () => {}, effects = null, now = Date.now, newRunId = randomUUID }: TaskRuntimeDeps) {
  const later = timers.later ?? setTimeout
  const cancel = timers.cancel ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  /** taskId → the end of its run still to be kept, and its next try. */
  const pendingEnds = new Map<string, { runId: string, timer: unknown }>()
  /** Snapshots of a change still being written, and what is let go of once it commits (`change`), not before. */
  let queued: TaskSnapshot[] = []
  let afterCommit: Array<() => void> = []
  let depth = 0
  /** taskId → the last piece of its stream numbered (one count per task, across its runs). */
  const seqs = new Map<string, number>()
  /** taskId → what the run a change begins starts with, for the snapshot that goes out once it commits. */
  let openings = new Map<string, TaskOpening>()
  const seqOf = (taskId: string) => seqs.get(taskId) ?? 0
  /** A piece of a task's stream to the window, numbered; the run it is of. */
  function pushPiece(taskId: string, runId: string, event: Record<string, unknown>) {
    const taskSeq = seqOf(taskId) + 1
    seqs.set(taskId, taskSeq)
    publish({ ...event, type: String(event.type), taskId, runId, taskSeq })
  }
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
    for (const snapshot of out) {
      const opening = openings.get(snapshot.taskId)
      if (opening) openings = new Map([...openings].filter(([id]) => id !== snapshot.taskId))
      publish({ type: 'task_snapshot', taskId: snapshot.taskId, snapshot: { ...snapshot, taskSeq: seqOf(snapshot.taskId), ...(opening ? { opening } : {}) } })
    }
  }
  /** What a run a change begins starts with: on its snapshot, once the change commits. */
  const opens = (taskId: string, opening: TaskOpening) => { openings = new Map([...openings, [taskId, opening]]) }
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
      if (depth === 1) { queued = []; afterCommit = []; openings = new Map() }
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

  /**
   * Runs being begun and not yet kept, each holding a place among the MAX_RUNNING. Every run (a new task, one asked
   * again, one taken up) begins through `reserveRun`, before anything it awaits, so runs begun together cannot all
   * pass the count; the place goes once the run is kept (counted as at work by the registry) or has failed.
   */
  let places = new Set<string>()
  /** Tasks beginning a run now: one session takes one turn at a time. */
  let beginning = new Set<string>()
  let runsBegun = 0
  /**
   * A place for a run to begin, or why not: all taken, or (`taskId` given) that task already beginning a run (whether
   * it is at work is each way's own to say: 接着问 only when it ended, taken up only when no session of it is held).
   * `counted` hands the place to the registry, at once, as the change that begins the run commits (from then on it
   * counts the run as at work, and two counts of one run would refuse another); `release` is called whatever happens
   * after, giving back what is still held. Both may be called more than once.
   */
  function reserveRun(taskId: string | null): { counted: () => void, release: () => void } | { problem: string } {
    if (taskId !== null && beginning.has(taskId)) return { problem: taskProblems().going }
    if (registry.live() + places.size >= MAX_RUNNING) return { problem: t('main.task-ipc.full', { max: MAX_RUNNING }) }
    runsBegun += 1
    const place = `run:${runsBegun}`
    places = new Set([...places, place])
    if (taskId !== null) beginning = new Set([...beginning, taskId])
    const counted = () => { places = new Set([...places].filter((held) => held !== place)) }
    return {
      counted,
      release: () => {
        counted()
        if (taskId !== null) beginning = new Set([...beginning].filter((held) => held !== taskId))
      },
    }
  }

  /** A task begun: from the conversation (后台做), or afresh from the agent's brief (start_background_task). */
  async function begin(text: string, how: { words?: string, afresh?: boolean }): Promise<TaskStartResult> {
    const main = current()
    const { mode, model } = agentInfo()
    if (mode === 'connecting') return { ok: false as const, problem: taskProblems().connecting }
    const place = reserveRun(null)
    if ('problem' in place) return { ok: false as const, problem: place.problem }
    try {
      return await beginReserved(text, how, main, mode, model, place.counted)
    } finally {
      place.release()
    }
  }

  async function beginReserved(text: string, how: { words?: string, afresh?: boolean }, main: Conversation, mode: string | undefined,
    model: string | undefined, counted: () => void): Promise<TaskStartResult> {
    const started = await agent.startTask(how)
    if (!started.ok || !started.taskId) {
      const reason = started.reason ?? 'missing'
      return { ok: false as const, problem: taskProblems()[reason] ?? t("main.task-ipc.could.not.start.in.background", { reason }) }
    }
    const taskId = started.taskId
    const runId = newRunId()
    const task = keepOrClose(taskId, () => change('task.started', { taskId, runId }, () => {
      // A conversation with only 后台做 requests has no foreground messages yet. Keep its identity too,
      // otherwise the task points at an absent parent and its history row cannot return after a restart.
      if (!db.get(main.id)) db.save(main, [], { keepEmpty: true })
      const segment = db.save(db.create({ sessionId: taskId, mode, model, cwd: main.cwd, parentId: main.id }), [{ role: 'user', text, receipt: null }])
      db.fold(segment.id, { into: main.id, at: db.get(main.id)?.messages.length ?? 0, kind: 'side' })
      const begun: TaskSummary = { id: taskId, segmentId: segment.id, title: titleOf(text), words: text }
      store.add({ ...begun, runId, keep: 0, next: main.id, cwd: main.cwd ?? '', startedAt: now(), by: how.afresh ? 'agent' : 'user' })
      opens(taskId, { words: text, task: begun, hostSession: main.sessionId ?? null })
      registry.put({ ...begun, runId, cwd: main.cwd ?? '' })
      return begun
    }))
    counted()
    tasks.set(task.id, { ...task, keep: 0, next: main.id })
    attached = new Set([...attached, task.id])
    taskWords.track(task.id, [{ role: 'user', text }])
    agent.promptTask(task.id, text)
    return { ok: true as const, task }
  }

  /**
   * The task's session made, its start kept, or, refused (the database), the session let go again: no task holds it,
   * and none will (a session made and its start not kept is dsh's to forget; Viva quitting in between leaves it so).
   */
  function keepOrClose<T>(taskId: string, keep: () => T): T {
    try {
      return keep()
    } catch (err) {
      Promise.resolve(agent.closeTask(taskId)).catch((closing: unknown) =>
        console.error('[tasks] could not let go of a task\'s session whose start was not kept:', closing instanceof Error ? closing.message : String(closing)))
      throw err
    }
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
    const report: ReportPayload = { taskId: snapshot.taskId, runId: snapshot.runId, title: snapshot.title, status: snapshot.status,
      host: typeof entry.next === 'string' ? entry.next : null, output: snapshot.resultPreview, token: randomUUID().replaceAll('-', ''),
      // Its background, for a note given while the conversation is on another topic.
      request: typeof entry.words === 'string' ? entry.words.slice(0, REQUEST_CHARS) : '',
      topic: typeof entry.next === 'string' ? db.get(entry.next)?.conversation.title || null : null,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null, by: entry.by === 'agent' || entry.by === 'user' ? entry.by : null }
    effects?.queue(REPORT, reportId(snapshot.taskId, snapshot.runId), report, now() + GATHER_MS)
    store.list().filter(isEnded).sort((a, b) => b.endedAt - a.endedAt).slice(KEEP_ENDED).forEach((old) => {
      store.remove(old.id)
      afterCommit = [...afterCommit, () => registry.remove(old.id)]
    })
  }

  async function close(taskId: string): Promise<void> {
    taskById(taskId)
    change('task.closed', { taskId }, () => {
      // Every report of the task, whether it is still kept or was let go among the oldest ended meanwhile.
      effects?.cancelStarting(REPORT, reportsOf(taskId))
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
   * Every task kept, for a window that opens (at launch, or reloaded while tasks go on): how it stands, as its
   * snapshot says it (the registry's, the one place that works it out: at work, waiting, ended, interrupted), with
   * what it said, and, at work, what it waits on the user for (dsh's, for the window to show and answer it).
   */
  function finished(): KeptTask[] {
    return store.list().flatMap((entry) => {
      const found = db.get(entry.segmentId)
      if (!found) return []
      if (!tasks.has(entry.id)) tasks.set(entry.id, entry)
      const held = attached.has(entry.id)
      const messages = (held ? taskWords.current(entry.id) : null) ?? found.messages.slice(entry.keep)
      // What it said so far includes its stream to here: a piece in flight at or below this is not taken again.
      const mark = typeof entry.runId === 'string' && entry.runId
        ? { mark: { runId: entry.runId, seq: seqOf(entry.id), revision: registry.revisionOf(entry.id) ?? 0 } } : {}
      const stands = registry.snapshotOf(entry.id)
      const status = stands?.status ?? (isEnded(entry) ? entry.status : 'interrupted')
      if (status === 'running' || status === 'waiting') {
        return [{ task: restoredSummary(entry), status, endedAt: null, startedAt: stands?.startedAt ?? entry.startedAt ?? null, messages, waits: waitsOf(entry.id), ...mark }]
      }
      return [{ task: restoredSummary(entry), status, endedAt: stands?.endedAt ?? entry.endedAt ?? entry.startedAt ?? now(), messages, ...mark }]
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
    const place = reserveRun(taskId)
    if ('problem' in place) return { ok: false, problem: place.problem }
    try {
      return await askReserved(taskId, text, kept, place.counted)
    } finally {
      place.release()
    }
  }

  async function askReserved(taskId: string, text: string, kept: StoredTask, counted: () => void) {
    if (!attached.has(taskId)) {
      const taken = await agent.resumeTask({ taskId, ...(kept.cwd ? { cwd: kept.cwd } : {}) })
      if (!taken.ok) return { ok: false, problem: taskProblems().gone }
      attached = new Set([...attached, taskId])
    }
    const { endedAt: _endedAt, status: _status, ...going } = kept
    const runId = newRunId()
    const running = { ...going, runId }
    change('task.restarted', { taskId, runId }, () => {
      cancelReport(kept)
      store.add(running)
      opens(taskId, { words: text })
      registry.restart(taskId, runId)
    })
    counted()
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
    const place = reserveRun(taskId)
    if ('problem' in place) return { ok: false, problem: place.problem }
    try {
      return await resumeReserved(taskId, words, kept, place.counted)
    } finally {
      place.release()
    }
  }

  async function resumeReserved(taskId: string, words: string, kept: StoredTask, counted: () => void) {
    const taken = await agent.resumeTask({ taskId, ...(kept.cwd ? { cwd: kept.cwd } : {}) })
    if (!taken.ok) return { ok: false, problem: taskProblems().lost }
    const runId = newRunId()
    const running = { ...kept, runId }
    change('task.restarted', { taskId, runId }, () => {
      cancelReport(kept)
      store.add(running)
      opens(taskId, { words })
      registry.restart(taskId, runId)
    })
    counted()
    letEndGo(taskId)
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
  /**
   * Words into a task's turn: into what it said, and to the window as a piece of its run's stream (`task_steered`),
   * numbered with that write, so a read of the task (`finished`) has them exactly when its mark counts the piece.
   */
  function said(taskId: string, text: string) {
    taskWords.userSaid(taskId, text)
    const runId = registry.runOf(taskId)
    if (runId !== null) pushPiece(taskId, runId, { type: 'task_steered', text })
  }

  async function agentMessage(taskId: string, text: string) {
    const kept = keptTask(taskId)
    if (isEnded(kept)) {
      const asked = await ask(taskId, text)
      if (!asked.ok) throw new Error(asked.problem)
      return { taskId, delivered: 'next question' }
    }
    if (!attached.has(taskId)) {
      const taken = await resume(taskId, text)
      if (!taken.ok) throw new Error(taken.problem)
      return { taskId, delivered: 'taken up again' }
    }
    said(taskId, text)
    const steered = await agent.steerTask(taskId, text)
    if (!steered?.ok) throw new Error(t('task-actions.this.task.has.stopped.your.message.was'))
    return { taskId, delivered: 'into its turn' }
  }

  /**
   * What dsh reports of a task, in order: what it says and asks (streamed, no change of its own), and its turn's end.
   * The end is one change: what it said saved, how it ended kept (`ended`), and the `task.ended` event, together.
   */
  function receive(raw: unknown) {
    const event = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const taskId = typeof event.taskId === 'string' ? event.taskId : ''
    const runId = registry.runOf(taskId)
    // No task's: dsh speaks of one unknown, or no longer at work.
    if (runId === null) return
    if (event.type === 'task_end') return endRun(taskId, runId, event, 0)
    // Taken in first, its piece then, the snapshot it changed after (queued, not pushed, while it is taken in).
    depth += 1
    try {
      taskWords.receive(event)
      registry.receive(event)
    } finally {
      depth -= 1
    }
    if (depth > 0) {
      afterCommit = [...afterCommit, () => pushPiece(taskId, runId, event)]
      return
    }
    pushPiece(taskId, runId, event)
    pushQueued()
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
        // The end reaches the window once it is kept, before the snapshot of the run ended.
        afterCommit = [...afterCommit, () => pushPiece(taskId, runId, event)]
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

  /** An end still to be kept is let go: its task closed, or a new run of it begun (the end was of the run before). */
  function letEndGo(taskId: string) {
    const pending = pendingEnds.get(taskId)
    if (pending) cancel(pending.timer)
    pendingEnds.delete(taskId)
  }

  /**
   * dsh went (stopped, restarted, crashed): what tasks said is saved now; no task's session is held any more, so the
   * next message to one takes it up again in the new dsh first; those at work are interrupted. One whose end came
   * already is not: that end is still kept, on its next try.
   */
  function gone() {
    taskWords.flush()
    attached = new Set()
    registry.interrupt(new Set(pendingEnds.keys()))
  }

  /**
   * Whether that run's result is moot: the task is at work again (asked again, taken up) or at another run. A task no
   * longer known is not: one let go among the oldest ended still has its result reported (the report holds all it
   * needs); one the user closed had its report cancelled with it.
   */
  function superseded(taskId: string, runId: string): boolean {
    let task: { status: string, runId: string }
    try {
      task = (registry.query({ op: 'get', taskId }, { taskId }) as { task: { status: string, runId: string } }).task
    } catch {
      return false
    }
    return !ENDED_STATUSES.has(task.status) || task.runId !== runId
  }

  /** The report of a task's run before, which a new run or its closing makes moot. */
  const cancelReport = (entry: StoredTask | undefined) => {
    if (entry && typeof entry.runId === 'string' && entry.runId) effects?.cancel(REPORT, reportId(entry.id, entry.runId))
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
    reports: { superseded },
  }
}
export type TaskRuntime = ReturnType<typeof createTaskRuntime>
export type TaskWindow = TaskRuntime['window']
