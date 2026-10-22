import { answersFrom } from './question-state.js'
import { spinOffTarget, taskMessages } from './tasks-state.js'

/**
 * Background tasks from the window (phase 3): words about something else, said while a turn runs, move that
 * turn to the background and go as the next question (main/task-ipc.js); 撤销 moves it back and the words go
 * into it instead. While the main process moves a turn, what the agent says arrives under the turn's new place
 * before the window has moved it too, so it waits and is passed on (`deliver`) once the window has caught up.
 */
/** How long the island says a task ended (island-view.js), counted while the user is not typing. */
export const FINISHED_MS = 5000
/** While the user types, how often to look again before a task's report comes into the conversation (F). */
export const REPORT_RETRY_MS = 1000
/** While a task talks, what it said is saved at most this often, so quitting Viva loses little. */
export const SAVE_EVERY_MS = 10_000
const MOVE_FAILED = '没能挪到后台，这句插进了正在做的事'
const UNDO_FAILED = '没能撤销'
const TASK_EVENTS = new Set(['task_update', 'task_end', 'task_question', 'task_question_closed'])
const ofTask = (event) => TASK_EVENTS.has(event?.type) || Boolean(event?.taskId)

/**
 * @param {{
 *   api: object, getState: () => object, dispatch: (action: object) => void, showToast: (text: string) => void,
 *   errorMessage: (err: unknown) => string, ask: (text: string) => boolean, steer: (text: string) => boolean,
 *   deliver: (event: object) => void, isTyping?: () => boolean, later?: (run: () => void, ms: number) => void,
 * }} deps isTyping: words are in the input; later: setTimeout, for tests
 */
export function createTaskActions({ api, getState, dispatch, showToast, errorMessage, ask, steer, deliver, isTyping = () => false, later = setTimeout }) {
  /** While a move is on its way: which events wait ({ keeps }), and those that came. */
  let holding = null

  async function call(request) {
    try {
      return await request()
    } catch (err) {
      return { ok: false, problem: errorMessage(err) }
    }
  }

  function release() {
    const { events } = holding
    holding = null
    return events
  }

  /** @returns {boolean} whether the event waits for a move on its way */
  function hold(event) {
    if (!holding?.keeps(event)) return false
    holding = { ...holding, events: [...holding.events, event] }
    return true
  }

  /** The running turn goes on in the background; with `text`, those words are what moved it. */
  async function move(text) {
    const target = spinOffTarget(getState())
    if (!target || holding) return { ok: false, reason: 'idle' }
    holding = { keeps: ofTask, events: [] }
    const result = await call(() => api.spinOffTask(text === null ? target : { ...target, text }))
    if (result.ok) {
      dispatch({ type: 'task_spun', task: result.task, conversation: result.conversation, info: result.info, folds: result.folds, at: Date.now(), text })
    } else {
      console.warn('[tasks] could not move the turn to the background:', result.problem ?? result.reason)
    }
    release().forEach(deliver)
    return result
  }

  /** The running turn goes on in the background; `text` goes as the next question. Failing that, into the turn. */
  async function moveAndAsk(text) {
    const result = await move(text)
    if (result.ok) return ask(text)
    // Idle: the turn ended meanwhile, and steering sends the words as the next question.
    if (result.problem) showToast(`${MOVE_FAILED}：${result.problem}`)
    return steer(text)
  }

  /** 放到后台 on the island (D): the turn goes on in the background, and the conversation is free. */
  async function moveToBackground() {
    const result = await move(null)
    if (!result.ok && result.problem) showToast(`没能放到后台：${result.problem}`)
  }

  /**
   * 撤销: the task is the conversation on screen again, and the words that moved it go into it. What it said
   * meanwhile goes to it first; then what came for the conversation, but not from the one it leaves.
   */
  async function undoMove() {
    const move = getState().tasks.undo
    if (!move || holding) return
    holding = { keeps: () => true, events: [] }
    const result = await call(() => api.undoTask(move.taskId))
    const events = release()
    if (!result.ok) {
      events.forEach(deliver)
      showToast(result.problem ?? UNDO_FAILED)
      return
    }
    const its = (event) => event.taskId === move.taskId
    events.filter(its).forEach(deliver)
    dispatch({ type: 'task_undone', taskId: move.taskId, conversationId: result.conversation.id, info: result.info })
    events.filter((event) => !its(event) && (ofTask(event) || !event.sessionId || event.sessionId === move.taskId)).forEach(deliver)
    if (move.text) steer(move.text)
  }

  /** The island has said it long enough; not while the user types, who may not have looked up yet. */
  function settleFinished(taskId) {
    later(() => {
      if (getState().tasks.finished?.taskId !== taskId) return
      if (isTyping()) settleFinished(taskId)
      else dispatch({ type: 'task_finish_seen', taskId })
    }, FINISHED_MS)
  }

  /** What it came back with goes into the conversation, but not under the user's typing (F). */
  function showReport(taskId) {
    if (!getState().tasks.reports.some((entry) => entry.taskId === taskId && !entry.shown)) return
    if (isTyping()) later(() => showReport(taskId), REPORT_RETRY_MS)
    else dispatch({ type: 'task_report_shown', taskId })
  }

  /** 「#name …」: the words go into that task's turn; it says if they could not. */
  function steerTask(taskId, text) {
    dispatch({ type: 'task_steer', taskId, text, at: Date.now() })
    api.steerTask(taskId, text)
      .then((result) => result?.ok || showToast('这件事已经停下了，话没有送到'))
      .catch((err) => showToast(errorMessage(err)))
  }

  function save(taskId, options) {
    const task = getState().tasks.list.find((entry) => entry.id === taskId)
    if (!task) return
    api.saveTask(taskId, taskMessages(task), options)
      .catch((err) => console.error('[tasks] could not save what the task said:', errorMessage(err)))
  }

  /** Tasks with a save waiting: one each, however much they say meanwhile. */
  let saving = new Set()

  /** A task said something: saved soon, so that quitting Viva midway loses little (task-store.js). */
  function noteUpdate(taskId) {
    if (saving.has(taskId)) return
    saving = new Set([...saving, taskId])
    later(() => {
      saving = new Set([...saving].filter((id) => id !== taskId))
      save(taskId)
    }, SAVE_EVERY_MS)
  }

  /**
   * A task that ended keeps what it said, in its own part of the timeline, and how it ended, to be asked again
   * later (接着问); the island says it ended a moment.
   */
  function ended(taskId) {
    const task = getState().tasks.list.find((entry) => entry.id === taskId)
    if (!task) return
    settleFinished(taskId)
    showReport(taskId)
    save(taskId, { ended: true, status: task.status })
  }

  /**
   * What the last launch left going (task-store.js), offered in the conversation; and the tasks that had
   * ended, back as they were, to be asked again.
   */
  async function loadUnfinished() {
    const list = await call(() => api.unfinishedTasks())
    if (Array.isArray(list) && list.length) dispatch({ type: 'tasks_unfinished', list })
    const done = await call(() => api.finishedTasks())
    if (Array.isArray(done) && done.length) dispatch({ type: 'tasks_restored', list: done })
  }

  /**
   * 接着问 / 「#name …」 to a task that ended: the words are its next question, in its own session; it is back
   * at work at once. Should it not be reachable, it says why and the task is as it was.
   */
  async function askTask(taskId, text) {
    const before = getState().tasks.list.find((entry) => entry.id === taskId)
    if (!before) return
    dispatch({ type: 'task_asked', taskId, text, at: Date.now() })
    const result = await call(() => api.askTask(taskId, text))
    if (result?.ok) return
    dispatch({ type: 'task_ask_failed', task: before })
    showToast(result?.problem ?? '没能接着问')
  }

  /** 接着做: it goes on in the background, from what it had said. */
  async function resumeUnfinished(taskId) {
    const result = await call(() => api.resumeTask(taskId))
    if (!result.ok) return showToast(result.problem ?? '没能接着做')
    return dispatch({ type: 'task_resumed', task: result.task, messages: result.messages, at: Date.now() })
  }

  /** 不做了: let go, and not offered again. */
  async function forgetUnfinished(taskId) {
    await call(() => api.forgetTask(taskId))
    dispatch({ type: 'task_forgotten', taskId })
  }

  const questionOf = (taskId) => getState().tasks.list.find((task) => task.id === taskId)?.view.question ?? null

  /** Answers what a task asks; the reply joins the task at once, as in the conversation (app.js answer). */
  function answerTask(taskId, answers) {
    const question = questionOf(taskId)
    if (!question) return
    dispatch({ type: 'question_answered', taskId, questionId: question.questionId, answers, at: Date.now() })
    api.answerQuestion(question.questionId, answers)
      .then((accepted) => accepted || showToast('这个问题已经结束，回答没有送出'))
      .catch((err) => showToast(errorMessage(err)))
  }

  /** One question, one choice: picking is answering. Otherwise picks wait for 提交. */
  function pickTaskOption(taskId, id, label) {
    const question = questionOf(taskId)
    if (!question) return
    const only = question.questions.length === 1 && !question.questions[0].multiSelect
    if (only) answerTask(taskId, [{ id, selected: [label] }])
    else dispatch({ type: 'question_pick', taskId, id, label })
  }

  async function stopTask(taskId) {
    const result = await call(() => api.stopTask(taskId))
    if (result?.ok === false) showToast(result.problem)
  }

  async function closeTask(taskId) {
    const result = await call(() => api.closeTask(taskId))
    if (result?.ok === false) return showToast(result.problem)
    return dispatch({ type: 'task_closed', taskId })
  }

  return {
    hold,
    moveAndAsk,
    moveToBackground,
    ended,
    undoMove,
    stopTask,
    closeTask,
    pickTaskOption,
    steerTask,
    askTask,
    noteUpdate,
    loadUnfinished,
    resumeUnfinished,
    forgetUnfinished,
    dismissReport: (taskId) => dispatch({ type: 'task_report_dismissed', taskId }),
    submitTaskAnswer: (taskId) => {
      const question = questionOf(taskId)
      if (question) answerTask(taskId, answersFrom(question))
    },
    skipTaskQuestion: (taskId) => {
      const question = questionOf(taskId)
      if (question) answerTask(taskId, question.questions.map((item) => ({ id: item.id, selected: [] })))
    },
    toggleRoute: () => dispatch({ type: 'route_toggle' }),
  }
}
