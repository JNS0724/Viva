/**
 * The "关于你" page (profile, memories, intro) and the 扩展 section of settings (MCP servers, skills).
 * Pure and immutable like the rest of `state.js`, which merges these handlers into its reducer.
 */
export const initialMemory = Object.freeze({
  open: false,
  /** 'profile' shows what the agent knows; 'intro' is the short get-to-know-you form. */
  view: 'profile',
  loaded: false,
  profile: {},
  items: [],
  total: 0,
  /** How many memories stopped counting (replaced or forgotten), and the list once opened. */
  invalid: 0,
  invalidOpen: false,
  invalidItems: [],
  /** The profile the agent last synthesised from the memories: { text, createdAt }, or null. */
  synthesis: null,
  onboarding: 'pending',
  habits: { text: '', samples: 0 },
  query: '',
  /** Profile field being edited in place, or null. */
  editing: null,
  /** Documents picked in the intro, already copied into the workspace. */
  docs: [],
  /** Id of the memory added last from the page, so its input starts empty again. */
  lastAdded: null,
  busy: false,
  error: null,
})

export const initialExtensions = Object.freeze({
  loaded: false,
  servers: [],
  status: { active: [], memory: false, dropped: [] },
  skills: [],
  skillDir: '',
  /** The add-server form is open. */
  busy: false,
  error: null,
  notice: null,
})

const withMemory = (state: State, changes: Partial<State['memory']>): State => ({ ...state, memory: { ...state.memory, ...changes } })
const withExtensions = (state: State, changes: Partial<State['extensions']>): State => ({ ...state, extensions: { ...state.extensions, ...changes } })

/** @param {{ profile: object }} memory */
export const isProfileEmpty = (memory: { profile: object }) => Object.keys(memory.profile).length === 0

export const PERSONAL_ACTIONS: Record<string, Reducer> = {
  /** A reload keeps the hits of a search that is still typed. */
  memory_loaded: (state, { data }) => withMemory(state, {
    loaded: true,
    profile: data.profile,
    items: state.memory.query.trim() ? state.memory.items : data.items,
    total: data.total,
    invalid: data.invalid ?? 0,
    synthesis: data.synthesis ?? null,
    onboarding: data.onboarding,
    habits: data.habits,
    busy: false,
  }),
  memory_open: (state, { view = 'profile' }) => withMemory(
    { ...state, island: false, picker: false, history: { ...state.history, open: false } },
    { open: true, view, editing: null, error: null, query: '', docs: view === 'intro' ? [] : state.memory.docs },
  ),
  memory_close: (state) => withMemory(state, { open: false, editing: null, error: null, busy: false }),
  memory_edit: (state, { key }) => withMemory(state, { editing: key, error: null }),
  memory_busy: (state) => withMemory(state, { busy: true, error: null }),
  memory_failed: (state, { message }) => withMemory(state, { busy: false, error: message }),
  memory_profile_saved: (state, { profile }) => withMemory(state, { profile, editing: null, busy: false, error: null }),
  memory_query: (state, { query }) => withMemory(state, { query }),
  /** Answers to an older search arrive late sometimes; only the one still typed counts. */
  memory_listed: (state, { query, items, total }) => (query === state.memory.query
    ? withMemory(state, { items, total, busy: false })
    : state),
  memory_added: (state, { memory }) => withMemory(state, {
    lastAdded: memory.id,
    items: [memory, ...state.memory.items.filter((item) => item.id !== memory.id)],
    total: state.memory.total + (state.memory.items.some((item) => item.id === memory.id) ? 0 : 1),
    busy: false,
    error: null,
  }),
  memory_removed: (state, { id }) => withMemory(state, {
    items: state.memory.items.filter((item) => item.id !== id),
    total: Math.max(0, state.memory.total - 1),
  }),
  memory_invalid_listed: (state, { items }) => withMemory(state, { invalidOpen: true, invalidItems: items, invalid: items.length }),
  memory_invalid_closed: (state) => withMemory(state, { invalidOpen: false, invalidItems: [] }),
  memory_revived: (state, { memory }) => withMemory(state, {
    invalidItems: state.memory.invalidItems.filter((item) => item.id !== memory.id),
    invalid: Math.max(0, state.memory.invalid - 1),
    items: [memory, ...state.memory.items.filter((item) => item.id !== memory.id)],
    total: state.memory.total + 1,
  }),
  memory_onboarding: (state, { status }) => withMemory(state, { onboarding: status }),
  memory_docs_added: (state, { docs }) => withMemory(state, {
    docs: [...state.memory.docs, ...docs.filter((doc: { path: string }) => !state.memory.docs.some((known) => known.path === doc.path))],
    busy: false,
  }),

  extensions_loaded: (state, { view }) => withExtensions(state, { ...view, loaded: true, busy: false }),
  extensions_busy: (state) => withExtensions(state, { busy: true, error: null, notice: null }),
  extensions_failed: (state, { message }) => withExtensions(state, { busy: false, error: message }),
  extensions_saved: (state, { view, notice }) => withExtensions(state, {
    ...view, loaded: true, busy: false, error: null, notice,
  }),
}
