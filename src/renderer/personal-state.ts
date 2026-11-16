import type { ActionHandlers } from './action-types.ts'
import type { MemoryChangeRecord, MemorySummaryView } from '../shared/ipc-results.ts'
import { initialMemoryFiles } from './memory-file-state.ts'
/**
 * The "关于你" page (profile, memories, intro) and the 扩展 section of settings (MCP servers, skills).
 * Pure and immutable like the rest of `state.js`, which merges these handlers into its reducer.
 */
export const initialMemory = Object.freeze({
  open: false,
  /** 'profile' shows what the agent knows; 'intro' is the short get-to-know-you form. */
  view: 'profile',
  loaded: false,
  loadError: null as string | null,
  fileMode: false,
  files: initialMemoryFiles,
  profile: {},
  items: [],
  total: 0,
  /** Pending jobs in owner storage. Host and native receipts are tracked separately. */
  cleanupPending: 0,
  /** How many memories stopped counting (replaced or forgotten), and the list once opened. */
  invalid: 0,
  invalidOpen: false,
  invalidLoaded: false,
  invalidItems: [],
  conflictEditor: null as string | null,
  changesOpen: false,
  changesLoaded: false,
  changes: [] as MemoryChangeRecord[],
  changeBusy: false,
  rebuildingIndexes: false,
  summaries: null as { user: MemorySummaryView, project: MemorySummaryView | null } | null,
  onboarding: 'pending',
  habits: { text: '', samples: 0 },
  query: '',
  /** Profile field being edited in place, or null. */
  editing: null,
  editingMemory: null as { id: number, revision: number } | null,
  /** Documents picked in the intro, already copied into the workspace. */
  docs: [],
  /** Id of the memory added last from the page, so its input starts empty again. */
  lastAdded: null,
  busy: false,
  error: null,
})

/** A key row of the edit form: its own id (rows come and go), its name, and whether a value is saved for it. */
type KeyRow = { id: number, name: string, saved: boolean }
/** The server being edited in place: its name as saved, the type picked, the key rows. */
type EditDraft = { name: string, type: string, keys: KeyRow[], nextId: number }

export const initialExtensions = Object.freeze({
  loaded: false,
  servers: [],
  status: { active: [], memory: false, dropped: [] },
  skills: [],
  skillDir: '',
  /** Where MCP servers can be imported from, as shown: dsh's default home, and the folder used last if another. */
  dsh: { defaultLabel: '', lastLabel: '' },
  importMenu: false,
  /** What the last import did, shown by the servers until the next change. */
  importNote: null as string | null,
  editing: null as EditDraft | null,
  busy: false,
  error: null,
  notice: null,
})

/** The edit form of `server` (extensions.ts Server): its saved keys first, then the ones still without a value. */
function draftOf(server: { name: string, type: string, envNames: string[], headerNames: string[], missingNames?: string[] }): EditDraft {
  const keys = [
    ...[...server.envNames, ...server.headerNames].map((name) => ({ name, saved: true })),
    ...(server.missingNames ?? []).map((name) => ({ name, saved: false })),
  ].map((key, id) => ({ id, ...key }))
  return { name: server.name, type: server.type, keys, nextId: keys.length }
}

const withMemory = (state: State, changes: Partial<State['memory']>): State => ({ ...state, memory: { ...state.memory, ...changes } })
const withExtensions = (state: State, changes: Partial<State['extensions']>): State => ({ ...state, extensions: { ...state.extensions, ...changes } })

/** @param {{ profile: object }} memory */
export const isProfileEmpty = (memory: { profile: object }) => Object.keys(memory.profile).length === 0

export const PERSONAL_ACTIONS= {
  /** A reload keeps the hits of a search that is still typed. */
  memory_loaded: (state, { data }) => withMemory(state, {
    loaded: true,
    loadError: null,
    fileMode: data.fileMode ?? false,
    profile: data.profile,
    items: state.memory.query.trim() ? state.memory.items : data.items,
    total: data.total,
    cleanupPending: data.cleanupPending ?? 0,
    invalid: data.invalid ?? 0,
    summaries: data.summaries ?? null,
    onboarding: data.onboarding,
    habits: data.habits,
    busy: false,
  }),
  memory_load_failed: (state, { message }) => withMemory(state, { loadError: message }),
  memory_open: (state, { view = 'profile' }) => withMemory(
    { ...state, island: false, picker: false, history: { ...state.history, open: false } },
    { open: true, view, summaries: null, editing: null, editingMemory: null, error: null, loadError: null, query: '',
      files: { ...initialMemoryFiles, writing: state.memory.files.writing }, docs: view === 'intro' ? [] : state.memory.docs },
  ),
  memory_close: (state) => withMemory(state, {
    open: false, summaries: null, editing: null, editingMemory: null, invalidOpen: false, invalidLoaded: false, invalidItems: [], conflictEditor: null,
    changesOpen: false, changesLoaded: false, changes: [], error: null, loadError: null, busy: false,
    files: { ...initialMemoryFiles, writing: state.memory.files.writing },
  }),
  memory_edit: (state, { key }) => withMemory(state, { editing: key, error: null }),
  memory_edit_entry: (state, { target }) => withMemory(state, { editingMemory: target, error: null }),
  memory_busy: (state) => withMemory(state, { busy: true, error: null }),
  memory_failed: (state, { message }) => withMemory(state, { busy: false, error: message }),
  memory_profile_saved: (state, { profile }) => withMemory(state, { profile, summaries: null, editing: null, busy: false, error: null }),
  memory_summaries_stale: (state) => state.memory.summaries ? withMemory(state, { summaries: null }) : state,
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
    total: Math.max(0, state.memory.total - Number(state.memory.items.some(item => item.id === id))),
    invalidItems: state.memory.invalidItems.filter(item => item.id !== id),
    changes: [], summaries: null,
    editingMemory: state.memory.editingMemory?.id === id ? null : state.memory.editingMemory,
  }),
  memory_invalid_opened: (state) => withMemory(state, { invalidOpen: true, invalidLoaded: false, invalidItems: [], error: null }),
  memory_invalid_listed: (state, { items }) => state.memory.invalidOpen ? withMemory(state, { invalidLoaded: true, invalidItems: items, invalid: items.length }) : state,
  memory_invalid_closed: (state) => withMemory(state, { invalidOpen: false, invalidLoaded: false, invalidItems: [], conflictEditor: null }),
  memory_conflict_edit: (state, { key }) => withMemory(state, { conflictEditor: key, error: null }),
  memory_change_busy: (state, { busy }) => withMemory(state, busy ? { changeBusy: true, error: null } : { changeBusy: false }),
  memory_index_rebuild: (state, { busy }) => withMemory(state, { rebuildingIndexes: busy }),
  memory_changes_opened: (state) => withMemory(state, { changesOpen: true, changesLoaded: false, changes: [], error: null }),
  memory_changes_listed: (state, { changes }) => state.memory.changesOpen ? withMemory(state, { changesLoaded: true, changes }) : state,
  memory_changes_closed: (state) => withMemory(state, { changesOpen: false, changesLoaded: false, changes: [] }),
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
  extensions_busy: (state) => withExtensions(state, { busy: true, error: null, notice: null, importNote: null }),
  extensions_failed: (state, { message }) => withExtensions(state, { busy: false, error: message }),
  extensions_saved: (state, { view, notice, importNote = null }) => withExtensions(state, {
    ...view, loaded: true, busy: false, error: null, notice, importNote, editing: null, importMenu: false,
  }),
  extensions_import_menu: (state, { open }) => withExtensions(state, { importMenu: open ?? !state.extensions.importMenu }),
  /** server: the one to edit, or null to close the form. */
  extensions_edit: (state, { server }) => withExtensions(state, { editing: server ? draftOf(server) : null, error: null, notice: null, importMenu: false }),
  extensions_edit_type: (state, { kind }) => (state.extensions.editing
    ? withExtensions(state, { editing: { ...state.extensions.editing, type: kind } })
    : state),
  extensions_edit_key_add: (state) => {
    const editing = state.extensions.editing
    if (!editing) return state
    return withExtensions(state, { editing: { ...editing, keys: [...editing.keys, { id: editing.nextId, name: '', saved: false }], nextId: editing.nextId + 1 } })
  },
  extensions_edit_key_remove: (state, { id }) => {
    const editing = state.extensions.editing
    return editing ? withExtensions(state, { editing: { ...editing, keys: editing.keys.filter((key: KeyRow) => key.id !== id) } }) : state
  },
} satisfies ActionHandlers
