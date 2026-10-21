import { spinOffTarget, taskMessages } from './tasks-state.js'

/**
 * Background tasks from the window (phase 3): words about something else, said while a turn runs, move that
 * turn to the background and go as the next question (main/task-ipc.js); 撤销 moves it back and the words go
 * into it instead. While the main process moves a turn, what the agent says arrives under the turn's new place
 * before the window has moved it too, so it waits and is passed on (`deliver`) once the window has caught up.
 */
/** How long the island says a task ended (island-view.js), counted while the user is not typing. */
export const FINISHED_MS = 5000
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

  /** The running turn goes on in the background; `text` goes as the next question. Failing that, into the turn. */
  async function moveAndAsk(text) {
    const target = spinOffTarget(getState())
    if (!target || holding) return steer(text)
    holding = { keeps: ofTask, events: [] }
    const result = await call(() => api.spinOffTask({ ...target, text }))
    if (result.ok) {
      dispatch({ type: 'task_spun', task: result.task, conversation: result.conversation, info: result.info, folds: result.folds, at: Date.now(), text })
    }
    release().forEach(deliver)
    if (result.ok) return ask(text)
    // Idle: the turn ended meanwhile, and steering sends the words as the next question.
    console.warn('[tasks] could not move the turn to the background:', result.problem ?? result.reason)
    if (result.problem) showToast(`${MOVE_FAILED}：${result.problem}`)
    return steer(text)
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

  /** A task that ended keeps what it said, in its own part of the timeline; the island says it ended a moment. */
  function ended(taskId) {
    const task = getState().tasks.list.find((entry) => entry.id === taskId)
    if (!task) return
    settleFinished(taskId)
    api.saveTask(taskId, taskMessages(task))
      .catch((err) => console.error('[tasks] could not save what the task said:', errorMessage(err)))
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
    ended,
    undoMove,
    stopTask,
    closeTask,
    toggleRoute: () => dispatch({ type: 'route_toggle' }),
  }
}
