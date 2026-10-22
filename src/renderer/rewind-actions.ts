import { rewindTarget } from './rewind-state.ts'

/**
 * Going back to something the user said, from the window (phase 2): the bar's 从这里重来 (the same words again)
 * and 改了重发 (the editor in place, then the new words). The main process forks the agent and stores the new
 * segment (main/rewind-ipc.js); then the words go as the next question.
 */
const NOT_NOW = '助手在忙，或这句话还没保存好，稍后再试'
const FAILED = '没能回到那里'

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
  async function goBack(id: string, text: string | undefined, { confirmed = false } = {}) {
    const target = rewindTarget(getState(), id)
    const words = text?.trim()
    if (!target || !words) return showToast(NOT_NOW)
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
    return ask(words)
  }

  /** Opens a folded path in place to read it, or closes it again. */
  async function toggleFold(id: string) {
    if (getState().rewind.open[id]) return dispatch({ type: 'fold_closed', id })
    try {
      return dispatch({ type: 'fold_opened', id, ...await api.foldedPath(id) })
    } catch (err) {
      return showToast(`打不开那条路：${errorMessage(err)}`)
    }
  }

  /** Back onto a folded path; the one on screen folds where the two part. */
  async function switchPath(id: string) {
    const state = getState()
    if (state.phase !== 'idle' || state.rewind.busy) return showToast('先停止当前任务，再切到另一条路')
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
    redoFrom: (id: string) => goBack(id, getState().messages.find((message: ThreadMessage) => message.id === id)?.text),
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
