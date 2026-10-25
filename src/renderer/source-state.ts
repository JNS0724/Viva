/**
 * The 消息源 section of settings (sources-ipc.ts): the sources in the sources folder, the one whose form is
 * open, and what the last 测试连接 said. `busy` is the id of the source a change is in flight for.
 */
export const initialSources = Object.freeze({
  loaded: false,
  /** The sources folder, as settings shows it. */
  folder: '',
  sources: [] as Untyped[],
  /** Folders that could not be used, each with why. */
  broken: [] as Untyped[],
  /** A folder chosen to install, waiting for a yes (sources-ipc.ts pendingView), or null. */
  pending: null as Untyped,
  /** The source whose settings form is open, or null. */
  editing: null as string | null,
  busy: null as string | null,
  /** What 测试连接 said, for the source it was asked for: { id, ok, problem? }. */
  check: null as Untyped,
  error: null as string | null,
  notice: null as string | null,
})

const withSources = (state: State, changes: Partial<State['sources']>): State => ({ ...state, sources: { ...state.sources, ...changes } })

export const SOURCE_ACTIONS: Record<string, Reducer> = {
  sources_loaded: (state, { view }) => withSources(state, { ...view, loaded: true }),
  sources_busy: (state, { id }) => withSources(state, { busy: id, error: null, notice: null }),
  sources_failed: (state, { message }) => withSources(state, { busy: null, error: message }),
  sources_saved: (state, { view, notice, closeForm = false }) => withSources(state, {
    ...view, loaded: true, busy: null, error: null, notice, editing: closeForm ? null : state.sources.editing,
  }),
  sources_edit: (state, { id, notice = null }) => withSources(state, { editing: id, check: null, error: null, notice }),
  sources_checked: (state, { id, result }) => withSources(state, { busy: null, check: { id, ...result } }),
}
