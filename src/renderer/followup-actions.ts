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
    dismissFollowup: (id: string) => change(() => api.dismissFollowup(id), '好，这件不跟进了'),
    async continueFollowup(id: string) {
      const view = await change(() => api.continueFollowup(id))
      if (view?.text) fillComposer(view.text)
    },
    async followupInBackground(id: string) {
      const view = await change(() => api.continueFollowup(id))
      if (view?.text) startTask(view.text)
    },
    prepareFollowupNow: (id: string) => change(() => api.prepareFollowupNow(id), '马上在后台准备'),
    wakePreparation: () => change(() => api.wakePreparation(), '叫醒了，过一会儿再准备'),
    savePrepareSchedule: (schedule: Record<string, unknown>) => change(() => api.setPrepareSchedule(schedule), '已保存，下一个时段起按新的时段准备'),
    pausePreparation: (minutes: number) => change(() => api.pausePreparation(minutes), minutes ? `后台准备暂停 ${minutes / 60} 小时` : '后台准备继续'),
  }
}
