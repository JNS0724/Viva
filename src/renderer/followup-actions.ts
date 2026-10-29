import { t } from '../shared/i18n/translate.ts'
import type { ProposalCard } from './followup-state.ts'

/**
 * Follow-ups from the window: the card's 跟进 / 不用 / 以后别问这类 (and, for the first that needs preparing, the
 * windows), and the 后台 page's 接着做 (the draft into the input, for the user to send), 后台做 (to a task of its
 * own), 不用了, 现在就准备, 叫醒它; settings' 后台准备.
 */
export function createFollowupActions({ api, getState, dispatch, errorMessage, fillComposer, startTask }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'> & {
  /** Puts `text` in the input, the window in front, for the user to read and send. */
  fillComposer: (text: string) => void
  /** 后台做 with `text` (task-actions.ts). */
  startTask: (text: string) => unknown
}) {
  const fail = (err: unknown) => dispatch({ type: 'followups_failed', message: errorMessage(err) })
  const cardOf = (id: string): ProposalCard | undefined => getState().proposals.find((card: ProposalCard) => card.id === id)

  async function change(request: () => Promise<unknown>, notice: string | null = null) {
    if (getState().followups.busy) return null
    dispatch({ type: 'followups_busy' })
    try {
      const view = await request()
      dispatch({ type: 'followups_saved', view, notice })
      return view as Record<string, any>
    } catch (err) {
      fail(err)
      return null
    }
  }

  async function settle(id: string, status: 'declined' | 'never') {
    const card = cardOf(id)
    if (!card || card.busy) return
    dispatch({ type: 'proposal_busy', id })
    try {
      await api.declineFollowup({ title: card.proposal.title, never: status === 'never' })
      dispatch({ type: 'proposal_settled', id, status })
    } catch (err) {
      dispatch({ type: 'proposal_failed', id, message: errorMessage(err) })
    }
  }

  return {
    async loadFollowups() {
      try {
        dispatch({ type: 'followups_loaded', view: await api.getFollowups() })
      } catch (err) {
        fail(err)
      }
    },
    /** 跟进: made in the main process, its times checked there; the card says what was set. */
    async acceptProposal(id: string) {
      const card = cardOf(id)
      if (!card || card.busy) return
      dispatch({ type: 'proposal_busy', id })
      try {
        const result = await api.acceptFollowup({ ...card.proposal, conversationId: getState().conversationId })
        dispatch({ type: 'followups_saved', view: result })
        dispatch({ type: 'proposal_settled', id, status: 'accepted', accepted: result.accepted, chooseWindows: result.chooseWindows })
      } catch (err) {
        dispatch({ type: 'proposal_failed', id, message: errorMessage(err) })
      }
    },
    declineProposal: (id: string) => settle(id, 'declined'),
    neverProposal: (id: string) => settle(id, 'never'),
    /** The first follow-up that needs preparing asks when preparation may run: a preset, from the card. */
    async chooseWindows(id: string, preset: string) {
      dispatch({ type: 'proposal_busy', id })
      try {
        dispatch({ type: 'followups_saved', view: await api.setPrepareSchedule({ preset }) })
        dispatch({ type: 'proposal_windows', id, chosen: preset })
      } catch (err) {
        dispatch({ type: 'proposal_failed', id, message: errorMessage(err) })
      }
    },
    dismissFollowup: (id: string) => change(() => api.dismissFollowup(id), t("followup-actions.this.follow.up.has.been.removed")),
    async continueFollowup(id: string) {
      const view = await change(() => api.continueFollowup(id))
      if (view?.text) fillComposer(view.text)
    },
    async followupInBackground(id: string) {
      const view = await change(() => api.continueFollowup(id))
      if (view?.text) startTask(view.text)
    },
    prepareFollowupNow: (id: string) => change(() => api.prepareFollowupNow(id), t("followup-actions.preparing.in.the.background.now")),
    wakePreparation: () => change(() => api.wakePreparation(), t("followup-actions.awake.preparation.will.resume.shortly")),
    savePrepareSchedule: (schedule: Record<string, unknown>) => change(() => api.setPrepareSchedule(schedule), t("followup-actions.saved.the.new.schedule.starts.with.the")),
    /** A message suggested for a follow-up: 跟进, 不重要 (learnt), 以后别问这类. */
    settleSuggestion: (id: string, action: 'accept' | 'decline' | 'never') => change(() => api.settleSuggestion(id, action),
      action === 'accept' ? t("followup-actions.added.to.follow.ups.a.draft.will") : action === 'never' ? t("followup-actions.you.will.not.be.asked.about.this") : t("followup-actions.noted.this.kind.of.message.is.not")),
    pausePreparation: (minutes: number) => change(() => api.pausePreparation(minutes), minutes ? t("followup-actions.background.preparation.paused.for.hours", { value1: minutes / 60 }) : t("followup-actions.background.preparation.resumed")),
  }
}
