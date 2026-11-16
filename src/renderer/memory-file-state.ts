import type { MemoryFileSummary, MemoryManagedFileIdentity, MemoryFileListResult } from '../memory/contracts/file-management.ts'
import type { MemoryFileDetailView } from '../shared/ipc-results.ts'
import type { ActionHandlers, MemoryFileSelection } from './action-types.ts'

export interface MemoryFileState {
  query: string
  items: readonly MemoryFileSummary[]
  nextCursor: MemoryFileListResult['nextCursor']
  loaded: boolean
  loading: boolean
  listError: string | null
  selection: MemoryFileSelection | null
  detail: MemoryFileDetailView | null
  detailError: string | null
  writing: boolean
  writeError: string | null
}

export const initialMemoryFiles = Object.freeze<MemoryFileState>({
  query: '',
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  listError: null,
  selection: null,
  detail: null,
  detailError: null,
  writing: false,
  writeError: null,
})

export const sameMemoryFile = (a: MemoryManagedFileIdentity, b: MemoryManagedFileIdentity): boolean =>
  a.kind === b.kind && a.workspace === b.workspace && a.id === b.id

export const sameMemoryFileSelection = (a: MemoryFileSelection | null, b: MemoryFileSelection): boolean =>
  Boolean(a && a.restrictionId === b.restrictionId && sameMemoryFile(a.identity, b.identity))

export const memoryFilePageOpen = (memory: State['memory']): boolean => memory.open && memory.view === 'profile'

const withFiles = (state: State, patch: Partial<MemoryFileState>): State => memoryFilePageOpen(state.memory)
  ? { ...state, memory: { ...state.memory, files: { ...state.memory.files, ...patch } } }
  : state

export const MEMORY_FILE_ACTIONS = {
  memory_files_query: (state, { query }) => withFiles(state, { query, items: [], nextCursor: null, loaded: false, loading: true, listError: null }),
  memory_files_invalidated: (state) => withFiles(state, {
    items: [], nextCursor: null, loaded: false, loading: true, listError: null, detail: null, detailError: null,
  }),
  memory_files_loading: (state) => withFiles(state, { loading: true, listError: null }),
  memory_files_listed: (state, { query, page, more }) => query === state.memory.files.query ? withFiles(state, {
    items: more ? [...state.memory.files.items, ...page.items] : page.items,
    nextCursor: page.nextCursor, loaded: true, loading: false, listError: null,
  }) : state,
  memory_files_list_failed: (state, { message }) => withFiles(state, { loading: false, listError: message }),
  memory_file_select: (state, { selection }) => withFiles(state, { selection, detail: null, detailError: null, writeError: null }),
  memory_file_loading: (state) => withFiles(state, { detail: null, detailError: null }),
  memory_file_read: (state, { selection, detail }) => sameMemoryFileSelection(state.memory.files.selection, selection)
    ? withFiles(state, { detail, detailError: null }) : state,
  memory_file_read_failed: (state, { selection, message }) => sameMemoryFileSelection(state.memory.files.selection, selection)
    ? withFiles(state, { detail: null, detailError: message }) : state,
  memory_file_write_busy: (state, { busy }) => ({ ...state, memory: { ...state.memory, files: {
    ...state.memory.files, writing: busy, ...(busy ? { writeError: null } : {}),
  } } }),
  memory_file_write_failed: (state, { message }) => withFiles(state, { writeError: message }),
} satisfies ActionHandlers
