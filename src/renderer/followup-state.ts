/**
 * Follow-ups in the window (followups-ipc.ts): what the 后台 page and settings show of them and of background
 * preparation, and the cards the model's proposals put in the conversation (`proposals`, kept with the
 * conversation they came in, gone with it).
 */
export const initialFollowups = Object.freeze({
  loaded: false,
  followups: [] as Untyped[],
  schedule: null as Untyped,
  nextWindow: null as number | null,
  /** How preparation goes now (prepare-scheduler.ts PrepareState). */
  state: Object.freeze({ running: false, current: null, queued: 0, nextAt: null, waiting: null }) as Untyped,
  callsToday: 0,
  lateThisWeek: 0,
  busy: false,
  error: null as string | null,
  notice: null as string | null,
})

/** A card for a proposal: open, or how the user decided, with what the main process said back. */
export type ProposalCard = {
  id: string, proposal: Untyped, status: 'open' | 'accepted' | 'declined' | 'never',
  accepted?: Untyped, chooseWindows?: boolean, chosen?: string | null, error?: string | null, busy?: boolean,
}

const withFollowups = (state: State, changes: Partial<State['followups']>): State => ({ ...state, followups: { ...state.followups, ...changes } })
const withCard = (state: State, id: string, changes: Partial<ProposalCard>): State => ({
  ...state, proposals: state.proposals.map((card: ProposalCard) => (card.id === id ? { ...card, ...changes } : card)),
})

export const FOLLOWUP_ACTIONS: Record<string, Reducer> = {
  followups_loaded: (state, { view }) => withFollowups(state, { ...view, loaded: true, busy: false }),
  followups_busy: (state) => withFollowups(state, { busy: true, error: null, notice: null }),
  followups_failed: (state, { message }) => withFollowups(state, { busy: false, error: message }),
  followups_saved: (state, { view, notice = null }) => withFollowups(state, { ...view, loaded: true, busy: false, error: null, notice }),
  prepare_state: (state, { prepare }) => withFollowups(state, { state: prepare }),
  followup_proposed: (state, { proposalId, proposal }) => (state.proposals.some((card: ProposalCard) => card.id === proposalId)
    ? state
    : { ...state, proposals: [...state.proposals, { id: proposalId, proposal, status: 'open' }] }),
  proposal_busy: (state, { id }) => withCard(state, id, { busy: true, error: null }),
  proposal_settled: (state, { id, status, accepted = null, chooseWindows = false }) => withCard(state, id, { status, accepted, chooseWindows, busy: false, error: null }),
  proposal_failed: (state, { id, message }) => withCard(state, id, { busy: false, error: message }),
  proposal_windows: (state, { id, chosen }) => withCard(state, id, { chosen, busy: false }),
}
