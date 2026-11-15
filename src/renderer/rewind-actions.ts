import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import { rewindTarget } from './rewind-state.ts'
import { MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG } from '../shared/text-limits.ts'

/**
 * Resend a message from the in-place editor, with or without changes. The backend starts a new segment
 * from before the message, then the editor's text goes as the next question.
 */
let NOT_NOW = t("rewind-actions.the.assistant.is.busy.or.this.message")
let FAILED = t("rewind-actions.could.not.return.there")

export function createRewindActions({ api, getState, dispatch, showToast, errorMessage, ask }: Pick<ActionDeps, 'getState' | 'dispatch' | 'showToast' | 'errorMessage' | 'ask'> & {
  api: Pick<AgentApi, 'rewind' | 'rewindEffects' | 'foldedPath' | 'switchPath'>,
}) {
  /** What the part that would fold changed on the computer; none known when it cannot be read. */
  async function effectsOf(target: NonNullable<ReturnType<typeof rewindTarget>>) {
    try {
      return await api.rewindEffects({ keep: target.keep })
    } catch (err) {
      console.error('[rewind] could not read what that path changed:', errorMessage(err))
      return { files: [], commands: [] }
    }
  }

  /** Going back over files written or commands run asks first (view/rewind.js rewindConfirm); else it just goes. */
  async function goBack(id: string, text: string, { confirmed = false } = {}) {
    const target = rewindTarget(getState(), id)
    const trimmed = text.trim()
    const words = text === target?.words ? text : trimmed
    if (words.length > MAX_MESSAGE_CHARS) return showToast(MESSAGE_TOO_LONG)
    if (!target || !trimmed) return showToast(NOT_NOW)
    if (!confirmed) {
      const effects = await effectsOf(target)
      if (effects.files.length || effects.commands.length) return dispatch({ type: 'rewind_confirm', id, text: words, effects })
    }
    dispatch({ type: 'rewind_busy' })
    let result
    try {
      result = await api.rewind({ ...target, text: words })
    } catch (err) {
      result = { ok: false, problem: errorMessage(err) || FAILED }
    }
    if (!result.ok) {
      dispatch({ type: 'rewind_failed' })
      return showToast(result.problem ?? FAILED)
    }
    dispatch({ type: 'rewound', conversation: result.conversation, info: result.info, folds: result.folds })
    // Selection commits schedule the foreground ingress drain. Observe its turn_started before
    // deciding whether these words are a new prompt or an interjection into a report already running.
    await Promise.resolve()
    return ask(words, { sourceId: result.sourceId, newSource: result.newSource })
  }

  /** Opens a folded path in place to read it, or closes it again. */
  async function toggleFold(id: string) {
    if (getState().rewind.open[id]) return dispatch({ type: 'fold_closed', id })
    try {
      return dispatch({ type: 'fold_opened', id, ...await api.foldedPath(id) })
    } catch (err) {
      return showToast(t("rewind-actions.could.not.open.that.branch", { value1: errorMessage(err) }))
    }
  }

  /** Back onto a folded path; the one on screen folds where the two part. */
  async function switchPath(id: string) {
    const state = getState()
    if (state.phase !== 'idle' || state.rewind.busy) return showToast(t("rewind-actions.stop.the.current.task.before.switching.branches"))
    dispatch({ type: 'rewind_busy' })
    let result
    try {
      result = await api.switchPath(id)
    } catch (err) {
      result = { ok: false, problem: errorMessage(err) || FAILED }
    }
    if (!result.ok) {
      dispatch({ type: 'rewind_failed' })
      return showToast(result.problem ?? FAILED)
    }
    return dispatch({ type: 'rewound', conversation: result.conversation, info: result.info, folds: result.folds })
  }

  return {
    toggleFold,
    switchPath,
    editFrom: (id: string) => (rewindTarget(getState(), id) ? dispatch({ type: 'rewind_edit', id }) : showToast(NOT_NOW)),
    cancelEdit: () => dispatch({ type: 'rewind_cancel' }),
    submitEdit: (id: string, text: string) => goBack(id, text),
    /** 知道了，重来: the user knows what will not be undone. */
    confirmRewind() {
      const asked = getState().rewind.confirm
      return asked ? goBack(asked.id, asked.text, { confirmed: true }) : undefined
    },
    cancelRewindConfirm: () => dispatch({ type: 'rewind_confirm_cancel' }),
  }
}

onLocaleChange(() => {
  NOT_NOW = t("rewind-actions.the.assistant.is.busy.or.this.message")
  FAILED = t("rewind-actions.could.not.return.there")
})
