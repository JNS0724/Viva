import { CONVERSATION_ACTIONS } from './conversation-state.ts'
import { SECRET_ACTIONS } from './secret-state.ts'

/**
 * What the conversation on screen waits on the user for, as the backend says it on the live channel when the window
 * asks (`agent:waits`, system-design §12.1): its approvals, questions and keys, each as it was asked. It comes in
 * its place among the pushes, so it is how things stood there: what was asked or closed before it is in it, what
 * comes after it follows it. Each is shown unless it is shown now, or was answered on this page (its answer may not
 * have reached dsh when the backend said this). Pure and immutable; `state.ts` merges it.
 */

type Wait = { requestId?: unknown, questionId?: unknown, [field: string]: unknown }

/** Whether the conversation's trace has the user's answer to a request (a decision, an answer, keys filled in or not). */
const answered = (state: State, kind: string, ref: unknown) => state.timeline.some((entry) => entry.kind === kind && entry.ref === ref)

export const WAITS_ACTIONS: Readonly<Record<string, Reducer>> = {
  waits_restored: (state, { permissions = [], questions = [], secrets = [], at }) => {
    const approvals = (permissions as Wait[])
      .filter((wait) => state.permission?.requestId !== wait.requestId && !answered(state, 'decision', wait.requestId))
      .reduce<State>((current, wait) => CONVERSATION_ACTIONS.permission_request(current, { ...wait, type: 'permission_request', at }) as State, state)
    const asked = (questions as Wait[])
      .filter((wait) => approvals.question?.questionId !== wait.questionId && !answered(approvals, 'answer', wait.questionId))
      .reduce<State>((current, wait) => CONVERSATION_ACTIONS.question_request(current, { ...wait, type: 'question_request', at }) as State, approvals)
    return (secrets as Wait[])
      .filter((wait) => asked.secret?.requestId !== wait.requestId && !answered(asked, 'secret_answer', wait.requestId))
      .reduce<State>((current, wait) => SECRET_ACTIONS.secret_request(current, { ...wait, type: 'secret_request', at }), asked)
  },
}
