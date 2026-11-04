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

export const PLUGIN_ACTIONS: Record<string, Reducer> = {
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
}
