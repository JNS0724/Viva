import { t } from '../shared/i18n/translate.ts'
import { isBusy } from './state.ts'

/** What to tell the user after a change to the servers, from what the main process reports back. */
const appliedNotice = (done: string) => (view: { info?: unknown }) => (view.info ? t("extension-actions.active.in.this.conversation", { done: done }) : t("extension-actions.takes.effect.on.the.next.connection", { done: done }))

/** The edit form as the main process takes it (extensions-ipc.ts formChanges). */
type ServerForm = { name: string, type: string, command: string, args: string, url: string, keys: Array<{ name: string, value: string }> }

/**
 * The 扩展 section of settings: the user's MCP servers and skills, listed, edited in place and removable, and
 * the servers of the user's own dsh, imported with their keys. Adding one by hand happens in the conversation
 * (viva-config).
 */
export function createExtensionActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const fail = (err: unknown) => dispatch({ type: 'extensions_failed', message: errorMessage(err) })

  /** Runs `request` unless another change is in flight; `noticeFor` turns the answer into a status line. */
  async function change(request: () => Promise<{ info?: unknown, [field: string]: any }>, noticeFor: (view: { info?: unknown }) => string | null,
    { importNote = false } = {}) {
    if (getState().extensions.busy) return
    dispatch({ type: 'extensions_busy' })
    try {
      const view = await request()
      if (view.cancelled) return dispatch({ type: 'extensions_loaded', view })
      dispatch({ type: 'extensions_saved', view, notice: noticeFor(view), importNote: importNote ? view.notice : null })
      if (view.info) dispatch({ type: 'config_applied', info: view.info })
    } catch (err) {
      fail(err)
    }
  }

  /** Changing servers reattaches the session, which would cancel a running task. */
  function guardMcp() {
    if (!isBusy(getState())) return true
    dispatch({ type: 'extensions_failed', message: t("extension-actions.stop.the.current.task.before.changing.mcp") })
    return false
  }

  return {
    async loadExtensions() {
      try {
        dispatch({ type: 'extensions_loaded', view: await api.getExtensions() })
      } catch (err) {
        fail(err)
      }
    },
    removeServer(name: string) {
      if (guardMcp()) change(() => api.removeMcpServer(name), appliedNotice(t("extension-actions.deleted")))
    },
    removeSkill: (skill: { id: string, name: string }) => change(() => api.removeSkill(skill.id), () => t("extension-actions.moved.to.trash", { name: skill.name })),

    toggleImportMenu: () => dispatch({ type: 'extensions_import_menu' }),
    closeImportMenu: () => dispatch({ type: 'extensions_import_menu', open: false }),
    /** from: 'default' (dsh's home), 'last' (the folder used last time) or 'choose' (the folder dialog). */
    importDsh(from: 'default' | 'last' | 'choose') {
      dispatch({ type: 'extensions_import_menu', open: false })
      if (guardMcp()) change(() => api.importDsh(from), () => null, { importNote: true })
    },

    editServer: (server: object) => dispatch({ type: 'extensions_edit', server }),
    cancelEdit: () => dispatch({ type: 'extensions_edit', server: null }),
    setEditType: (kind: 'stdio' | 'http') => dispatch({ type: 'extensions_edit_type', kind }),
    addEditKey: () => dispatch({ type: 'extensions_edit_key_add' }),
    removeEditKey: (id: number) => dispatch({ type: 'extensions_edit_key_remove', id }),
    saveServer(name: string, form: ServerForm) {
      if (guardMcp()) change(() => api.updateMcpServer(name, form), appliedNotice(t("extension-actions.saved")))
    },
  }
}
