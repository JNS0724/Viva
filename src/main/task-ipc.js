/**
 * Background tasks from the window (phase 3). While a turn runs, words about something else move it to the
 * background: it goes on in its own session as a task (acp-bridge.js spinOff), its segment of the timeline
 * folds there as a task, and the conversation goes on in a new segment with what came before it and the new
 * words. Undone, it all goes back as it was. The window keeps what the task says and saves it here.
 */
const MAX_TEXT_CHARS = 20_000
const MAX_TITLE_CHARS = 40

export const TASK_PROBLEMS = Object.freeze({
  unsaved: '这句话还没有保存好，就在这里接着说吧',
  invalid: '在助手的记录里找不到正在做的这件事',
  missing: '当前对话已经结束，请稍后再试',
  unavailable: '这个版本的助手不支持后台任务，请更新 Viva',
  lost: '这件事接不上了：上次的记录找不到，可以选「不做了」',
})

/** What a task taken up again is told: Viva was closed while it worked. */
const GO_ON = '刚才 Viva 关掉了，请接着做没做完的事。'
/** Without a store (tests that do not need one), nothing is kept between launches. */
const NO_STORE = Object.freeze({ list: () => [], add: () => {}, remove: () => {} })

const isText = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const titleOf = (words) => {
  const line = words.trim().split('\n')[0]
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS)}…` : line
}

/**
 * words: what started the running turn; keep: saved messages before it; text: the words about something
 * else, or none when the turn is just put in the background (the island's 放到后台).
 */
function checked(request) {
  const { words, keep, text = null } = request ?? {}
  if (!isText(words) || !isCount(keep) || (text !== null && !isText(text))) throw new Error('invalid task request')
  return { words, keep, text }
}

/**
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {{
 *   db: ReturnType<import('./history-db.js').openHistoryDb>,
 *   current: () => object, setCurrent: (conversation: object) => void,
 *   isBusy: () => boolean, setBusy: (busy: boolean) => void, agentInfo: () => { mode?: string, model?: string },
 *   agent: { spinOff: Function, mergeBack: Function, closeTask: Function, cancelTask: Function, steerTask: Function },
 * }} deps
 */
export function registerTaskIpc(ipcMain, { db, store = NO_STORE, current, setCurrent, isBusy, setBusy, agentInfo, agent }) {
  /** taskId → { id, segmentId, title, words, keep, next } (next: the segment the conversation went on in) */
  const tasks = new Map()

  const taskById = (taskId) => {
    const task = tasks.get(taskId)
    if (!task) throw new Error('no such task')
    return task
  }

  async function spinOff(request) {
    const { words, keep, text } = checked(request)
    if (!isBusy()) return { ok: false, reason: 'idle' }
    const previous = current()
    const stored = db.get(previous.id)
    if (stored?.messages[keep]?.text !== words) return { ok: false, problem: TASK_PROBLEMS.unsaved }
    const spun = await agent.spinOff({ words })
    if (!spun.ok) return { ok: false, problem: TASK_PROBLEMS[spun.reason] ?? `没能放到后台（${spun.reason}）` }
    setBusy(false)
    const kept = stored.messages.slice(0, keep)
    const { mode, model } = { ...agentInfo(), ...spun.info }
    const next = db.save(
      db.create({ sessionId: spun.info.sessionId, mode, model, cwd: previous.cwd, parentId: previous.parentId }),
      text === null ? kept : [...kept, { role: 'user', text, receipt: null }],
    )
    db.fold(previous.id, { into: next.id, at: keep, kind: 'task' })
    setCurrent(next)
    const task = { id: spun.taskId, segmentId: previous.id, title: titleOf(words), words }
    tasks.set(task.id, { ...task, keep, next: next.id })
    // Kept on disk while it goes on: should Viva quit first, the next launch offers it again.
    store.add({ ...task, keep, next: next.id, cwd: previous.cwd ?? '', startedAt: Date.now() })
    return { ok: true, task, info: spun.info, conversation: { id: next.id, messages: kept }, folds: db.foldsOf(next.id) }
  }

  /**
   * What the task has said, from the words that started it on: kept after what came before them. Saved along
   * the way and at its end; ended, it is let go from the store.
   */
  function save(taskId, messages, { ended = false } = {}) {
    const task = taskById(taskId)
    const found = db.get(task.segmentId)
    if (!found) throw new Error('no such task')
    db.save(found.conversation, [...found.messages.slice(0, task.keep), ...messages])
    if (ended) store.remove(taskId)
  }

  async function undo(taskId) {
    const task = taskById(taskId)
    const back = await agent.mergeBack(taskId)
    if (!back.ok) return { ok: false, problem: TASK_PROBLEMS[back.reason] ?? '没能撤销' }
    tasks.delete(taskId)
    store.remove(taskId)
    db.unfold(task.segmentId)
    db.softDelete(task.next)
    const found = db.get(task.segmentId)
    setCurrent(found.conversation)
    setBusy(true)
    return { ok: true, info: back.info, conversation: { id: found.conversation.id, messages: found.messages } }
  }

  async function close(taskId) {
    taskById(taskId)
    tasks.delete(taskId)
    store.remove(taskId)
    await agent.closeTask(taskId)
  }

  /** Tasks an earlier launch left going (task-store.js): offered at the start, to take up or let go. */
  const unfinished = () => store.list()
    .filter((entry) => !tasks.has(entry.id))
    .map(({ id, title, segmentId, startedAt }) => ({ id, title, segmentId, startedAt }))

  /**
   * Taken up again: its dsh session is reattached as a task and asked to go on; the window gets what it had
   * said, from its own words on, to show it as it was.
   */
  async function resume(taskId) {
    const kept = store.list().find((entry) => entry.id === taskId)
    if (!kept) throw new Error('no such task')
    const taken = await agent.resumeTask({ taskId, ...(kept.cwd ? { cwd: kept.cwd } : {}) })
    if (!taken.ok) return { ok: false, problem: TASK_PROBLEMS.lost }
    tasks.set(taskId, kept)
    agent.promptTask(taskId, GO_ON)
    const said = db.get(kept.segmentId)?.messages.slice(kept.keep) ?? []
    return { ok: true, task: { id: kept.id, segmentId: kept.segmentId, title: kept.title, words: kept.words }, messages: said }
  }

  ipcMain.handle('task:spin-off', (_event, request) => spinOff(request))
  ipcMain.handle('task:save', async (_event, taskId, messages, options) => save(taskId, messages, options))
  ipcMain.handle('task:unfinished', () => unfinished())
  ipcMain.handle('task:resume', (_event, taskId) => resume(taskId))
  ipcMain.handle('task:forget', (_event, taskId) => store.remove(taskId))
  ipcMain.handle('task:undo', (_event, taskId) => undo(taskId))
  ipcMain.handle('task:close', (_event, taskId) => close(taskId))
  ipcMain.handle('task:stop', (_event, taskId) => agent.cancelTask(taskById(taskId).id))
  ipcMain.handle('task:steer', (_event, taskId, text) => {
    if (!isText(text)) throw new Error('invalid task request')
    return agent.steerTask(taskById(taskId).id, text)
  })
}
