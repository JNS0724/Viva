import type { ActionHandlers } from './action-types.ts'
import { t } from '../shared/i18n/translate.ts'
/**
 * The 插件 section of settings (plugins-ipc.ts): the dsh plugins the user installed, and an install in two steps:
 * what the spec names (`inspection`), then 安装; a first attempt may ask to allow dependency build scripts
 * (`pendingBuilds`), and 允许并安装 tries again with them.
 */
export const initialPlugins = Object.freeze({
  loaded: false,
  /** dsh is running: its plugin manager answers. */
  connected: true,
  plugins: [] as Untyped[],
  /** What the install field says. */
  spec: '',
  /** What the spec names, shown before anything is installed; null when nothing was looked up. */
  inspection: null as Untyped,
  /** Build scripts an install asked to allow. */
  pendingBuilds: [] as string[],
  busy: false,
  error: null as string | null,
  notice: null as string | null,
})

const withPlugins = (state: State, changes: Partial<State['plugins']>): State => ({ ...state, plugins: { ...state.plugins, ...changes } })

export const PLUGIN_ACTIONS= {
  plugins_loaded: (state, { view }) => withPlugins(state, { ...view, loaded: true, busy: false }),
  plugins_busy: (state) => withPlugins(state, { busy: true, error: null, notice: null }),
  plugins_failed: (state, { message }) => withPlugins(state, { busy: false, error: message }),
  plugins_spec: (state, { spec }) => withPlugins(state, { spec, inspection: null, pendingBuilds: [], error: null, notice: null }),
  plugins_inspected: (state, { inspection }) => withPlugins(state, { busy: false, inspection }),
  /** After an install, removal or switch: the list as it is now; an install that asks for build scripts stays open. */
  plugins_changed: (state, { view, notice = null, pendingBuilds = [] }) => withPlugins(state, {
    ...view, loaded: true, busy: false, notice, error: null, pendingBuilds,
    ...(pendingBuilds.length ? {} : { spec: '', inspection: null }),
  }),
  plugins_dismiss: (state) => withPlugins(state, { inspection: null, pendingBuilds: [], error: null }),
} satisfies ActionHandlers

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
