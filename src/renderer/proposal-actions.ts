import type { ProposalCard } from './proposal-state.ts'

/** A schedule's card under the conversation: 定时 keeps it (schedules.ts accept), 不用 lets the proposal go. */
export function createProposalActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const cardOf = (id: string): ProposalCard | undefined => getState().proposals.find((card: ProposalCard) => card.id === id)

  /** One answer per card at a time; the card says how it went. */
  async function settle(id: string, status: 'accepted' | 'declined', request: () => Promise<unknown>) {
    const card = cardOf(id)
    if (!card || card.busy || card.status !== 'open') return
    dispatch({ type: 'proposal_busy', id })
    try {
      dispatch({ type: 'proposal_settled', id, status, accepted: await request() ?? null })
    } catch (err) {
      dispatch({ type: 'proposal_failed', id, message: errorMessage(err) })
    }
  }

  return {
    acceptProposal: (id: string) => settle(id, 'accepted', () => api.acceptSchedule(id)),
    declineProposal: (id: string) => settle(id, 'declined', () => api.declineSchedule(id)),
  }
}
