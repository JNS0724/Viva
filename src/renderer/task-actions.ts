import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import { answersFrom, type QuestionAnswer } from './question-state.ts'
import { spinOffTarget, taskMessages } from './tasks-state.ts'

/**
 * Background tasks from the window (phase 3): 后台做, or words about something else said while a turn runs,
 * start a task of their own (main/task-ipc.js task:start); 放到后台 moves the running turn there instead, and
 * 撤销 moves it back. While the main process moves a turn, what the agent says arrives under the turn's new
 * place before the window has moved it too, so it waits and is passed on (`deliver`) once the window caught up.
 */
/** How long the island says a task ended (island-view.js), counted while the user is not typing. */
export const FINISHED_MS = 5000
/** While the user types, how often to look again before a task's report comes into the conversation (F). */
export const REPORT_RETRY_MS = 1000
/** While a task talks, what it said is saved at most this often, so quitting Viva loses little. */
export const SAVE_EVERY_MS = 10_000
let UNDO_FAILED = t("task-actions.could.not.undo")
const TASK_EVENTS = new Set(['task_update', 'task_end', 'task_question', 'task_question_closed'])
/** What the main process says of the agent (acp-bridge.ts), as far as holding it back reads it. */
type AgentEvent = { type?: string, taskId?: string, sessionId?: string, [field: string]: any }
const ofTask = (event: AgentEvent | null | undefined) => TASK_EVENTS.has(event?.type ?? '') || Boolean(event?.taskId)

/** isTyping: words are in the input; later: setTimeout, for tests. */
export function createTaskActions({ api, getState, dispatch, showToast, errorMessage, deliver, isTyping = () => false, later = setTimeout }: Pick<ActionDeps, 'getState' | 'dispatch' | 'showToast' | 'errorMessage'> & {
  api: Pick<AgentApi, 'spinOffTask' | 'startTask' | 'undoTask' | 'steerTask' | 'saveTask' | 'unfinishedTasks' | 'finishedTasks'
    | 'askTask' | 'resumeTask' | 'forgetTask' | 'answerQuestion' | 'stopTask' | 'closeTask'>,
  deliver: (event: AgentEvent) => void, isTyping?: () => boolean, later?: (run: () => void, ms: number) => unknown,
}) {
  /** While a move is on its way: which events wait ({ keeps }), and those that came. */
  let holding: { keeps: (event: AgentEvent) => boolean, events: AgentEvent[] } | null = null
  let submissionCounter = 0
  let starting = 0
  const earlyTasks = new Map<string, AgentEvent[]>()

  /** What the main process answered, or why it could not be asked. */
  async function call(request: () => Promise<any>): Promise<any> {
    try {
      return await request()
    } catch (err) {
      return { ok: false, problem: errorMessage(err) }
    }
  }

  function release() {
    const events = holding?.events ?? []
    holding = null
    return events
  }

  /** @returns {boolean} whether the event waits for a move on its way */
  function hold(event: AgentEvent) {
    if (starting && event.taskId && !getState().tasks.list.some(task => task.id === event.taskId)) {
      earlyTasks.set(event.taskId, [...(earlyTasks.get(event.taskId) ?? []), event])
      return true
    }
    if (!holding?.keeps(event)) return false
    holding = { ...holding, events: [...holding.events, event] }
    return true
  }

  /** The running turn goes on in the background. */
  async function move() {
    const target = spinOffTarget(getState())
    if (!target || holding) return { ok: false, reason: 'idle' }
    dispatch({ type: 'task_moving', moving: true })
    holding = { keeps: ofTask, events: [] }
    const result = await call(() => api.spinOffTask(target))
    if (result.ok) {
      dispatch({ type: 'task_spun', task: result.task, conversation: result.conversation, info: result.info, folds: result.folds, at: Date.now() })
    } else {
      console.warn('[tasks] could not move the turn to the background:', result.problem ?? result.reason)
    }
    release().forEach(deliver)
    dispatch({ type: 'task_moving', moving: false })
    return result
  }

  /**
   * 后台做: the words go to a task of their own, from the conversation so far (before the turn running, if one
   * is); the conversation on screen goes on as it was.
   * @returns {Promise<boolean>} whether the task started
   */
  async function startTask(text: string, retryId?: string) {
    const origin = getState().info.sessionId ?? null
    const previous = getState().tasks.submissions.find(item => item.id === retryId)
    if (previous && previous.origin !== origin) {
      showToast(t("task-actions.return.to.the.topic.where.you.submitted"))
      return false
    }
    const id = retryId ?? `submission-${Date.now()}-${++submissionCounter}`
    const words = spinOffTarget(getState())?.words
    dispatch({ type: 'task_submitting', submission: { id, text, origin, status: 'pending' } })
    starting++
    const result = await call(() => api.startTask(words ? { text, words } : { text }))
    if (!result.ok) {
      dispatch({ type: 'task_submit_failed', id, problem: result.problem ?? t("task-actions.could.not.start.in.the.background") })
      starting--
      if (!starting) { const events = [...earlyTasks.values()].flat(); earlyTasks.clear(); events.forEach(deliver) }
      return false
    }
    dispatch({ type: 'task_started', task: result.task, text, submissionId: id, origin, at: Date.now() })
    const events = earlyTasks.get(result.task.id) ?? []
    earlyTasks.delete(result.task.id)
    starting--
    events.forEach(deliver)
    if (!starting) { const rest = [...earlyTasks.values()].flat(); earlyTasks.clear(); rest.forEach(deliver) }
    return true
  }

  /** 放到后台 (the island's, D; beside a long turn, E): the turn goes on in the background, and the conversation is free. */
  async function moveToBackground() {
    const result = await move()
    if (!result.ok && result.problem) showToast(t("task-actions.could.not.move.to.background", { problem: result.problem }))
  }

  /**
   * 撤销: the task is the conversation on screen again. What it said meanwhile goes to it first; then what came
   * for the conversation, but not from the one it leaves.
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
    const its = (event: AgentEvent) => event.taskId === move.taskId
    events.filter(its).forEach(deliver)
    dispatch({ type: 'task_undone', taskId: move.taskId, conversationId: result.conversation.id, info: result.info })
    events.filter((event) => !its(event) && (ofTask(event) || !event.sessionId || event.sessionId === move.taskId)).forEach(deliver)
  }

  /** The island has said it long enough; not while the user types, who may not have looked up yet. */
  function settleFinished(taskId: string) {
    later(() => {
      if (getState().tasks.finished?.taskId !== taskId) return
      if (isTyping()) settleFinished(taskId)
      else dispatch({ type: 'task_finish_seen', taskId })
    }, FINISHED_MS)
  }

  /** What it came back with goes into the conversation, but not under the user's typing (F). */
  function showReport(taskId: string) {
    if (!getState().tasks.reports.some((entry: TaskReport) => entry.taskId === taskId && !entry.shown)) return
    if (isTyping()) later(() => showReport(taskId), REPORT_RETRY_MS)
    else dispatch({ type: 'task_report_shown', taskId })
  }

  /** 「#name …」: the words go into that task's turn; it says if they could not. */
  function steerTask(taskId: string, text: string) {
    dispatch({ type: 'task_steer', taskId, text, at: Date.now() })
    api.steerTask(taskId, text)
      .then((result: { ok?: boolean } | null) => result?.ok || showToast(t("task-actions.this.task.has.stopped.your.message.was")))
      .catch((err: unknown) => showToast(errorMessage(err)))
  }

  const taskById = (taskId: string): BackgroundTask | undefined => getState().tasks.list.find((entry: BackgroundTask) => entry.id === taskId)

  function save(taskId: string, options?: { ended?: boolean, status?: string }) {
    const task = taskById(taskId)
    if (!task) return
    api.saveTask(taskId, taskMessages(task), options)
      .catch((err: unknown) => console.error('[tasks] could not save what the task said:', errorMessage(err)))
  }

  /** Tasks with a save waiting: one each, however much they say meanwhile. */
  let saving = new Set<string>()

  /** A task said something: saved soon, so that quitting Viva midway loses little (task-store.js). */
  function noteUpdate(taskId: string) {
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
  function ended(taskId: string) {
    const task = taskById(taskId)
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
  async function askTask(taskId: string, text: string) {
    const before = taskById(taskId)
    if (!before) return false
    dispatch({ type: 'task_asked', taskId, text, at: Date.now() })
    const result = await call(() => api.askTask(taskId, text))
    if (result?.ok) return true
    dispatch({ type: 'task_ask_failed', task: before })
    showToast(result?.problem ?? t("task-actions.could.not.continue.asking"))
    return false
  }

  /** 接着做: it goes on in the background, from what it had said. */
  async function resumeUnfinished(taskId: string) {
    const result = await call(() => api.resumeTask(taskId))
    if (!result.ok) return showToast(result.problem ?? t("task-actions.could.not.continue"))
    return dispatch({ type: 'task_resumed', task: result.task, messages: result.messages, at: Date.now() })
  }

  /** 不做了: let go, and not offered again. */
  async function forgetUnfinished(taskId: string) {
    await call(() => api.forgetTask(taskId))
    dispatch({ type: 'task_forgotten', taskId })
  }

  const questionOf = (taskId: string) => taskById(taskId)?.view.question ?? null

  /** Answers what a task asks; the reply joins the task at once, as in the conversation (app.js answer). */
  function answerTask(taskId: string, answers: QuestionAnswer[]) {
    const question = questionOf(taskId)
    if (!question) return
    dispatch({ type: 'question_answered', taskId, questionId: question.questionId, answers, at: Date.now() })
    api.answerQuestion(question.questionId, answers)
      .then((accepted: boolean) => accepted || showToast(t("app.this.question.has.ended.your.answer.was")))
      .catch((err: unknown) => showToast(errorMessage(err)))
  }

  /** One question, one choice: picking is answering. Otherwise picks wait for 提交. */
  function pickTaskOption(taskId: string, id: string, label: string) {
    const question = questionOf(taskId)
    if (!question) return
    const only = question.questions.length === 1 && !question.questions[0].multiSelect
    if (only) answerTask(taskId, [{ id, selected: [label] }])
    else dispatch({ type: 'question_pick', taskId, id, label })
  }

  async function stopTask(taskId: string) {
    const result = await call(() => api.stopTask(taskId))
    if (result?.ok === false) showToast(result.problem)
  }

  async function closeTask(taskId: string) {
    const result = await call(() => api.closeTask(taskId))
    if (result?.ok === false) return showToast(result.problem)
    return dispatch({ type: 'task_closed', taskId })
  }

  return {
    hold,
    moveToBackground,
    startTask,
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
    dismissReport: (taskId: string) => dispatch({ type: 'task_report_dismissed', taskId }),
    submitTaskAnswer: (taskId: string) => {
      const question = questionOf(taskId)
      if (question) answerTask(taskId, answersFrom(question))
    },
    /** Typed on the 后台 page while the task asks: the answer, as typing in the composer is for the conversation's. */
    typeTaskAnswer: (taskId: string, text: string) => {
      const question = questionOf(taskId)
      if (question) answerTask(taskId, answersFrom(question, text))
    },
    skipTaskQuestion: (taskId: string) => {
      const question = questionOf(taskId)
      if (question) answerTask(taskId, question.questions.map((item: QuestionItem) => ({ id: item.id, selected: [] })))
    },
    toggleRoute: () => dispatch({ type: 'route_toggle' }),
  }
}

onLocaleChange(() => {
  UNDO_FAILED = t("task-actions.could.not.undo")
})
