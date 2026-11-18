import type { AgentEvent } from './agent-event-types.ts'
import { t } from '../shared/i18n/translate.ts'
import { answersFrom, type QuestionAnswer } from './question-state.ts'

/** How much of the live channel waits for a read of the tasks at most (loadKept); more, and the read is begun again. */
const MAX_HELD = 2_000
/** A read of the tasks that failed after some of what came was let go: tried again after this, twice as long each time, up to the most. */
const RETRY_MS = 500
const MAX_RETRY_MS = 10_000
/** What the main process says (app.ts), as far as holding it for a read of the tasks reads it. */


/**
 * Background tasks in the window: the agent starts them (start_background_task); each is made by the snapshot that
 * begins it, which comes before anything it says (backend/task-runtime.ts). From here they are answered, stopped,
 * closed and read back after a launch.
 */
/** A call that did not get through, or a refusal from the main process, in words for the user. */
type Failed = { ok: false, problem: string }
const isFailed = (value: unknown): value is Failed =>
  Boolean(value) && typeof value === 'object' && (value as { ok?: unknown }).ok === false && typeof (value as { problem?: unknown }).problem === 'string'

/** The task an event from the main process is of, if any. */
const taskOf = (event: AgentEvent): string | null => {
  const taskId = event.type === 'task_snapshot' ? event.snapshot.taskId : 'taskId' in event ? event.taskId : null
  return typeof taskId === 'string' && taskId ? taskId : null
}

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

export function createTaskActions({ api, getState, dispatch, showToast, errorMessage, deliver, wait = pause }: Pick<ActionDeps, 'getState' | 'dispatch' | 'showToast' | 'errorMessage'> & {
  api: Pick<AgentApi, 'finishedTasks' | 'answerQuestion' | 'stopTask' | 'closeTask'>,
  /** An event from the main process, reduced as app.ts reduces it (handleEvent). */
  deliver: (event: AgentEvent) => void,
  /** Waits before a read of the tasks is tried again (tests pass their own). */
  wait?: (ms: number) => Promise<void>,
}) {
  /**
   * While the tasks are read (loadKept): what the live channel says meanwhile of any task, in order, to be taken once
   * the read is, over it. Null when no read is under way.
   */
  let held: AgentEvent[] | null = null
  /**
   * The tasks some of whose events were let go while the tasks were read (more came than is held): the window cannot
   * go on from what it has of them, so the read is begun again and is their baseline. The others' events still wait.
   */
  let gaps = new Set<string>()
  /** Events were let go during this read: it is not taken, and is begun again. */
  let overflowed = false

  /** What the main process answered, or why it could not be asked. */
  async function call<T>(request: () => Promise<T>): Promise<T | Failed> {
    try {
      return await request()
    } catch (err) {
      return { ok: false, problem: errorMessage(err) }
    }
  }

  const taskById = (taskId: string): BackgroundTask | undefined => getState().tasks.list.find((entry: BackgroundTask) => entry.id === taskId)

  /**
   * An event from the main process, before it is reduced: while the tasks are read, any task's waits for the read,
   * known to the window or not, and follows it in order (loadKept). True when it is held (app.ts then leaves it).
   */
  function hold(event: AgentEvent): boolean {
    if (!held) return false
    const taskId = taskOf(event)
    if (!taskId) return false
    if (held.length >= MAX_HELD) {
      overflowed = true
      if (!gaps.has(taskId)) gaps = new Set([...gaps, taskId])
    } else held = [...held, event]
    return true
  }

  /**
   * The tasks an earlier launch kept, and those at work now (a reloaded window): read, and what the live channel said
   * of them meanwhile taken after, in order. A push and the answer to a call come from the main process in the order
   * it sent them, so what happened after the read is all among what waited.
   *
   * - A task the window knows already (made by the snapshot that began it, on the live channel) has its whole stream
   *   here: the read leaves it as it is, with what it did (its tools, its thoughts), and what waited follows on it.
   * - Each other task the read has is put back to it, its baseline (with the tool calls it has at work): each piece the
   *   read already had is left out by its number, the snapshots that waited bring it to how it stands.
   * - More came than can wait: the tasks whose events were let go (`gaps`) are not whole here, known or not, so the read
   *   is begun again and is their baseline (one it no longer has is gone, and leaves the window); what waited of the
   *   others still waits. One that fails then is tried again,
   *   with a wait, until one is read: the handoff does not end on a part of what came.
   */
  async function loadKept() {
    held = []
    gaps = new Set()
    let failures = 0
    for (;;) {
      overflowed = false
      const kept = await call(() => api.finishedTasks())
      const failed = !Array.isArray(kept)
      if (overflowed || (failed && gaps.size)) {
        // What waited of a task with a gap is in the next read; the rest goes on waiting, for the tasks kept as they are.
        held = (held ?? []).filter((event) => !gaps.has(taskOf(event) ?? ''))
        if (overflowed) console.error('[tasks] more came while the tasks were read than could wait; reading them again')
        else {
          console.error('[tasks] the tasks could not be read after some of what came was let go; reading them again', isFailed(kept) ? kept.problem : kept)
          await wait(Math.min(RETRY_MS * 2 ** failures, MAX_RETRY_MS))
          failures += 1
        }
        continue
      }
      const waited = held ?? []
      held = null
      const known = new Set(getState().tasks.list.map((task: BackgroundTask) => task.id))
      const taken = failed ? [] : kept.filter((entry) => gaps.has(entry.task.id) || !known.has(entry.task.id))
      // A task with a gap the read no longer has is gone from the backend (closed, or let go among the oldest ended):
      // nothing will bring the window's part of it up to date, so it goes, as it would at the next launch.
      const gone = failed ? [] : [...gaps].filter((taskId) => known.has(taskId) && !kept.some((entry) => entry.task.id === taskId))
      gaps = new Set()
      for (const taskId of gone) dispatch({ type: 'task_closed', taskId })
      if (taken.length) dispatch({ type: 'tasks_restored', list: taken })
      for (const event of waited) deliver(event)
      return
    }
  }

  const questionOf = (taskId: string) => taskById(taskId)?.view.question ?? null

  /** Answers what a task asks; the reply joins the task at once, as in the conversation (app.js answer). */
  function answerTask(taskId: string, answers: QuestionAnswer[]) {
    const question = questionOf(taskId)
    if (!question) return
    dispatch({ type: 'task_question_answered', taskId, questionId: question.questionId, answers, at: Date.now() })
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
    else dispatch({ type: 'task_question_pick', taskId, id, label })
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
