import { t } from '../shared/i18n/translate.ts'

/** What the main process answers a change with (plugins-ipc.ts): what it did, and the section as it is now. */
type Change = { changed: boolean, application: string, error: { code: string, detail: string | null } | null, pendingBuilds: string[] }
type ChangeAnswer = { change: Change, view: Untyped }

/** dsh's codes for a refusal (dsh-plugin-manager), in the user's words. */
const PROBLEMS: Readonly<Record<string, () => string>> = Object.freeze({
  'invalid-spec': () => t('plugins.problem.invalid-spec'),
  'already-installed': () => t('plugins.problem.already-installed'),
  'not-found': () => t('plugins.problem.not-found'),
  'not-a-package': () => t('plugins.problem.not-a-package'),
  'not-a-bundle': () => t('plugins.problem.not-a-bundle'),
  network: () => t('plugins.problem.network'),
  'incompatible-version': () => t('plugins.problem.incompatible-version'),
})

/** dsh's code for a refusal, in the user's words; the manager's own words for anything else. */
export function problemText(code: string, detail: string | null = null): string {
  return PROBLEMS[code]?.() ?? t('plugins.problem.unknown', { detail: detail ?? code })
}

/** What to tell the user after a change; null when it asks for build scripts first (shown in the section). */
export function changeNotice(change: Change): string | null {
  if (change.pendingBuilds.length) return null
  if (change.application === 'restart-required') return t('plugins.restart.required')
  if (change.application === 'overridden') return t('plugins.overridden')
  return t('plugins.applied')
}

/**
 * The 插件 section of settings. An install is looked up first, so the user sees what the spec names (and the trust
 * notice) before anything runs; installs and removals can take a while (pnpm downloads and builds).
 */
export function createPluginActions({ api, getState, dispatch, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'>) {
  const fail = (message: string) => dispatch({ type: 'plugins_failed', message })
  const plugins = () => getState().plugins

  /** Runs one change unless another is in flight, and shows what it did. */
  async function change(request: () => Promise<ChangeAnswer>, done: (change: Change) => string | null = changeNotice) {
    if (plugins().busy) return
    dispatch({ type: 'plugins_busy' })
    try {
      const { change: result, view } = await request()
      if (result.error) {
        dispatch({ type: 'plugins_changed', view })
        return fail(problemText(result.error.code, result.error.detail))
      }
      dispatch({ type: 'plugins_changed', view, notice: done(result), pendingBuilds: result.pendingBuilds })
    } catch (err) {
      fail(errorMessage(err))
    }
  }

  return {
    async loadPlugins() {
      try {
        dispatch({ type: 'plugins_loaded', view: await api.getPlugins() })
      } catch (err) {
        fail(errorMessage(err))
      }
    },
    editPluginSpec: (spec: string) => dispatch({ type: 'plugins_spec', spec }),
    async inspectPlugin() {
      const spec = plugins().spec.trim()
      if (!spec) return fail(t('plugins.enter.spec'))
      if (plugins().busy) return
      dispatch({ type: 'plugins_busy' })
      try {
        const inspection = await api.inspectPlugin(spec)
        if (!inspection.ok) return fail(problemText(inspection.problem))
        dispatch({ type: 'plugins_inspected', inspection })
      } catch (err) {
        fail(errorMessage(err))
      }
    },
    /** 安装, or 允许并安装 with the build scripts the first attempt asked for. */
    installPlugin() {
      const { spec, pendingBuilds } = plugins()
      if (!spec.trim()) return fail(t('plugins.enter.spec'))
      return change(() => api.installPlugin(spec.trim(), pendingBuilds.length ? [...pendingBuilds] : undefined))
    },
    dismissPluginInstall: () => dispatch({ type: 'plugins_dismiss' }),
    removePlugin: (name: string) => change(() => api.removePlugin(name), () => t('plugins.removed', { name })),
    setPluginEnabled: (name: string, enabled: boolean) => change(() => api.setPluginEnabled(name, enabled)),
  }
}
