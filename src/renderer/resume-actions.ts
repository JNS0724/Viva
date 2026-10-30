import { t } from '../shared/i18n/translate.ts'
import type { ResumeAsk } from './resume-state.ts'

/**
 * 继续这个话题 (and 撤销 a new topic, and 回到这个话题 in the timeline): the agent takes up that topic's own session
 * in its own directory. Before switching to another directory, that is said (resume-state.ts 'confirm-dir'). When it
 * cannot be taken up (main resume-failure.ts):
 * - a fault on the way ('unavailable'): said so, with 重试; nothing else changes and nothing new is opened;
 * - its session gone ('gone'): asked whether to go on in a new conversation from its saved records;
 * - its directory gone ('missing-dir'): asked for another directory to go on from its saved records there.
 * Going on from records says what goes with it (how many turns) and is the user's choice, never done by itself.
 */
const RETRY_MS = 8000
const busyMessage = () => t("main.history-ipc.wait.for.this.turn.to.finish.before")

type Started = { info: AgentInfo, parentId: string, carried?: number | null }

export function createResumeActions({ api, getState, dispatch, showToast, errorMessage, busy, afterResume }: Pick<ActionDeps, 'getState' | 'dispatch' | 'errorMessage'> & {
  api: Pick<AgentApi, 'resumeCheck' | 'resumeTopic' | 'continueFromRecords' | 'chooseWorkDir'>,
  showToast: (text: string, options?: { action?: ToastAction | null, ms?: number }) => void,
  /** Whether the agent is at work (a turn, a question, a permission): then nothing is taken up. */
  busy: () => boolean,
  /** The conversation going on from the topic: scrolled to its end, the input focused. */
  afterResume: () => void,
}) {
  const started = ({ info, parentId, carried = null }: Started) => {
    dispatch({ type: 'topic_resumed', info, parentId, carried, at: Date.now() })
    afterResume()
  }

  /** Takes up its own session (the directory already settled). */
  async function takeUp(segmentId: string) {
    dispatch({ type: 'session_switching' })
    try {
      const result = await api.resumeTopic(segmentId)
      if (result.ok) return started(result)
      dispatch({ type: 'session_switch_failed' })
      // Where the agent is now: back where it was, or (that gone too) on a new session.
      if (result.info) dispatch({ type: 'config_applied', info: result.info })
      if (result.reason === 'unavailable') {
        return showToast(t("merge.cannot.reconnect.to.the.original.session.right.now.try.again.later.5", { p0: result.message }), { action: { label: t("thread.retry"), kind: 'resume-topic', payload: segmentId }, ms: RETRY_MS })
      }
      return dispatch({ type: 'resume_ask', stage: result.reason, segmentId, cwd: result.cwd ?? null })
    } catch (err) {
      dispatch({ type: 'session_switch_failed' })
      return showToast(errorMessage(err))
    }
  }

  /** Goes on from the topic's saved records, in a new conversation in `dir`. */
  async function fromRecords(segmentId: string, dir: string) {
    dispatch({ type: 'resume_dismiss' })
    dispatch({ type: 'session_switching' })
    try {
      const result = await api.continueFromRecords(segmentId, dir)
      started({ info: result.info, parentId: result.parentId, carried: result.turns })
    } catch (err) {
      dispatch({ type: 'session_switch_failed' })
      showToast(errorMessage(err))
    }
  }

  return {
    /** 继续这个话题: switches only after saying so when the directory changes, or asking when it is gone. */
    async resumeTopic(segmentId: string) {
      if (getState().switching) return undefined
      if (busy()) return showToast(busyMessage())
      try {
        const check = await api.resumeCheck(segmentId)
        if (!check.exists) return dispatch({ type: 'resume_ask', stage: 'missing-dir', segmentId, cwd: check.cwd })
        if (!check.same) return dispatch({ type: 'resume_ask', stage: 'confirm-dir', segmentId, cwd: check.cwd })
      } catch (err) {
        return showToast(errorMessage(err))
      }
      return takeUp(segmentId)
    },
    /** 重试 on a toast: straight to taking it up again (the directory was settled before). */
    retryResume: (segmentId: string) => (busy() ? showToast(busyMessage()) : takeUp(segmentId)),
    /** The dialog's main button: switch to the other directory, or go on from the records in the topic's directory. */
    async resumeConfirm() {
      const asked: ResumeAsk | null = getState().resume
      if (!asked) return undefined
      if (asked.stage === 'confirm-dir') {
        dispatch({ type: 'resume_dismiss' })
        return takeUp(asked.segmentId)
      }
      if (asked.stage === 'gone' && asked.cwd) return fromRecords(asked.segmentId, asked.cwd)
      return undefined
    },
    /** 换个目录… (its directory gone, or another wanted): the records go on in the one picked. */
    async resumeChooseDir() {
      const asked: ResumeAsk | null = getState().resume
      if (!asked) return undefined
      const dir = await api.chooseWorkDir()
      return dir ? fromRecords(asked.segmentId, dir) : undefined
    },
    resumeDismiss: () => dispatch({ type: 'resume_dismiss' }),
  }
}
