import type { ActionHandlers } from './action-types.ts'
/**
 * The cards the model's schedule proposals put in the conversation (schedules.ts `schedule_propose`), kept with
 * the conversation they came in and gone with it: open (and, on 修改, its form), then kept (定时) or not (不用).
 */
import type { ProposalCard } from './proposal-types.ts'
export type { ProposalCard } from './proposal-types.ts'

const withCard = (state: State, id: string, changes: Partial<ProposalCard>): State => ({
  ...state, proposals: state.proposals.map((card: ProposalCard) => (card.id === id ? { ...card, ...changes } : card)),
})

/**
 * The message a card goes after: the last of the turn it came in, so it sits under that turn's answer and before
 * whatever the user said next, and stays there as the conversation goes on. `after` is how many messages there were
 * when it came (one past them all, after a turn redone: the end); -1 is before them all.
 */
export function proposalHost(messages: readonly { role: string }[], after: number): number {
  let at = Math.min(after, messages.length) - 1
  while (at + 1 < messages.length && messages[at + 1].role !== 'user') at += 1
  return at
}

export const PROPOSAL_ACTIONS= {
  /** A schedule the model proposed, as a card at the end of the turn it came in; the same proposal once. */
  schedule_proposed: (state, { proposal }) => (!proposal?.proposalId || state.proposals.some((card: ProposalCard) => card.id === proposal.proposalId)
    ? state
    : { ...state, proposals: [...state.proposals, { id: proposal.proposalId, proposal, status: 'open', after: state.messages.length }] }),
  /** 修改 opens the card's form; 取消 closes it, and what was typed in it goes. */
  proposal_editing: (state, { id, editing }) => withCard(state, id, { editing, draft: null, error: null }),
  proposal_busy: (state, { id, draft }) => withCard(state, id, { busy: true, error: null, ...(draft ? { draft } : {}) }),
  proposal_settled: (state, { id, status, accepted = null, proposal }) => withCard(state, id, {
    status, accepted, busy: false, error: null, editing: false, ...(proposal ? { proposal } : {}),
  }),
  proposal_failed: (state, { id, message, draft }) => withCard(state, id, { busy: false, error: message, ...(draft ? { draft } : {}) }),
} satisfies ActionHandlers
