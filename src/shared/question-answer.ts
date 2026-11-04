import { t } from './i18n/translate.ts'

/**
 * How an answer to the agent's questions reads in the conversation, the user's reply under what was asked: the
 * window shows it (renderer/question-state.ts), and the backend keeps it in a task's words (backend/task-transcript.ts).
 */

/** An answer to one question: the options picked, and the user's own words. */
export type QuestionAnswer = { id: string, selected: string[], custom?: string }
/** As much of a question as its answer's wording needs. */
export type AnsweredQuestion = { id: string, question: string, header?: string }

/** The answer as the user would put it: the picks, then their own words; one line per question when there are several. */
export function answerText(questions: readonly AnsweredQuestion[], answers: readonly QuestionAnswer[]): string {
  const said = questions.map((question) => {
    const answer = answers.find((item) => item.id === question.id)
    return [...(answer?.selected ?? []), answer?.custom].filter(Boolean).join('、') || t('question-state.skipped')
  })
  if (said.length === 1) return said[0]
  return questions.map((question, i) => `${question.header || question.question}：${said[i]}`).join('\n')
}
