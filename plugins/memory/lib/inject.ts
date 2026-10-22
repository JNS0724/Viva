import { createHash } from 'node:crypto'
import { buildContext, dateLine, RECENT_LIMIT } from './context.ts'
import { initialSession, planTurn } from './layers.ts'
import type { SessionState } from './layers.ts'
import { buildLexicon } from './names.ts'
import type { MemoryDb } from './store.ts'

const signatureOf = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * What to put in front of the model for one turn, and the bookkeeping that goes with it: the session's
 * retrieval state is saved, and what was sent is logged for the app to show. Independent of dsh.
 * @param turn epoch: how many times dsh has compacted this session; today: e.g. "2026-10-18（周日）"
 * @returns the context block, or '' when nothing needs to be sent
 */
export function contextForTurn(db: MemoryDb, { sessionId, turn, question, epoch, today = dateLine() }: {
  sessionId: string, turn: number, question: string, epoch: number, today?: string,
}): string {
  const profile = db.getProfile()
  const synthesis = db.latestSynthesis()
  const recent = db.profileMemories({ since: synthesis?.createdAt ?? null, limit: RECENT_LIMIT })
  const fixed = { profile, synthesis: synthesis?.text ?? null, recent, habits: db.habits() }
  const memories = db.allMemories()
  // What planTurn returned last turn, saved below; anything missing starts as in a new session.
  const saved = db.sessionState(sessionId) as Partial<SessionState> | null
  const plan = planTurn({ ...initialSession, ...saved }, {
    question,
    // Memories learned during the session came from it, so the model has them: only the user's own
    // profile, a new synthesis or new habits send the fixed layer again.
    fixedSignature: signatureOf(buildContext({ fixed: { ...fixed, recent: [] }, pushed: [] })),
    epoch,
    today,
    memories,
    lexicon: buildLexicon(profile, memories),
    inFixed: new Set(recent.map((memory) => memory.id)),
  })
  db.saveSessionState(sessionId, plan.session)
  const text = buildContext({ fixed: plan.fixed ? fixed : null, pushed: plan.pushed, today: plan.dated ? today : '' })
  // A date-only block is not worth a row in the trace.
  if (plan.fixed || plan.pushed.length) {
    const pushed = plan.pushed.map(({ memory, names }) => ({ text: memory.text, names }))
    db.logInjection({ sessionId, turn, fixed: plan.fixed, pushed })
  }
  return text
}
