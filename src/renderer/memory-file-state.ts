import type { MemoryFileSummary, MemoryManagedFileIdentity, MemoryFileListResult } from '../memory/contracts/file-management.ts'
import type { MemoryFileDetailView } from '../shared/ipc-results.ts'
import type { ActionHandlers, MemoryFileEditor, MemoryFileSelection, MemoryFileForget } from './action-types.ts'

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
  editor: MemoryFileEditor | null
  writing: boolean
  writeError: string | null
  forget: MemoryFileForget | null
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
  editor: null,
  writing: false,
  writeError: null,
  forget: null,
})

export const sameMemoryFile = (a: MemoryManagedFileIdentity, b: MemoryManagedFileIdentity): boolean =>
  a.kind === b.kind && a.workspace === b.workspace && a.id === b.id

export const sameMemoryFileSelection = (a: MemoryFileSelection | null, b: MemoryFileSelection): boolean =>
  Boolean(a && a.restrictionId === b.restrictionId && sameMemoryFile(a.identity, b.identity))

export function canEditMemoryFile(detail: MemoryFileDetailView | null): detail is MemoryFileDetailView & { editor: NonNullable<MemoryFileDetailView['editor']> } {
  return Boolean(detail?.actions.edit && detail.editor && !detail.stoppedSnapshot)
}
export const canForgetMemoryFile = (detail: MemoryFileDetailView | null): detail is MemoryFileDetailView =>
  Boolean(detail?.actions.forget && (!detail.stoppedSnapshot || detail.identity.kind === 'daily'
    && detail.restrictions?.some(item => item.id === detail.stoppedSnapshot?.restrictionId)))

export const memoryFilePageOpen = (memory: State['memory']): boolean => memory.open && memory.view === 'profile' && memory.fileMode

const withFiles = (state: State, patch: Partial<MemoryFileState>): State => memoryFilePageOpen(state.memory)
  ? { ...state, memory: { ...state.memory, files: { ...state.memory.files, ...patch } } }
  : state

export const MEMORY_FILE_ACTIONS = {
  memory_files_query: (state, { query }) => withFiles(state, { query, items: [], nextCursor: null, loaded: false, loading: true, listError: null }),
  memory_files_invalidated: (state) => withFiles(state, {
    items: [], nextCursor: null, loaded: false, loading: true, listError: null, detail: null, detailError: null,
    forget: state.memory.files.forget?.phase === 'confirm' ? null : state.memory.files.forget,
  }),
  memory_files_loading: (state) => withFiles(state, { loading: true, listError: null }),
  memory_files_listed: (state, { query, page, more }) => query === state.memory.files.query ? withFiles(state, {
    items: more ? [...state.memory.files.items, ...page.items] : page.items,
    nextCursor: page.nextCursor, loaded: true, loading: false, listError: null,
  }) : state,
  memory_files_list_failed: (state, { message }) => withFiles(state, { loading: false, listError: message }),
  memory_file_select: (state, { selection }) => withFiles(state, { selection, detail: null, detailError: null, editor: null, writeError: null,
    forget: state.memory.files.forget?.phase === 'confirm' ? null : state.memory.files.forget }),
  memory_file_loading: (state) => withFiles(state, { detail: null, detailError: null,
    forget: state.memory.files.forget?.phase === 'confirm' ? null : state.memory.files.forget }),
  memory_file_read: (state, { selection, detail }) => sameMemoryFileSelection(state.memory.files.selection, selection)
    ? withFiles(state, { detail, detailError: null }) : state,
  memory_file_read_failed: (state, { selection, message }) => sameMemoryFileSelection(state.memory.files.selection, selection)
    ? withFiles(state, { detail: null, detailError: message }) : state,
  memory_file_editor: (state, { editor }) => withFiles(state, { editor }),
  memory_file_write_busy: (state, { busy }) => ({ ...state, memory: { ...state.memory, files: {
    ...state.memory.files, writing: busy, ...(busy ? { writeError: null } : {}),
  } } }),
  memory_file_write_failed: (state, { message }) => withFiles(state, { writeError: message }),
  memory_file_forget: (state, { forget }) => withFiles(state, { forget }),
  memory_file_forget_started: (state, { id }) => {
    const { forget, selection } = state.memory.files
    if (forget?.id !== id) return state
    const selected = selection && sameMemoryFile(selection.identity, forget.request.identity)
    return withFiles(state, { forget: { ...forget, title: undefined, phase: 'unconfirmed', error: undefined },
      ...(selected ? { selection: null, detail: null, detailError: null, editor: null } : {}),
      // Shared evidence can retire other titles too; discard the pre-erasure list until it is read again.
      loading: false, loaded: false, nextCursor: null, items: [] })
  },
  memory_file_forgotten: (state, { id, cleanup }) => {
    const { forget, selection } = state.memory.files
    if (forget?.id !== id) return state
    return withFiles(state, { forget: { ...forget, title: undefined, error: undefined, phase: cleanup },
      ...(selection && sameMemoryFile(selection.identity, forget.request.identity)
        ? { selection: null, detail: null, detailError: null, editor: null } : {}),
      items: state.memory.files.items.filter(item => !sameMemoryFile(item.identity, forget.request.identity)) })
  },
} satisfies ActionHandlers
