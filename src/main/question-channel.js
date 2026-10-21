/**
 * Questions the model asks the user, on the app's side of the questions contract (version 1, see
 * plugins/questions/lib/channel.js): dsh's viva-questions plugin sends them over the IPC channel opened when
 * dsh started; the window shows them; the answer goes back the same way.
 * What arrives from either side is checked here, so the window only gets well-formed questions and the
 * plugin only gets answers to the questions it asked.
 */
const MAX_QUESTIONS = 6
const MAX_OPTIONS = 8
const MAX_QUESTION_CHARS = 1000
const MAX_LABEL_CHARS = 200
const MAX_ANSWER_CHARS = 2000
const MAX_ID_CHARS = 128

const isText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

function optionFrom(option) {
  if (!isText(option?.label, MAX_LABEL_CHARS)) return null
  return { label: option.label, ...(isText(option.description, MAX_QUESTION_CHARS) ? { description: option.description } : {}) }
}

function questionFrom(item) {
  if (!isText(item?.id, MAX_ID_CHARS) || !isText(item.question, MAX_QUESTION_CHARS)) return null
  const options = (Array.isArray(item.options) ? item.options : []).slice(0, MAX_OPTIONS).map(optionFrom)
  if (options.some((option) => option === null)) return null
  if (new Set(options.map((option) => option.label)).size !== options.length) return null
  return {
    id: item.id,
    question: item.question,
    header: isText(item.header, MAX_LABEL_CHARS) ? item.header : '',
    options,
    multiSelect: item.multiSelect === true,
  }
}

/** @returns {{ id: string, questions: object[] } | null} the question to show, or null when malformed */
export function parseQuestion(message) {
  if (!isText(message?.id, MAX_ID_CHARS) || !Array.isArray(message.questions)) return null
  if (message.questions.length === 0 || message.questions.length > MAX_QUESTIONS) return null
  const questions = message.questions.map(questionFrom)
  if (questions.some((question) => question === null)) return null
  if (new Set(questions.map((question) => question.id)).size !== questions.length) return null
  return { id: message.id, questions }
}

/**
 * The window's answer, checked against the questions asked: one entry per question, picks among its options
 * (one unless it allows several), and optional text of the user's own.
 * @returns {Array<{ id: string, selected: string[], custom?: string }>}
 */
export function checkAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('回答和问题对不上')
  return questions.map((question) => {
    const answer = answers.find((item) => item?.id === question.id)
    const selected = Array.isArray(answer?.selected) ? answer.selected : null
    const labels = new Set(question.options.map((option) => option.label))
    if (!selected || !selected.every((label) => labels.has(label))) throw new Error('选项无效')
    if (!question.multiSelect && selected.length > 1) throw new Error('这个问题只能选一项')
    const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
    if (custom.length > MAX_ANSWER_CHARS) throw new Error(`回答太长（上限 ${MAX_ANSWER_CHARS} 字）`)
    return { id: question.id, selected: [...new Set(selected)], ...(custom ? { custom } : {}) }
  })
}

/**
 * @param {{ send: (message: object) => void, emit: (event: object) => void, sessionId: () => string | null, taskOf?: (sessionId: string) => string | null }} io
 *   send: to the plugin; emit: to the window; sessionId: the conversation on screen; taskOf: the background
 *   task a session is, if any (its questions go to the window as task_question)
 */
export function createQuestionDesk({ send, emit, sessionId, taskOf = () => null }) {
  /** questionId → { question, sessionId, taskId } (taskId null for the main conversation's) */
  const pending = new Map()

  const closed = (questionId, taskId) => emit(taskId ? { type: 'task_question_closed', taskId, questionId } : { type: 'question_closed', questionId })
  const shown = (entry) => emit(entry.taskId
    ? { type: 'task_question', taskId: entry.taskId, questionId: entry.question.id, questions: entry.question.questions }
    : { type: 'question', questionId: entry.question.id, questions: entry.question.questions })

  /** A message from the plugin. */
  function receive(message) {
    if (message?.type === 'question_closed') {
      const entry = pending.get(message.id)
      if (entry && pending.delete(message.id)) closed(message.id, entry.taskId)
      return
    }
    if (message?.type !== 'question') return
    const question = parseQuestion(message)
    if (!question) {
      console.error('[questions] ignored a malformed question from dsh')
      if (isText(message.id, MAX_ID_CHARS)) send({ type: 'decline', id: message.id })
      return
    }
    // A question from a conversation that is neither on screen nor a background task cannot be answered.
    const taskId = message.sessionId === sessionId() ? null : taskOf(message.sessionId)
    if (message.sessionId !== sessionId() && !taskId) return send({ type: 'decline', id: question.id })
    const entry = { question, sessionId: message.sessionId, taskId }
    pending.set(question.id, entry)
    shown(entry)
  }

  /** @returns {boolean} false when the question is no longer waiting */
  function answer(questionId, answers) {
    const entry = pending.get(questionId)
    if (!entry) return false
    const checked = checkAnswers(entry.question.questions, answers)
    pending.delete(questionId)
    send({ type: 'answer', id: questionId, answers: checked })
    return true
  }

  function decline(keep) {
    for (const [questionId, entry] of [...pending]) {
      if (keep(entry)) continue
      pending.delete(questionId)
      send({ type: 'decline', id: questionId })
      closed(questionId, entry.taskId)
    }
  }

  /** The conversation on screen is left (or dsh is going away): what it still asked goes unanswered; tasks' stay. */
  const declineAll = () => decline((entry) => entry.taskId !== null)
  /** A background task is closed: what it still asked goes unanswered. */
  const declineTask = (taskId) => decline((entry) => entry.taskId !== taskId)

  /** The turn asking became a background task: its questions are the task's now. */
  function moveToTask(fromSessionId, taskId) {
    for (const entry of pending.values()) {
      if (entry.sessionId !== fromSessionId || entry.taskId) continue
      closed(entry.question.id, null)
      entry.taskId = taskId
      shown(entry)
    }
  }

  return { receive, answer, declineAll, declineTask, moveToTask }
}
