import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
let BUSY = t("workdir-actions.wait.for.this.turn.to.finish.before")
let FAILED = t("workdir-actions.could.not.change.the.working.directory")

export function createWorkDirActions({ api, getState, dispatch, errorMessage, showToast }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage' | 'showToast'>) {
  const refused = (message: string) => {
    dispatch({ type: 'workdir_failed', message })
    showToast(message)
  }

  async function refresh() {
    try {
      dispatch({ type: 'workdir_loaded', view: await api.getWorkDir() })
    } catch (err) {
      console.error('[workdir] could not read the working directory:', errorMessage(err))
    }
  }

  /** confirmed: the user said 在这里工作 */
  async function switchTo(dir: string, { confirmed = false } = {}) {
    dispatch({ type: 'workdir_switching' })
    try {
      const result = await api.switchWorkDir(dir, { confirmed })
      if (result.ok) return dispatch({ type: 'workdir_loaded', view: result.state })
      if (result.needsConfirm) {
        dispatch({ type: 'workdir_failed', message: null })
        return dispatch({ type: 'workdir_confirm', dir: result.dir })
      }
      return refused(result.problem ?? (result.reason === 'busy' ? BUSY : FAILED))
    } catch (err) {
      return refused(errorMessage(err) || FAILED)
    }
  }

  /** The system's folder dialog (⌘O / Ctrl+O, or 选择文件夹… in the menu). */
  async function choose() {
    dispatch({ type: 'workdir_menu', open: false })
    const dir = await api.chooseWorkDir()
    if (dir) await switchTo(dir)
  }

  function confirm() {
    const dir = getState().workDir.confirm
    if (dir) switchTo(dir, { confirmed: true })
  }

  async function forget(dir: string) {
    dispatch({ type: 'workdir_loaded', view: await api.forgetWorkDir(dir) })
  }

  return {
    refresh,
    switchTo,
    choose,
    confirm,
    forget,
    cancelConfirm: () => dispatch({ type: 'workdir_confirm', dir: null }),
    toggleMenu: () => dispatch({ type: 'workdir_menu', open: !getState().workDir.menu }),
    closeMenu: () => getState().workDir.menu && dispatch({ type: 'workdir_menu', open: false }),
    reveal: () => {
      dispatch({ type: 'workdir_menu', open: false })
      return api.revealWorkDir()
    },
  }
}

onLocaleChange(() => {
  BUSY = t("workdir-actions.wait.for.this.turn.to.finish.before")
  FAILED = t("workdir-actions.could.not.change.the.working.directory")
})
