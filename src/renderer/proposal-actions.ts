import { t } from '../shared/i18n/translate.ts'
import { editsOf, withEdits } from './proposal-draft.ts'
import type { ProposalCard } from './proposal-state.ts'
import type { ProposalDraft, ScheduleEdits } from './proposal-types.ts'

/**
 * A schedule's card in the conversation: 定时 keeps it (schedules.ts accept), as proposed or as changed on the card's
 * form (修改); 不用 lets the proposal go.
 */
export function createProposalActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const cardOf = (id: string): ProposalCard | undefined => getState().proposals.find((card: ProposalCard) => card.id === id)
  const isOpen = (card: ProposalCard | undefined): card is ProposalCard => !!card && !card.busy && card.status === 'open'

  /** One answer per card at a time; the card says how it went, and a refused form keeps what was typed. */
  async function settle(id: string, status: 'accepted' | 'declined', request: () => Promise<ProposalCard['accepted'] | void>,
    edited?: { draft: ProposalDraft, edits: ScheduleEdits }) {
    const card = cardOf(id)
    if (!isOpen(card)) return
    dispatch({ type: 'proposal_busy', id, ...(edited ? { draft: edited.draft } : {}) })
    try {
      const accepted = await request() ?? null
      dispatch({ type: 'proposal_settled', id, status, accepted, ...(edited ? { proposal: withEdits(card.proposal, edited.edits) } : {}) })
    } catch (err) {
      dispatch({ type: 'proposal_failed', id, message: errorMessage(err) })
    }
  }

  /** 定时 on the form: what it says, checked here first so a slip is said before anything is sent. */
  function acceptEdited(id: string, draft: ProposalDraft) {
    if (!isOpen(cardOf(id))) return
    const made = editsOf(draft)
    if ('problem' in made) {
      dispatch({ type: 'proposal_failed', id, message: t(made.problem), draft })
      return
    }
    return settle(id, 'accepted', () => api.acceptSchedule(id, made.edits), { draft, edits: made.edits })
  }

  return {
    acceptProposal: (id: string, draft?: ProposalDraft) => (draft ? acceptEdited(id, draft) : settle(id, 'accepted', () => api.acceptSchedule(id))),
    declineProposal: (id: string) => settle(id, 'declined', () => api.declineSchedule(id)),
    editProposal: (id: string, editing: boolean) => {
      if (isOpen(cardOf(id))) dispatch({ type: 'proposal_editing', id, editing })
    },
  }
}
