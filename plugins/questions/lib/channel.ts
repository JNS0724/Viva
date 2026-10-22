/**
 * The questions contract (version 1) between this plugin, inside dsh, and the app that started dsh. The
 * messages go over Node's IPC channel (`process.send` / `process.on('message')`); the app keeps the same
 * shapes in src/main/question-channel.js.
 *
 *   plugin → app  { type: 'question', id, sessionId, questions: [{ id, question, header?, options?: [{ label, description? }], multiSelect? }] }
 *   plugin → app  { type: 'question_closed', id }          the turn was stopped before the user answered
 *   app → plugin  { type: 'answer', id, answers: [{ id, selected: string[], custom?: string }] }
 *   app → plugin  { type: 'decline', id }                  the window cannot ask it (another conversation)
 */
const MAX_ANSWER_CHARS = 2000

export const DECLINED = '用户现在没法回答这个问题（已经离开了这段对话）。不要再问，按最合理的假设继续，并在回答里说明假设。'

/** The answer the app sent, as dsh's answer shape, or null when it does not answer exactly these questions. */
export function answerFor(questions, message) {
  if (!Array.isArray(message?.answers) || message.answers.length !== questions.length) return null
  const answers = message.answers.map((answer) => {
    const question = questions.find((item) => item.id === answer?.id)
    if (!question || !Array.isArray(answer.selected)) return null
    const labels = new Set((question.options ?? []).map((option) => option.label))
    if (!answer.selected.every((label) => labels.has(label))) return null
    if (!question.multiSelect && answer.selected.length > 1) return null
    if (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > MAX_ANSWER_CHARS)) return null
    return { id: question.id, selected: [...answer.selected], ...(answer.custom ? { custom: answer.custom } : {}) }
  })
  const ids = new Set(answers.map((answer) => answer?.id))
  return answers.every(Boolean) && ids.size === questions.length ? { answers } : null
}

/** What the window needs of each question; the rest of dsh's request stays here. */
const questionView = (question) => ({
  id: question.id,
  question: question.question,
  ...(question.header ? { header: question.header } : {}),
  ...(question.options?.length ? { options: question.options.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })) } : {}),
  ...(question.multiSelect ? { multiSelect: true } : {}),
})

/**
 * @param {{ send?: (message: object) => unknown, on: Function, off: Function }} port the IPC channel to the app
 * @param {(message: string) => void} log
 * @returns {{ ask: (request: object) => Promise<{ answers: object[] }>, close: () => void }}
 */
export function createQuestionChannel(port, log) {
  const waiting = new Map()
  let seq = 0

  function onMessage(message) {
    const entry = waiting.get(message?.id)
    if (!entry || (message.type !== 'answer' && message.type !== 'decline')) return
    if (message.type === 'decline') return entry.settle(() => entry.reject(new Error(DECLINED)))
    const answer = answerFor(entry.questions, message)
    if (!answer) return log(`ignored an answer that does not match question ${message.id}`)
    entry.settle(() => entry.resolve(answer))
  }
  port.on('message', onMessage)

  function ask(request) {
    const id = `q${++seq}-${Date.now().toString(36)}`
    const questions = request.questions.map(questionView)
    const signal = request.signal
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      const entry = {
        questions,
        resolve,
        reject,
        settle(finish) {
          waiting.delete(id)
          signal?.removeEventListener('abort', onAbort)
          finish()
        },
      }
      function onAbort() {
        entry.settle(() => {
          port.send({ type: 'question_closed', id })
          reject(signal.reason ?? new Error('aborted'))
        })
      }
      waiting.set(id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      port.send({ type: 'question', id, sessionId: String(request.agent?.session?.id ?? ''), questions })
    })
  }

  function close() {
    port.off('message', onMessage)
    for (const entry of [...waiting.values()]) entry.settle(() => entry.reject(new Error('dsh is shutting down')))
  }

  return { ask, close }
}
