import type { ActionHandlers } from './action-types.ts'
/**
 * The cards the model's schedule proposals put under the conversation (schedules.ts `schedule_propose`), kept with
 * the conversation they came in and gone with it: open, then kept (定时) or not (不用).
 */
import type { ProposalCard } from './proposal-types.ts'
export type { ProposalCard } from './proposal-types.ts'

const withCard = (state: State, id: string, changes: Partial<ProposalCard>): State => ({
  ...state, proposals: state.proposals.map((card: ProposalCard) => (card.id === id ? { ...card, ...changes } : card)),
})

export const PROPOSAL_ACTIONS= {
  /** A schedule the model proposed, as a card under the conversation; the same proposal once. */
  schedule_proposed: (state, { proposal }) => (!proposal?.proposalId || state.proposals.some((card: ProposalCard) => card.id === proposal.proposalId)
    ? state
    : { ...state, proposals: [...state.proposals, { id: proposal.proposalId, proposal, status: 'open' }] }),
  proposal_busy: (state, { id }) => withCard(state, id, { busy: true, error: null }),
  proposal_settled: (state, { id, status, accepted = null }) => withCard(state, id, { status, accepted, busy: false, error: null }),
  proposal_failed: (state, { id, message }) => withCard(state, id, { busy: false, error: message }),
} satisfies ActionHandlers
