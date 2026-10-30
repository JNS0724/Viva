import { t } from '../shared/i18n/translate.ts'
import { isBusy } from './state.ts'

const PREVIOUS_TOPIC_EVENTS = new Set(['update', 'config', 'turn_end', 'memory_context', 'question', 'question_closed', 'secret_request', 'secret_closed', 'followup_propose'])
/** Background tasks remain live while the old foreground session finishes closing. */
export function isPreviousTopicEvent(event: { type?: string, taskId?: string }) {
  return PREVIOUS_TOPIC_EVENTS.has(event.type ?? '') || (event.type === 'permission' && !event.taskId)
}

/** Show the new topic before waiting for the runtime; retries keep this same blank topic and its draft. */
export function createNewTopicAction({ getState, dispatch, open, focus, jump, toast, errorMessage, frame, measure = () => {} }: {
  getState: () => State, dispatch: (action: Action) => void, open: () => Promise<AgentInfo>,
  focus: () => void, jump: () => void, toast: (message: string) => void, errorMessage: (error: unknown) => string,
  frame?: (callback: () => void) => void,
  measure?: (result: { stage: 'ui' | 'first-frame' | 'ready' | 'failed', durationMs: number }) => void,
}) {
  return async () => {
    const state = getState()
    if (state.switching || state.workDir.switching || state.settings.busy || state.settings.permissionBusy || state.rewind.busy || state.tasks.moving) return
    if (isBusy(state)) { toast(t("new-topic-actions.stop.the.current.task.before.starting.a")); return }
    const started = performance.now()
    dispatch({ type: 'new_session_pending', at: Date.now() })
    jump()
    focus()
    measure({ stage: 'ui', durationMs: performance.now() - started })
    frame?.(() => measure({ stage: 'first-frame', durationMs: performance.now() - started }))
    try {
      dispatch({ type: 'new_session_ready', info: await open() })
      measure({ stage: 'ready', durationMs: performance.now() - started })
    } catch (error) {
      dispatch({ type: 'new_session_failed', message: errorMessage(error) })
      measure({ stage: 'failed', durationMs: performance.now() - started })
    }
  }
}
