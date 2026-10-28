/**
 * Why a topic could not be taken up again in its own session (继续这个话题), so the window says the right thing:
 * - 'missing-dir': its working directory is not there any more; dsh resumes a session only in its own directory;
 * - 'gone': dsh has no such session to resume (or not in that directory): only its saved records are left;
 * - 'unavailable': anything else (the agent not running, a fault on the way): it may work when tried again.
 * Unsure means 'unavailable': a new conversation is offered only when the session is surely gone.
 */
import { describeError } from './session-info.ts'

export type ResumeReason = 'missing-dir' | 'gone' | 'unavailable'

/** The agent as it is after a failed try: back on the conversation it was on (or on a new one, if that was gone). */
type AgentInfo = { sessionId: string | null, resumed?: boolean, [field: string]: unknown }

export class ResumeError extends Error {
  readonly reason: ResumeReason
  readonly info: AgentInfo | null

  constructor(reason: ResumeReason, message: string, info: AgentInfo | null = null) {
    super(message)
    this.name = 'ResumeError'
    this.reason = reason
    this.info = info
  }
}

/** What dsh says (dsh-acp resumeSession) when it holds no such session, or holds it for another directory. */
const GONE = /session is not resumable|session cwd does not match|holds no such session|unknown session/i

/**
 * The reason a resume failed, from what dsh said: its message and the details an ACP error carries in `data`
 * (`Invalid params` with `data.details` naming the session), as session-info.ts describeError reads them.
 */
export function resumeReason(error: unknown): Exclude<ResumeReason, 'missing-dir'> {
  return GONE.test(describeError(error)) ? 'gone' : 'unavailable'
}
