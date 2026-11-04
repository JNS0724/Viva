import { t } from '../shared/i18n/translate.ts'
import { answersFrom, type QuestionAnswer } from './question-state.ts'
import { runningTurn, taskMessages } from './tasks-state.ts'

/**
 * Background tasks from the window: 后台做 starts a task of its own (backend/task-ipc.ts task:start). What the
 * task says can arrive before the window knows the task, so it waits and is passed on (`deliver`) once it does.
 */
/** While a task talks, what it said is saved at most this often, so quitting Viva loses little. */
export const SAVE_EVERY_MS = 10_000
/** What the main process says of the agent (acp-bridge.ts), as far as holding it back reads it. */
type AgentEvent = { type?: string, taskId?: string, sessionId?: string, [field: string]: any }

/** later: setTimeout, for tests. */
export function createTaskActions({ api, getState, dispatch, showToast, errorMessage, deliver, later = setTimeout }: Pick<ActionDeps, 'getState' | 'dispatch' | 'showToast' | 'errorMessage'> & {
  api: Pick<AgentApi, 'startTask' | 'steerTask' | 'saveTask' | 'unfinishedTasks' | 'finishedTasks'
    | 'askTask' | 'resumeTask' | 'forgetTask' | 'answerQuestion' | 'stopTask' | 'closeTask'>,
  deliver: (event: AgentEvent) => void, later?: (run: () => void, ms: number) => unknown,
}) {
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

  /** @returns {boolean} whether the event waits for a task being started */
  function hold(event: AgentEvent) {
    if (!starting || !event.taskId || getState().tasks.list.some(task => task.id === event.taskId)) return false
    earlyTasks.set(event.taskId, [...(earlyTasks.get(event.taskId) ?? []), event])
    return true
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
    const words = runningTurn(getState())?.words
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

  /** Words for a task (typed on its page): they go into its turn; it says if they could not. */
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
   * later (接着问).
   */
  function ended(taskId: string) {
    const task = taskById(taskId)
    if (!task) return
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
   * 接着问 to a task that ended: the words are its next question, in its own session; it is back
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
    startTask,
    ended,
    stopTask,
    closeTask,
    pickTaskOption,
    steerTask,
    askTask,
    noteUpdate,
    loadUnfinished,
    resumeUnfinished,
    forgetUnfinished,
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
  }
}
