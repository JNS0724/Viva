/**
 * 继续这个话题, when it needs the user to decide (view/resume-dialog.ts, resume-actions.ts):
 * - 'confirm-dir': it goes on in another directory than the one in use: said before switching;
 * - 'missing-dir': its directory is not there any more, so its own session cannot be taken up: another directory
 *   is chosen, and it goes on from its saved records there;
 * - 'gone': the agent no longer has its session: it can go on from its saved records, in its directory.
 * Merged into `state.js`'s reducer like the other slices.
 */
export type ResumeStage = 'confirm-dir' | 'missing-dir' | 'gone'
export type ResumeAsk = { stage: ResumeStage, segmentId: string, cwd: string | null }

export const initialResume = null as ResumeAsk | null

export const RESUME_ACTIONS: Record<string, Reducer> = {
  resume_ask: (state, { stage, segmentId, cwd = null }) => ({ ...state, resume: { stage, segmentId, cwd } }),
  resume_dismiss: (state) => (state.resume === null ? state : { ...state, resume: null }),
}
