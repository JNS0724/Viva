import { t } from '../shared/i18n/translate.ts'
import { answersFrom, type QuestionAnswer } from './question-state.ts'
import { runningTurn } from './tasks-state.ts'

/**
 * Background tasks from the window: 后台做 starts a task of its own (backend/task-ipc.ts task:start). What the
 * task says can arrive before the window knows the task, so it waits and is passed on (`deliver`) once it does.
 */
/** What the main process says of the agent (acp-bridge.ts), as far as holding it back reads it. */
type AgentEvent = { type?: string, taskId?: string, sessionId?: string, [field: string]: any }
/** A call that did not get through, or a refusal from the main process, in words for the user. */
type Failed = { ok: false, problem: string }
const isFailed = (value: unknown): value is Failed =>
  Boolean(value) && typeof value === 'object' && (value as { ok?: unknown }).ok === false && typeof (value as { problem?: unknown }).problem === 'string'

export function createTaskActions({ api, getState, dispatch, showToast, errorMessage, deliver }: Pick<ActionDeps, 'getState' | 'dispatch' | 'showToast' | 'errorMessage'> & {
  api: Pick<AgentApi, 'startTask' | 'finishedTasks' | 'answerQuestion' | 'stopTask' | 'closeTask'>,
  deliver: (event: AgentEvent) => void,
}) {
  let submissionCounter = 0
  let starting = 0
  const earlyTasks = new Map<string, AgentEvent[]>()

  /** What the main process answered, or why it could not be asked. */
  async function call<T>(request: () => Promise<T>): Promise<T | Failed> {
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

  const taskById = (taskId: string): BackgroundTask | undefined => getState().tasks.list.find((entry: BackgroundTask) => entry.id === taskId)

  /**
   * The tasks an earlier launch kept, back as they were with what they said: ended ones, and those Viva quit on
   * (interrupted), which the agent takes up again when asked (message_background_task).
   */
  async function loadKept() {
    const kept = await call(() => api.finishedTasks())
    if (Array.isArray(kept) && kept.length) dispatch({ type: 'tasks_restored', list: kept })
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
    if (isFailed(result)) showToast(result.problem)
  }

  async function closeTask(taskId: string) {
    const result = await call(() => api.closeTask(taskId))
    if (isFailed(result)) return showToast(result.problem)
    return dispatch({ type: 'task_closed', taskId })
  }

  return {
    hold,
    startTask,
    stopTask,
    closeTask,
    pickTaskOption,
    loadKept,
    submitTaskAnswer: (taskId: string) => {
      const question = questionOf(taskId)
      if (question) answerTask(taskId, answersFrom(question))
    },
    skipTaskQuestion: (taskId: string) => {
      const question = questionOf(taskId)
      if (question) answerTask(taskId, question.questions.map((item: QuestionItem) => ({ id: item.id, selected: [] })))
    },
  }
}
