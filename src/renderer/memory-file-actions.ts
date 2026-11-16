import type { MemoryManagedFileVersion, MemoryFileListResult } from '../memory/contracts/file-management.ts'
import type { MemoryFileDetailView } from '../shared/ipc-results.ts'
import { t } from '../shared/i18n/translate.ts'
import { memoryFilePageOpen, sameMemoryFile, sameMemoryFileSelection } from './memory-file-state.ts'
import type { MemoryFileSelection } from './action-types.ts'

const SEARCH_DEBOUNCE_MS = 200

export function createMemoryFileActions({ api, getState, dispatch, showToast, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'showToast' | 'errorMessage'>) {
  let listRequest = 0, detailRequest = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const state = () => getState().memory.files
  const active = () => memoryFilePageOpen(getState().memory)

  function cancelReads() {
    listRequest++
    detailRequest++
    clearTimeout(searchTimer)
  }

  async function list(cursor?: NonNullable<MemoryFileListResult['nextCursor']>) {
    if (!active()) return
    const request = ++listRequest
    const { query } = state()
    dispatch({ type: 'memory_files_loading' })
    const current = () => active() && request === listRequest && state().query === query
    try {
      const page = await api.listMemoryFiles({ query: query.trim(), ...(cursor ? { cursor } : {}) })
      if (!current()) return
      if (page.status === 'stale' && cursor) {
        dispatch({ type: 'memory_files_invalidated' })
        await refreshFiles()
        return
      }
      if (page.status !== 'ok') throw new Error(t('main.memory.revision.conflict'))
      dispatch({ type: 'memory_files_listed', query, page, more: Boolean(cursor) })
    } catch (error) {
      if (current()) dispatch({ type: 'memory_files_list_failed', message: errorMessage(error) })
    }
  }

  async function read(selection: MemoryFileSelection) {
    const request = ++detailRequest
    dispatch({ type: 'memory_file_loading' })
    const current = () => active() && request === detailRequest && sameMemoryFileSelection(state().selection, selection)
    try {
      const detail = await api.readMemoryFile(selection.identity, selection.restrictionId)
      if (!current()) return
      if (!detail || !sameMemoryFile(detail.identity, selection.identity)
        || detail.stoppedSnapshot?.restrictionId !== selection.restrictionId) throw new Error(t('main.memory.not.found'))
      dispatch({ type: 'memory_file_read', selection, detail })
    } catch (error) {
      if (current()) dispatch({ type: 'memory_file_read_failed', selection, message: errorMessage(error) })
    }
  }

  async function refreshFiles() {
    if (!active()) return
    const { selection } = state()
    await Promise.all([list(), selection ? read(selection) : undefined])
  }

  async function write(target: MemoryFileDetailView, command: (operationId: string) => Promise<unknown>, message: string, restoredRestriction?: string) {
    if (!active() || state().writing || state().detail !== target) return false
    const { selection } = state()
    dispatch({ type: 'memory_file_write_busy', busy: true })
    try {
      await command(globalThis.crypto.randomUUID())
      if (active() && restoredRestriction && selection && sameMemoryFileSelection(state().selection, selection)) {
        dispatch({ type: 'memory_file_select', selection: { identity: selection.identity } })
      }
      showToast(message)
      return true
    } catch (error) {
      if (active() && selection && sameMemoryFileSelection(state().selection, selection)) {
        dispatch({ type: 'memory_file_write_failed', message: errorMessage(error) })
      }
      return false
    } finally {
      await refreshFiles()
      dispatch({ type: 'memory_file_write_busy', busy: false })
    }
  }

  return {
    cancelReads,
    invalidateFiles() {
      cancelReads()
      if (active()) dispatch({ type: 'memory_files_invalidated' })
    },
    refreshFiles,
    reloadMemoryFileList: () => list(),
    loadMoreMemoryFiles() {
      const { nextCursor, loading } = state()
      if (!loading && nextCursor) return list(nextCursor)
    },
    searchMemoryFiles(query: string) {
      if (!active() || state().query === query) return
      listRequest++
      dispatch({ type: 'memory_files_query', query })
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => { if (state().query === query) void list() }, SEARCH_DEBOUNCE_MS)
    },
    showMemoryFile(selection: MemoryFileSelection | null) {
      if (!active()) return
      detailRequest++
      dispatch({ type: 'memory_file_select', selection })
      if (selection) return read(selection)
    },
    reloadMemoryFile() {
      const { selection } = state()
      if (active() && selection) return read(selection)
    },
    setManagedMemoryEnabled(target: MemoryFileDetailView, enabled: boolean, restrictionId?: string) {
      if (!target.actions.setEnabled || target.stoppedSnapshot && !restrictionId) return false
      let version: MemoryManagedFileVersion = target.version
      if (restrictionId) {
        const restriction = target.restrictions?.find(item => item.id === restrictionId)
        if (!enabled || !restriction || target.stoppedSnapshot?.restrictionId !== restrictionId) return false
        version = restriction.version
      } else if (target.identity.kind === 'daily' ? enabled || !target.actions.stop : target.hasProjection === false || target.enabled === enabled) {
        return false
      }
      return write(target, operationId => api.setMemoryFileEnabled({ operationId, identity: target.identity, version, enabled,
        ...(restrictionId ? { restrictionId } : {}) }), t(enabled ? 'memory-files.restored' : 'memory-actions.memory.stopped'), restrictionId)
    },
    undoManagedMemory(target: MemoryFileDetailView) {
      const changeId = target.actions.undo?.changeId
      if (!changeId || target.stoppedSnapshot) return false
      return write(target, operationId => api.undoMemoryFile({ operationId, identity: target.identity, version: target.version, changeId }),
        t('memory-actions.memory.change.undone'))
    },
  }
}
