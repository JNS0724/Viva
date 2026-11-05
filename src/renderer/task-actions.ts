import { t } from '../shared/i18n/translate.ts'
import { answersFrom, type QuestionAnswer } from './question-state.ts'
import { runningTurn } from './tasks-state.ts'

/** How much of the live channel waits for a read of the tasks at most (loadKept); more, and the read is begun again. */
const MAX_HELD = 2_000
/** What the main process says (app.ts), as far as holding it for a read of the tasks reads it. */
type AgentEvent = { type?: string, taskId?: unknown, snapshot?: { taskId?: unknown }, [field: string]: unknown }

/**
 * Background tasks from the window: 后台做 starts a task of its own (backend/task-ipc.ts task:start). The task is
 * made by the snapshot that begins it, which comes before anything it says (backend/task-runtime.ts); what the call
 * answers then only settles the submission.
 */
/** A call that did not get through, or a refusal from the main process, in words for the user. */
type Failed = { ok: false, problem: string }
const isFailed = (value: unknown): value is Failed =>
  Boolean(value) && typeof value === 'object' && (value as { ok?: unknown }).ok === false && typeof (value as { problem?: unknown }).problem === 'string'

export function createTaskActions({ api, getState, dispatch, showToast, errorMessage, deliver }: Pick<ActionDeps, 'getState' | 'dispatch' | 'showToast' | 'errorMessage'> & {
  api: Pick<AgentApi, 'startTask' | 'finishedTasks' | 'answerQuestion' | 'stopTask' | 'closeTask'>,
  /** An event from the main process, reduced as app.ts reduces it (handleEvent). */
  deliver: (event: AgentEvent) => void,
}) {
  let submissionCounter = 0
  /**
   * While the tasks are read (loadKept): what the live channel says meanwhile of a task the window does not know yet,
   * in order, to be taken once the read is (the window would not take it now, the task unknown). Null when no read
   * is under way.
   */
  let held: AgentEvent[] | null = null
  /** More came while the tasks were read than is held: the read is begun again. */
  let overflowed = false

  /** What the main process answered, or why it could not be asked. */
  async function call<T>(request: () => Promise<T>): Promise<T | Failed> {
    try {
      return await request()
    } catch (err) {
      return { ok: false, problem: errorMessage(err) }
    }
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
    const result = await call(() => api.startTask(words ? { text, words } : { text }))
    if (!result.ok) {
      dispatch({ type: 'task_submit_failed', id, problem: result.problem ?? t("task-actions.could.not.start.in.the.background") })
      return false
    }
    dispatch({ type: 'task_started', task: result.task, text, submissionId: id, origin, at: Date.now() })
    return true
  }

  const taskById = (taskId: string): BackgroundTask | undefined => getState().tasks.list.find((entry: BackgroundTask) => entry.id === taskId)

  /**
   * The tasks an earlier launch kept, back as they were with what they said: ended ones, and those Viva quit on
   * (interrupted), which the agent takes up again when asked (message_background_task).
   */
  /**
   * An event from the main process, before it is reduced: while the tasks are read, one of a task the window does
   * not know yet waits for the read. True when it is held (app.ts then leaves it).
   */
  function hold(event: AgentEvent): boolean {
    if (!held) return false
    const taskId = event.snapshot?.taskId ?? event.taskId
    if (typeof taskId !== 'string' || !taskId || getState().tasks.list.some((task) => task.id === taskId)) return false
    if (held.length >= MAX_HELD) overflowed = true
    else held = [...held, event]
    return true
  }

  /**
   * The tasks an earlier launch kept, and those at work now (a reloaded window): read, and what the live channel said
   * of them meanwhile taken after, in order. A push and the answer to a call come from the main process in the order
   * it sent them, so what happened after the read is all among what waited; each piece the read already had is left
   * out by its number, the snapshots that waited bring each task to how it stands. More than can wait came: the read
   * is not taken, and begun again.
   */
  async function loadKept() {
    for (;;) {
      held = []
      overflowed = false
      const kept = await call(() => api.finishedTasks())
      const waited = held
      const lost = overflowed
      held = null
      if (lost && Array.isArray(kept)) {
        console.error('[tasks] more came while the tasks were read than could wait; reading them again')
        continue
      }
      if (Array.isArray(kept) && kept.length) dispatch({ type: 'tasks_restored', list: kept })
      for (const event of waited) deliver(event)
      return
    }
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
