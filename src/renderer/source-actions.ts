/** The form as the main process takes it (sources-ipc.ts formChange). */
export type SourceForm = { everyMinutes?: number, values?: Record<string, unknown> }

/** While a source is reading, the page asks again this often, so what it read shows up without 刷新. */
const RUNNING_RECHECK_MS = 1500
/** What `busy` holds while a folder is being chosen or installed (no source has this id: ids have no colon). */
const INSTALLING = ':install'

/**
 * The 消息源 section of settings: switching a source on or off, its form (saved, or tested without saving),
 * 现在拉一次, and opening the sources folder. A change applies at the source's next run; nothing restarts.
 */
export function createSourceActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const fail = (err: unknown) => dispatch({ type: 'sources_failed', message: errorMessage(err) })
  const sourceOf = (id: string) => getState().sources.sources.find((source: { id: string }) => source.id === id)
  let recheck: ReturnType<typeof setTimeout> | null = null

  /** Shows `view`, and looks again shortly while one of its sources is still reading. */
  function shown(view: { sources: Array<{ running: boolean }> }, action: Record<string, unknown>) {
    dispatch({ ...action, view })
    if (recheck || !view.sources.some((source) => source.running)) return
    recheck = setTimeout(() => {
      recheck = null
      if (getState().settings.open) void load()
    }, RUNNING_RECHECK_MS)
  }

  async function load() {
    try {
      shown(await api.getSources(), { type: 'sources_loaded' })
    } catch (err) {
      fail(err)
    }
  }

  /** Runs `request` for `id` unless a change is in flight; `notice` may depend on the answer. */
  async function change(id: string, request: () => Promise<unknown>, notice: string | null | ((view: { removed?: string }) => string), { closeForm = false } = {}) {
    if (getState().sources.busy) return
    dispatch({ type: 'sources_busy', id })
    try {
      const view = await request() as { sources: Array<{ running: boolean }>, removed?: string }
      shown(view, { type: 'sources_saved', notice: typeof notice === 'function' ? notice(view) : notice, closeForm })
    } catch (err) {
      fail(err)
    }
  }

  return {
    loadSources: load,
    /** Switching on a source whose required fields are empty opens its form instead. */
    toggleSource(id: string, enabled: boolean) {
      const missing: string[] = sourceOf(id)?.settings.missing ?? []
      if (enabled && missing.length) return dispatch({ type: 'sources_edit', id, notice: `先填好：${missing.join('、')}，再打开` })
      return change(id, () => api.saveSource(id, { enabled }), enabled ? '已打开，马上拉一次' : '已关闭，不再读取')
    },
    editSource: (id: string) => dispatch({ type: 'sources_edit', id }),
    cancelSourceEdit: () => dispatch({ type: 'sources_edit', id: null }),
    saveSource: (id: string, form: SourceForm) => change(id, () => api.saveSource(id, form), '已保存，下次拉取时生效', { closeForm: true }),
    async checkSource(id: string, form: SourceForm) {
      if (getState().sources.busy) return
      dispatch({ type: 'sources_busy', id })
      try {
        dispatch({ type: 'sources_checked', id, result: await api.checkSource(id, form) })
      } catch (err) {
        fail(err)
      }
    },
    pollSourceNow: (id: string) => change(id, () => api.pollSourceNow(id), null),
    /** 安装消息源…: the folder dialog, then the chosen folder shown for a yes (or why it cannot be installed). */
    chooseSource: () => change(INSTALLING, () => api.chooseSource(), null),
    installSource: () => change(INSTALLING, () => api.installSource(), '已安装，填好设置后打开它'),
    cancelSourceInstall: () => change(INSTALLING, () => api.cancelSourceInstall(), null),
    /** Moves its folder to the trash and lets its settings, messages and data go. */
    removeSource: (id: string, name: string) => change(id, () => api.removeSource(id),
      (view) => (view.removed === 'trashed' ? `已把「${name}」移到废纸篓` : `已删除「${name}」`)),
    async openSourcesFolder() {
      try {
        await api.openSourcesFolder()
      } catch (err) {
        fail(err)
      }
    },
  }
}
