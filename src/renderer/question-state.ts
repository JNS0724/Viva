import { answerText, type QuestionAnswer } from '../shared/question-answer.ts'
import { closeStreams } from './streams.ts'

/**
 * A question the agent asked mid-turn (ask_user_question, through the app's questions plugin). While it
 * waits, the phase is 'asking'; the answer joins the thread as the user's reply, under what was asked.
 */
export { answerText }
export type { QuestionAnswer }

/** What the agent asks while it waits (state.question): its questions, and what is picked so far, by question. */
type AskedQuestion = { questionId: string, questions: readonly QuestionItem[], picks: Readonly<Record<string, readonly string[]>> }

const askedText = (questions: readonly QuestionItem[]) => questions.map((question) => question.question).join('\n')

/** The answers to send: what was picked per question, with `text` (typed in the composer) for the ones it answers. */
export function answersFrom(question: AskedQuestion, text = ''): QuestionAnswer[] {
  const typed = text.trim()
  // Typed words go to the first question without a pick (the last one when all have picks).
  const target = question.questions.find((item) => !(question.picks[item.id] ?? []).length) ?? question.questions.at(-1)
  return question.questions.map((item) => ({
    id: item.id,
    selected: [...(question.picks[item.id] ?? [])],
    ...(typed && item.id === target?.id ? { custom: typed } : {}),
  }))
}

function togglePick(item: QuestionItem, current: readonly string[], label: string) {
  if (item.multiSelect) return current.includes(label) ? current.filter((picked) => picked !== label) : [...current, label]
  return current[0] === label ? [] : [label]
}

/** The conversation's questions (conversation-state.ts), in the conversation on screen or a task's. */
export const QUESTION_ACTIONS: Readonly<Record<string, (state: ConversationView, action: Action) => ConversationView>> = {
  question_request: (state, { questionId, questions, at }) => {
    const closed = closeStreams(state)
    return {
      ...closed,
      phase: 'asking',
      question: { questionId, questions, picks: {} },
      timeline: [...closed.timeline, { kind: 'question', ref: questionId, at, title: askedText(questions) }],
    }
  },

  question_pick: (state, { id, label }) => {
    const item = state.question?.questions.find((question: QuestionItem) => question.id === id)
    if (!item) return state
    const picks = { ...state.question.picks, [id]: togglePick(item, state.question.picks[id] ?? [], label) }
    return { ...state, question: { ...state.question, picks } }
  },

  question_answered: (state, { questionId, answers, at }) => {
    if (state.question?.questionId !== questionId) return state
    const { questions } = state.question
    const text = answerText(questions, answers)
    const reply = { id: `m${state.messages.length}`, role: 'user', text, asked: askedText(questions), open: false, receipt: null }
    return {
      ...state,
      phase: 'working',
      question: null,
      messages: [...state.messages, reply],
      timeline: [...state.timeline, { kind: 'answer', ref: questionId, at, title: text, answered: true }],
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
}
