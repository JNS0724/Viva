import type { ConversationHandlers, AskedQuestion } from './conversation-types.ts'
import { answerText, type QuestionAnswer } from '../shared/question-answer.ts'
import { closeStreams, nextMessageSeq } from './streams.ts'

/**
 * A question the agent asked mid-turn (ask_user_question, through the app's questions plugin). While it
 * waits, the phase is 'asking'; the answer joins the thread as the user's reply, under what was asked.
 */
export { answerText }
export type { QuestionAnswer }

/** What the agent asks while it waits (state.question): its questions, and what is picked so far, by question. */

export const questionNeedsText = (question: Pick<AskedQuestion, 'questions'>) =>
  question.questions.some(item => item.options.length === 0)

const askedText = (questions: readonly QuestionItem[]) => questions.map((question) => question.question).join('\n')

/** The answers to send: what was picked per question, with `text` (typed in the composer) for the ones it answers. */
export function answersFrom(question: AskedQuestion, text = ''): QuestionAnswer[] {
  const typed = text.trim()
  // Typed words go to the first question without a pick (the last one when all have picks).
  const target = question.questions.find((item) => !(question.picks[item.id] ?? []).length) ?? question.questions.at(-1)
  return question.questions.map((item) => {
    const custom = question.custom?.[item.id]?.trim() || (item.id === target?.id ? typed : '')
    return { id: item.id, selected: [...(question.picks[item.id] ?? [])], ...(custom ? { custom } : {}) }
  })
}

function togglePick(item: QuestionItem, current: readonly string[], label: string) {
  if (item.multiSelect) return current.includes(label) ? current.filter((picked) => picked !== label) : [...current, label]
  return current[0] === label ? [] : [label]
}

/** The conversation's questions (conversation-state.ts), in the conversation on screen or a task's. */
export const QUESTION_ACTIONS = {
  question_request: (state, { questionId, questions, at }) => {
    const closed = closeStreams(state)
    return {
      ...closed,
      phase: 'asking',
      question: { questionId, questions, picks: {} },
      timeline: [...closed.timeline, { kind: 'question', ref: questionId, at, title: askedText(questions), questions }],
    }
  },

  question_pick: (state, { id, label }) => {
    const question = state.question
    if (!question) return state
    const item = question.questions.find((question: QuestionItem) => question.id === id)
    if (!item) return state
    const picks = { ...question.picks, [id]: togglePick(item, question.picks[id] ?? [], label) }
    return { ...state, question: { ...question, picks } }
  },

  question_answered: (state, { questionId, answers, at, sourceId, sourceIds, inHistory, questions: snapshot }) => {
    const active = state.question?.questionId === questionId
    const questions = active ? state.question!.questions : snapshot
    if (!questions) return state
    if (state.timeline.some((entry) => entry.kind === 'answer' && entry.ref === questionId && entry.answered)) return state
    const text = answerText(questions, answers)
    const parts = sourceIds && Object.keys(sourceIds).length ? questions.map(question => ({
      text: answerText([question], answers), asked: question.question, sourceId: Object.hasOwn(sourceIds, question.id) ? sourceIds[question.id] : undefined,
    })) : [{ text, asked: askedText(questions), sourceId }]
    const base = nextMessageSeq(state.messages, state.historyOffset ?? 0)
    const replies = inHistory ? [] : parts.map((part, index) => ({ id: `m${base + index}`, role: 'user', text: part.text, asked: part.asked,
      ...(part.sourceId ? { sourceId: part.sourceId } : {}), open: false, receipt: null }))
    const entry = { kind: 'answer' as const, ref: questionId, at, title: text, answered: true }
    const closedIndex = state.timeline.findIndex((item) => item.kind === 'answer' && item.ref === questionId && !item.answered)
    const timeline = closedIndex >= 0 ? state.timeline.toSpliced(closedIndex, 1, entry) : [...state.timeline, entry]
    return {
      ...state,
      phase: active ? 'working' : state.phase,
      question: active ? null : state.question,
      messages: replies.length ? [...state.messages, ...replies] : state.messages,
      timeline,
    }
  },

  /** Stopped, or left behind by another conversation, before an answer came. */
  question_closed: (state, { questionId, at }) => {
    if (state.question?.questionId !== questionId) return state
    return {
      ...state,
      phase: state.phase === 'asking' ? 'working' : state.phase,
      question: null,
      timeline: [...state.timeline, { kind: 'answer', ref: questionId, at, title: askedText(state.question.questions), answered: false }],
    }
  },
} satisfies ConversationHandlers
