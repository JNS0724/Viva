import {
  areRawCardsMemoryEligible,
  canonicalEligibleAnswersDigest,
  eligibleQuestionAnswers,
  questionCallIdHash,
  type RawQuestionCard,
} from '../../../src/memory/node/question-answer-memory.ts'

/**
 * The questions contract (version 1) between this plugin, inside dsh, and the app that started dsh. The
 * messages go over Node's IPC channel (`process.send` / `process.on('message')`); the app keeps the same
 * shapes in src/backend/question-channel.ts.
 *
 *   plugin → app  { type: 'question', id, sessionId, turn?, callId?, callSeq?, memoryEligible?, questions: [{ id, question, header?, options?: [{ label, description? }], multiSelect? }] }
 *   plugin → app  { type: 'question_closed', id }          the turn was stopped before the user answered
 *   app → plugin  { type: 'answer', id, answers: [{ id, selected: string[], custom?: string }], provenance?: { origin: 'human', conversationId, answeredAt, answerProfileGen? } }
 *   app → plugin  { type: 'decline', id }                  the window cannot ask it (another conversation)
 */
const MAX_ANSWER_CHARS = 2000

export const DECLINED = '用户现在没法回答这个问题（已经离开了这段对话）。不要再问，按最合理的假设继续，并在回答里说明假设。'

/** A question as the window gets it. */
export interface QuestionView {
  id: string, question: string, header?: string, options?: Array<{ label: string, description?: string }>, multiSelect?: boolean
}
/** One answer, in dsh's answer shape. */
export interface Answer { id: string, selected: string[], custom?: string }
/** Occurrence identity captured from DSH's committed tool-call / PTC-dispatch-start event. */
export interface QuestionOccurrence {
  callSeq: number
  callId: string
  turn: number
  kind: 'native' | 'ptc'
  parentCallId?: string
  rootCallId?: string
  openingProfileGen: number | null
}
/** Scalar-only human answer receipt forwarded in-process to viva-memory (zero card/answer bodies). */
export interface HumanQuestionReceipt {
  sessionId: string
  turn: number
  callSeq: number
  callIdHash: string
  conversationId: string
  answeredAt: number
  questionProfileGen: number | null
  answerProfileGen: number | null
  answerBatchDigest: string
}
/** What dsh hands over with user-questions/request: its questions, the turn's signal, the agent asking. */
interface QuestionRequest {
  questions: ReadonlyArray<QuestionView & { options?: ReadonlyArray<{ label: string, description?: string }> }>
  signal?: AbortSignal
  agent?: { session?: { id?: unknown } }
}
/** What arrives over IPC: anything at all, so every field is checked before it is used. */
type Incoming = any

/** The answer the app sent, as dsh's answer shape, or null when it does not answer exactly these questions. */
export function answerFor(questions: readonly QuestionView[], message: Incoming): { answers: Answer[] } | null {
  if (!Array.isArray(message?.answers) || message.answers.length !== questions.length) return null
  const answers: Array<Answer | null> = message.answers.map((answer: Incoming): Answer | null => {
    const question = questions.find((item) => item.id === answer?.id)
    if (!question || !Array.isArray(answer.selected)) return null
    const labels = new Set((question.options ?? []).map((option) => option.label))
    if (!answer.selected.every((label: unknown) => labels.has(label as string))) return null
    if (!question.multiSelect && answer.selected.length > 1) return null
    if (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > MAX_ANSWER_CHARS)) return null
    return { id: question.id, selected: [...answer.selected], ...(answer.custom ? { custom: answer.custom } : {}) }
  })
  const complete = answers.filter((answer: Answer | null): answer is Answer => answer !== null)
  const ids = new Set(complete.map((answer) => answer.id))
  return complete.length === answers.length && ids.size === questions.length ? { answers: complete } : null
}

/** What the window needs of each question; the rest of dsh's request stays here. */
const questionView = (question: QuestionRequest['questions'][number]): QuestionView => ({
  id: question.id,
  question: question.question,
  ...(question.header ? { header: question.header } : {}),
  ...(question.options?.length ? { options: question.options.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })) } : {}),
  ...(question.multiSelect ? { multiSelect: true } : {}),
})

const rawCardOf = (question: QuestionRequest['questions'][number]): RawQuestionCard => ({
  id: question.id,
  question: question.question,
  ...(question.header !== undefined ? { header: question.header } : {}),
  ...(question.options !== undefined ? { options: question.options.map(({ label, description }) => ({ label, ...(description !== undefined ? { description } : {}) })) } : {}),
  ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
})

function parseHumanProvenance(raw: Incoming): { conversationId: string, answeredAt: number, answerProfileGen: number | null } | null {
  if (!raw || typeof raw !== 'object' || raw.origin !== 'human') return null
  if (typeof raw.conversationId !== 'string' || !raw.conversationId.trim() || raw.conversationId.length > 256) return null
  if (typeof raw.answeredAt !== 'number' || !Number.isSafeInteger(raw.answeredAt) || raw.answeredAt <= 0) return null
  const answerProfileGen = typeof raw.answerProfileGen === 'number'
    && Number.isSafeInteger(raw.answerProfileGen)
    && raw.answerProfileGen >= 0
    ? raw.answerProfileGen
    : null
  return { conversationId: raw.conversationId, answeredAt: raw.answeredAt, answerProfileGen }
}

interface Waiting {
  sessionId: string
  questions: QuestionView[]
  rawQuestions: RawQuestionCard[]
  occurrence?: QuestionOccurrence
  memoryEligible: boolean
  resolve: (answer: { answers: Answer[] }) => void
  reject: (reason: unknown) => void
  settle: (finish: () => void) => void
}

/** @param port the IPC channel to the app */
export function createQuestionChannel(
  port: { send: (message: object) => unknown, on: Function, off: Function },
  log: (message: string) => void,
  onHumanReceipt?: (receipt: HumanQuestionReceipt) => void,
): { ask: (request: QuestionRequest, turn?: number, occurrence?: QuestionOccurrence) => Promise<{ answers: Answer[] }>, close: () => void } {
  const waiting = new Map<string, Waiting>()
  let seq = 0

  function emitReceiptIfEligible(entry: Waiting, answer: { answers: Answer[] }, rawProvenance: Incoming) {
    if (!onHumanReceipt || !entry.memoryEligible || !entry.occurrence) return
    const { callSeq, callId, turn, openingProfileGen } = entry.occurrence
    if (!entry.sessionId || !callId || !Number.isSafeInteger(callSeq) || callSeq < 0 || !Number.isSafeInteger(turn) || turn <= 0) return
    const provenance = parseHumanProvenance(rawProvenance)
    if (!provenance) return
    const eligible = eligibleQuestionAnswers(entry.rawQuestions, answer.answers)
    if (eligible.length === 0) return
    onHumanReceipt({
      sessionId: entry.sessionId,
      turn,
      callSeq,
      callIdHash: questionCallIdHash(callId),
      conversationId: provenance.conversationId,
      answeredAt: provenance.answeredAt,
      questionProfileGen: openingProfileGen,
      answerProfileGen: provenance.answerProfileGen,
      answerBatchDigest: canonicalEligibleAnswersDigest(eligible),
    })
  }

  function onMessage(message: Incoming) {
    const entry = waiting.get(message?.id)
    if (!entry || (message.type !== 'answer' && message.type !== 'decline')) return
    if (message.type === 'decline') return entry.settle(() => entry.reject(new Error(DECLINED)))
    const answer = answerFor(entry.questions, message)
    if (!answer) return log(`ignored an answer that does not match question ${message.id}`)
    entry.settle(() => {
      try {
        emitReceiptIfEligible(entry, answer, message.provenance)
      } catch (error) {
        log(`failed to record human answer receipt for ${message.id}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        entry.resolve(answer)
      }
    })
  }
  port.on('message', onMessage)

  function ask(request: QuestionRequest, turn?: number, occurrence?: QuestionOccurrence) {
    const id = `q${++seq}-${Date.now().toString(36)}`
    const sessionId = String(request.agent?.session?.id ?? '')
    const rawQuestions = request.questions.map(rawCardOf)
    const memoryEligible = areRawCardsMemoryEligible(rawQuestions)
    const questions = request.questions.map(questionView)
    const signal = request.signal
    return new Promise<{ answers: Answer[] }>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      const entry: Waiting = {
        sessionId,
        questions,
        rawQuestions,
        ...(occurrence ? { occurrence } : {}),
        memoryEligible,
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
          reject(signal?.reason ?? new Error('aborted'))
        })
      }
      waiting.set(id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      port.send({
        type: 'question',
        id,
        sessionId,
        ...(turn === undefined ? {} : { turn }),
        ...(occurrence ? { callId: occurrence.callId, callSeq: occurrence.callSeq } : {}),
        memoryEligible,
        questions,
      })
    })
  }

  function close() {
    port.off('message', onMessage)
    for (const entry of [...waiting.values()]) entry.settle(() => entry.reject(new Error('dsh is shutting down')))
  }

  return { ask, close }
}
