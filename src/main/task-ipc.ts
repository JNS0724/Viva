import type { Conversation } from './history-db.ts'
import type { IpcRegistry } from './ipc-contract.ts'
import type { StoredTask, TaskStore } from './task-store.ts'
import type { TaskRegistry } from './task-registry.ts'

/**
 * Background tasks from the window (phase 3). While a turn runs, words about something else move it to the
 * background: it goes on in its own session as a task (acp-bridge.js spinOff), its segment of the timeline
 * folds there as a task, and the conversation goes on in a new segment with what came before it and the new
 * words. Undone, it all goes back as it was. The window keeps what the task says and saves it here.
 */
const MAX_TEXT_CHARS = 20_000
const MAX_TITLE_CHARS = 40

export const TASK_PROBLEMS: Readonly<Record<string, string>> & { unsaved: string, going: string, gone: string, lost: string } = Object.freeze({
  unsaved: '这句话还没有保存好，就在这里接着说吧',
  invalid: '在助手的记录里找不到正在做的这件事',
  missing: '当前对话已经结束，请稍后再试',
  unavailable: '这个版本的助手不支持后台任务，请更新 Viva',
  lost: '这件事接不上了：上次的记录找不到，可以选「不做了」',
  gone: '这件事接不上了：上次的记录找不到，可以关掉它',
  going: '这件还在做，直接说就会插进去',
})

/** What a task taken up again is told: Viva was closed while it worked. */
const GO_ON = '刚才 Viva 关掉了，请接着做没做完的事。'
/** Without a store (tests that do not need one), nothing is kept between launches. */
const NO_STORE: TaskStore = Object.freeze({ list: () => [], add: () => {}, remove: () => {} })
/** Tasks that ended stay to be asked again (接着问), across launches too: the latest few, until closed. */
/**
 * Ended tasks kept to be asked again, the latest so many: the user no longer closes each one once read (a task
 * seen stops reminding), so enough are kept that the 后台 page's 做完了 rarely offers one already let go.
 */
export const KEEP_ENDED = 30
const ENDED_STATUSES = new Set(['done', 'stopped', 'error'])

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isEnded = (entry: StoredTask | null | undefined) => Number.isFinite(entry?.endedAt)
const summaryOf = ({ id, segmentId, title, words }: StoredTask) => ({ id, segmentId, title, words })
const titleOf = (words: string) => {
  const line = words.trim().split('\n')[0]
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS)}…` : line
}

/**
 * words: what started the running turn; keep: saved messages before it; text: the words about something
 * else, or none when the turn is just put in the background (the island's 放到后台).
 */
function checked(request: { words?: unknown, keep?: unknown, text?: unknown } | null | undefined) {
  const { words, keep, text = null } = request ?? {}
  if (!isText(words) || !isCount(keep) || (text !== null && !isText(text))) throw new Error('invalid task request')
  return { words, keep, text }
}

/** What the background tasks need from the app: the history, the task store, the conversation on screen, the agent. */
interface TaskIpcDeps {
  registry?: TaskRegistry
  db: ReturnType<typeof import('./history-db.ts').openHistoryDb>
  store?: TaskStore
  current: () => Conversation
  setCurrent: (conversation: Conversation) => void
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  agentInfo: () => { mode?: string, model?: string }
  agent: Record<'spinOff' | 'mergeBack' | 'closeTask' | 'cancelTask' | 'steerTask' | 'resumeTask' | 'startTask' | 'promptTask', (...args: any[]) => any>
}

export function registerTaskIpc(ipcMain: Pick<IpcRegistry, 'handle'>, { db, store = NO_STORE, registry, current, setCurrent, isBusy, setBusy, agentInfo, agent }: TaskIpcDeps) {
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

  const taskById = (taskId: unknown) => {
    const task = tasks.get(taskId as string)
    if (!task) throw new Error('no such task')
    return task
  }

  async function spinOff(request: Parameters<typeof checked>[0]) {
    const { words, keep, text } = checked(request)
    if (!isBusy()) return { ok: false, reason: 'idle' }
    const previous = current()
    const stored = db.get(previous.id)
    if (!stored || stored.messages[keep]?.text !== words) return { ok: false, problem: TASK_PROBLEMS.unsaved }
    const spun = await agent.spinOff({ words })
    if (!spun.ok) return { ok: false, problem: TASK_PROBLEMS[spun.reason] ?? `没能放到后台（${spun.reason}）` }
    setBusy(false)
    const kept = stored.messages.slice(0, keep)
    const { mode, model } = { ...agentInfo(), ...spun.info }
    const next = db.save(
      // The conversation goes on in the same topic, the moved turn hanging off it as one of its tasks.
      db.create({ sessionId: spun.info.sessionId, mode, model, cwd: previous.cwd, parentId: previous.parentId, topicId: db.topicOf(previous.id) }),
      text === null ? kept : [...kept, { role: 'user', text, receipt: null }],
    )
    db.fold(previous.id, { into: next.id, at: keep, kind: 'task' })
    setCurrent(next)
    const task = { id: spun.taskId, segmentId: previous.id, title: titleOf(words), words }
    tasks.set(task.id, { ...task, keep, next: next.id })
    attached = new Set([...attached, task.id])
    // Kept on disk while it goes on: should Viva quit first, the next launch offers it again.
    store.add({ ...task, keep, next: next.id, cwd: previous.cwd ?? '', startedAt: Date.now() })
    registry?.put({ ...task, cwd: previous.cwd ?? '' })
    return { ok: true, task, info: spun.info, conversation: { id: next.id, messages: kept }, folds: db.foldsOf(next.id) }
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
    const main = current()
    const { mode, model } = agentInfo()
    const started = await agent.startTask(words === null ? {} : { words })
    if (!started.ok) return { ok: false, problem: TASK_PROBLEMS[started.reason] ?? `没能交给后台（${started.reason}）` }
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
    agent.promptTask(task.id, text)
    return { ok: true, task }
  }

  /**
   * What the task has said, from the words that started it on: kept after what came before them. Saved along
   * the way and at its end; ended, it stays in the store marked so, to be asked again (`ask`).
   */
  function save(taskId: string, messages: readonly unknown[], { ended = false, status = 'done' }: { ended?: boolean, status?: string } = {}) {
    const task = taskById(taskId)
    const found = db.get(task.segmentId)
    if (!found) throw new Error('no such task')
    db.save(found.conversation, [...found.messages.slice(0, task.keep), ...messages])
    if (ended) keepEnded(task, status)
  }

  /** Ended: kept with how it ended; beyond the latest few, the oldest are let go. */
  function keepEnded(task: StoredTask, status: string) {
    const entry = store.list().find((item) => item.id === task.id) ?? task
    store.add({ ...entry, endedAt: Date.now(), status: ENDED_STATUSES.has(status) ? status : 'done' })
    store.list().filter(isEnded).sort((a, b) => b.endedAt - a.endedAt).slice(KEEP_ENDED)
      .forEach((old) => { store.remove(old.id); registry?.remove(old.id) })
  }

  async function undo(taskId: string) {
    const task = taskById(taskId)
    const back = await agent.mergeBack(taskId)
    if (!back.ok) return { ok: false, problem: TASK_PROBLEMS[back.reason] ?? '没能撤销' }
    tasks.delete(taskId)
    detach(taskId)
    store.remove(taskId)
    registry?.remove(taskId)
    db.unfold(task.segmentId)
    db.softDelete(task.next)
    const found = db.get(task.segmentId)
    if (!found) throw new Error('no such task')
    setCurrent(found.conversation)
    setBusy(true)
    return { ok: true, info: back.info, conversation: { id: found.conversation.id, messages: found.messages } }
  }

  async function close(taskId: string) {
    taskById(taskId)
    tasks.delete(taskId)
    detach(taskId)
    store.remove(taskId)
    registry?.remove(taskId)
    await agent.closeTask(taskId)
  }

  /** Tasks an earlier launch left going (task-store.js): offered at the start, to take up or let go. */
  const unfinished = () => store.list()
    .filter((entry) => !tasks.has(entry.id) && !isEnded(entry))
    .map(({ id, title, segmentId, startedAt }) => ({ id, title, segmentId, startedAt }))

  /**
   * Tasks that had ended by an earlier launch: back in the window as they were, with what they said, to be
   * asked again or closed. Their sessions are taken up only when asked.
   */
  function finished() {
    return store.list()
      .filter((entry) => isEnded(entry) && !attached.has(entry.id))
      .flatMap((entry) => {
        const found = db.get(entry.segmentId)
        if (!found) return []
        tasks.set(entry.id, entry)
        return [{ task: restoredSummary(entry), status: entry.status, endedAt: entry.endedAt, messages: found.messages.slice(entry.keep) }]
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
    if (!kept) return { ok: false, problem: TASK_PROBLEMS.gone }
    if (!isEnded(kept)) return { ok: false, problem: TASK_PROBLEMS.going }
    if (!attached.has(taskId)) {
      const taken = await agent.resumeTask({ taskId, ...(kept.cwd ? { cwd: kept.cwd } : {}) })
      if (!taken.ok) return { ok: false, problem: TASK_PROBLEMS.gone }
      attached = new Set([...attached, taskId])
    }
    const { endedAt: _endedAt, status: _status, ...going } = kept
    store.add(going)
    tasks.set(taskId, going)
    registry?.restart(taskId)
    agent.promptTask(taskId, text)
    return { ok: true }
  }

  /**
   * Taken up again: its dsh session is reattached as a task and asked to go on; the window gets what it had
   * said, from its own words on, to show it as it was.
   */
  async function resume(taskId: string) {
    const kept = store.list().find((entry) => entry.id === taskId)
    if (!kept) throw new Error('no such task')
    const taken = await agent.resumeTask({ taskId, ...(kept.cwd ? { cwd: kept.cwd } : {}) })
    if (!taken.ok) return { ok: false, problem: TASK_PROBLEMS.lost }
    tasks.set(taskId, kept)
    attached = new Set([...attached, taskId])
    registry?.restart(taskId)
    agent.promptTask(taskId, GO_ON)
    const said = db.get(kept.segmentId)?.messages.slice(kept.keep) ?? []
    return { ok: true, task: restoredSummary(kept), messages: said }
  }

  ipcMain.handle('task:spin-off', (_event, request) => spinOff(request))
  ipcMain.handle('task:start', (_event, request) => start(request))
  ipcMain.handle('task:save', async (_event, taskId, messages, options) => save(taskId, messages, options))
  ipcMain.handle('task:unfinished', () => unfinished())
  ipcMain.handle('task:finished', () => finished())
  ipcMain.handle('task:ask', (_event, taskId, text) => ask(taskId, text))
  ipcMain.handle('task:resume', (_event, taskId) => resume(taskId))
  ipcMain.handle('task:forget', (_event, taskId) => { store.remove(taskId); registry?.remove(taskId) })
  ipcMain.handle('task:undo', (_event, taskId) => undo(taskId))
  ipcMain.handle('task:close', (_event, taskId) => close(taskId))
  ipcMain.handle('task:stop', (_event, taskId) => agent.cancelTask(taskById(taskId).id))
  ipcMain.handle('task:steer', (_event, taskId, text) => {
    if (!isText(text)) throw new Error('invalid task request')
    return agent.steerTask(taskById(taskId).id, text)
  })
}
