import { t } from '../shared/i18n/translate.ts'
import type { Conversation } from './history-db.ts'
import type { IpcRegistry } from '../shared/ipc-contract.ts'
import type { StoredTask, TaskStore } from './task-store.ts'
import type { TaskRegistry } from './task-registry.ts'
import { createTaskWords, type TaskWordsDeps } from './task-words.ts'
import { MAX_MESSAGE_CHARS as MAX_TEXT_CHARS } from '../shared/text-limits.ts'

/**
 * Background tasks from the window: 后台做 starts a task in a session of its own, forked from the conversation
 * (before the turn running there, if one is), its segment hanging off the conversation, out of the timeline.
 * What the task says is kept here as it comes (task-words.ts); the window only shows it.
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
/** Tasks that ended stay to be asked again (接着问), across launches too: the latest few, until closed. */
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

/** What the background tasks need from the app: the history, the task store, the conversation on screen, the agent. */
interface TaskIpcDeps {
  registry?: TaskRegistry
  db: ReturnType<typeof import('./history-db.ts').openHistoryDb>
  store?: TaskStore
  current: () => Conversation
  agentInfo: () => { mode?: string, model?: string }
  agent: Record<'closeTask' | 'cancelTask' | 'steerTask' | 'resumeTask' | 'startTask' | 'promptTask', (...args: any[]) => any>
  /** Timers for saving what tasks say along the way (tests pass their own). */
  timers?: Pick<TaskWordsDeps, 'later' | 'cancel'>
  /** To the window: what the agent did with a task, which the window did not ask for (task_created, …). */
  announce?: (event: { type: string, [field: string]: unknown }) => void
}

export function registerTaskIpc(ipcMain: Pick<IpcRegistry, 'handle'>, { db, store = NO_STORE, registry, current, agentInfo, agent, timers = {}, announce = () => {} }: TaskIpcDeps) {
  const restoredSummary = (entry: StoredTask) => {
    const host = db.sideTaskHost(entry.segmentId)
    return { ...summaryOf(entry), ...(host ? { host } : {}) }
  }
  for (const task of store.list()) registry?.put({ ...task,
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
    end: (taskId, status) => { const task = tasks.get(taskId); if (task) keepEnded(task, status) },
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
  async function start(request: { text?: unknown, words?: unknown } | null | undefined) {
    const { text, words = null } = request ?? {}
    if (!isText(text) || (words !== null && !isText(words))) throw new Error('invalid task request')
    return begin(text, words === null ? {} : { words })
  }

  /** A task begun: from the conversation (后台做), or afresh from the agent's brief (start_background_task). */
  async function begin(text: string, how: { words?: string, afresh?: boolean }) {
    const main = current()
    const { mode, model } = agentInfo()
    if (mode === 'connecting') return { ok: false as const, problem: taskProblems().connecting }
    if ((registry?.live() ?? 0) >= MAX_RUNNING) return { ok: false as const, problem: t('main.task-ipc.full', { max: MAX_RUNNING }) }
    const started = await agent.startTask(how)
    if (!started.ok) return { ok: false as const, problem: taskProblems()[started.reason] ?? t("main.task-ipc.could.not.start.in.background", { reason: started.reason }) }
    // A conversation with only 后台做 requests has no foreground messages yet. Keep its identity too,
    // otherwise the task points at an absent parent and its history row cannot return after a restart.
    if (!db.get(main.id)) db.save(main, [], { keepEmpty: true })
    const segment = db.save(db.create({ sessionId: started.taskId, mode, model, cwd: main.cwd, parentId: main.id }), [{ role: 'user', text, receipt: null }])
    db.fold(segment.id, { into: main.id, at: db.get(main.id)?.messages.length ?? 0, kind: 'side' })
    const task = { id: started.taskId, segmentId: segment.id, title: titleOf(text), words: text }
    tasks.set(task.id, { ...task, keep: 0, next: main.id })
    attached = new Set([...attached, task.id])
    store.add({ ...task, keep: 0, next: main.id, cwd: main.cwd ?? '', startedAt: Date.now() })
    registry?.put({ ...task, cwd: main.cwd ?? '' })
    taskWords.track(task.id, [{ role: 'user', text }])
    agent.promptTask(task.id, text)
    return { ok: true as const, task }
  }

  /** Ended: kept with how it ended; beyond the latest few, the oldest are let go. */
  function keepEnded(task: StoredTask, status: string) {
    const entry = store.list().find((item) => item.id === task.id) ?? task
    store.add({ ...entry, endedAt: Date.now(), status: ENDED_STATUSES.has(status) ? status : 'done' })
    store.list().filter(isEnded).sort((a, b) => b.endedAt - a.endedAt).slice(KEEP_ENDED)
      .forEach((old) => { store.remove(old.id); registry?.remove(old.id) })
  }

  async function close(taskId: string) {
    taskById(taskId)
    taskWords.drop(taskId)
    tasks.delete(taskId)
    detach(taskId)
    store.remove(taskId)
    registry?.remove(taskId)
    await agent.closeTask(taskId)
  }

  /**
   * The tasks an earlier launch kept: back in the window as they were, with what they said, to be closed or
   * messaged by the agent. Those it quit on are interrupted; their sessions are taken up only when messaged.
   */
  function finished() {
    return store.list()
      .filter((entry) => !attached.has(entry.id))
      .flatMap((entry) => {
        const found = db.get(entry.segmentId)
        if (!found) return []
        tasks.set(entry.id, entry)
        const ended = isEnded(entry)
        return [{ task: restoredSummary(entry), status: ended ? entry.status : 'interrupted', endedAt: ended ? entry.endedAt : entry.startedAt ?? Date.now(),
          messages: found.messages.slice(entry.keep) }]
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
    store.add(going)
    tasks.set(taskId, going)
    if (!taskWords.has(taskId)) taskWords.track(taskId, db.get(kept.segmentId)?.messages.slice(kept.keep) ?? [])
    taskWords.userSaid(taskId, text)
    registry?.restart(taskId)
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
    tasks.set(taskId, kept)
    attached = new Set([...attached, taskId])
    const before = db.get(kept.segmentId)?.messages.slice(kept.keep) ?? []
    const said = [...before, { role: 'user', text: words, receipt: null }]
    taskWords.track(taskId, said)
    registry?.restart(taskId)
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

  ipcMain.handle('task:start', (_event, request) => start(request))
  ipcMain.handle('task:finished', () => finished())
  ipcMain.handle('task:close', (_event, taskId) => close(taskId))
  ipcMain.handle('task:stop', (_event, taskId) => agent.cancelTask(taskById(taskId).id))

  return {
    /** An event from the agent: what a task says, asks and how its turn ends. */
    receive: taskWords.receive,
    /** The user's answer to a question dsh took: it joins the task that asked it. */
    answer: taskWords.answer,
    /** Viva quits, or dsh went: what tasks said is saved now. */
    flush: taskWords.flush,
    /** The conversation a task hangs off (its card is there), for its result to come back to; null when not held. */
    hostOf: (taskId: string): string | null => tasks.get(taskId)?.next ?? null,
    /** The agent's own actions on tasks (viva-tasks start_background_task, stop_…, message_…). */
    agentStart,
    agentStop,
    agentMessage,
  }
}
export type TaskService = ReturnType<typeof registerTaskIpc>
