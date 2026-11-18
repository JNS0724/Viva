import type { MemoryManagedFileVersion, MemoryFileListResult } from '../memory/contracts/file-management.ts'
import type { MemoryFileDetailView } from '../shared/ipc-results.ts'
import { MAX_MESSAGE_CHARS } from '../shared/text-limits.ts'
import { t } from '../shared/i18n/translate.ts'
import { canEditMemoryFile, canForgetMemoryFile, memoryFilePageOpen, sameMemoryFile, sameMemoryFileSelection } from './memory-file-state.ts'
import type { MemoryFileDraft, MemoryFileEditor, MemoryFileSelection } from './action-types.ts'

const SEARCH_DEBOUNCE_MS = 200

export function createMemoryFileActions({ api, getState, dispatch, showToast, errorMessage }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'showToast' | 'errorMessage'>) {
  let listRequest = 0, detailRequest = 0, editorId = 0, forgetId = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const state = () => getState().memory.files
  const active = () => memoryFilePageOpen(getState().memory)

  const setEditor = (editor: MemoryFileEditor | null) => dispatch({ type: 'memory_file_editor', editor })
  const editorCurrent = (id: number) => active() && state().editor?.id === id

  function openEdit(target: MemoryFileDetailView & { editor: MemoryFileDraft }) {
    setEditor({ id: ++editorId, kind: 'edit', identity: target.identity, version: target.version,
      originalTitle: target.editor.title, draft: target.editor })
  }

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

  async function saveMemoryFileEditor(id: number, draft: MemoryFileDraft) {
    const { editor, writing } = state()
    if (!active() || !editor || editor.id !== id || writing || editor.conflict) return false
    const { text } = draft
    // An untouched title may contain the owner's masking spaces. Preserve it by omitting the field.
    const title = editor.kind === 'edit' ? draft.title === editor.originalTitle ? undefined : draft.title.trim()
      : draft.title.trim() || undefined
    if (!text.trim() || text.length > MAX_MESSAGE_CHARS || (title?.length ?? 0) > 200) {
      setEditor({ ...editor, draft, error: t('main.memory.invalid.text') })
      return false
    }
    const input = { text, ...(title === undefined ? {} : { title }) }
    const retry = editor.retry
    const operationId = retry && retry.title === input.title && retry.text === input.text ? retry.operationId : globalThis.crypto.randomUUID()
    const command = { operationId, ...input }
    const pending = { ...editor, draft, retry: command, error: undefined }
    setEditor(pending)
    dispatch({ type: 'memory_file_write_busy', busy: true })
    let refresh = false
    try {
      const result = editor.kind === 'edit'
        ? await api.editMemoryFile({ ...command, identity: editor.identity, version: editor.version })
        : await api.createMemoryFile(command)
      if (result.status === 'rejected') {
        const conflict = result.code === 'revision.conflict' && editor.kind === 'edit'
        if (editorCurrent(id)) setEditor({ ...pending, retry: result.code === 'change.pending' ? command : undefined, conflict,
          error: t(conflict ? 'memory-files.editor.conflict' : `main.memory.${result.code}`) })
        refresh = conflict
        return false
      }
      const { receipt } = result
      if (receipt.operationId !== operationId || receipt.action !== (editor.kind === 'create' ? 'CREATE' : 'EDIT')
        || receipt.identity.kind !== 'digest' || editor.kind === 'edit' && !sameMemoryFile(receipt.identity, editor.identity)) {
        throw new Error('Unexpected memory write receipt')
      }
      if (editorCurrent(id)) {
        dispatch({ type: 'memory_file_select', selection: { identity: receipt.identity } })
        showToast(t(editor.kind === 'create' ? 'memory-files.editor.created' : 'memory-files.editor.saved'))
      }
      refresh = true
      return true
    } catch {
      // The owner may have committed before the reply was lost. Keep the key for identical retry payloads.
      if (editorCurrent(id)) setEditor({ ...pending, error: t('memory-files.editor.unconfirmed') })
      return false
    } finally {
      const refreshed = refresh ? refreshFiles() : undefined
      dispatch({ type: 'memory_file_write_busy', busy: false })
      await refreshed
    }
  }

  async function confirmManagedMemoryForget(id: number) {
    const { forget, writing, detail, selection } = state()
    if (!active() || !forget || forget.id !== id || writing
      || !['confirm', 'unconfirmed', 'pending'].includes(forget.phase)) return false
    const { request } = forget
    if (forget.phase === 'confirm') {
      if (!canForgetMemoryFile(detail) || !selection || selection.restrictionId || !sameMemoryFile(detail.identity, request.identity)
        || detail.version.contentRevision !== request.version.contentRevision || detail.version.usageVersion !== request.version.usageVersion
        || detail.version.policyToken !== request.version.policyToken) return false
    }
    cancelReads()
    dispatch({ type: 'memory_summaries_stale' })
    dispatch({ type: 'memory_file_forget_started', id })
    dispatch({ type: 'memory_file_write_busy', busy: true })
    const current = () => active() && state().forget?.id === id
    let refresh = false
    try {
      const result = await api.forgetMemoryFile(request)
      if (result.status === 'rejected') {
        if (current()) dispatch({ type: 'memory_file_forget', forget: { id, request,
          phase: result.code === 'change.pending' ? 'unconfirmed' : 'conflict',
          error: t(result.code === 'revision.conflict' ? 'memory-files.forget.conflict' : `main.memory.${result.code}`) } })
        refresh = result.code !== 'change.pending'
        return false
      }
      const { receipt, cleanup } = result
      if (receipt.operationId !== request.operationId || receipt.action !== 'FORGET'
        || !sameMemoryFile(receipt.identity, request.identity) || receipt.restrictionId !== undefined) {
        throw new Error('Unexpected memory file deletion receipt')
      }
      if (current()) dispatch({ type: 'memory_file_forgotten', id, cleanup })
      refresh = true
      return true
    } catch {
      // Retry only this approved request. A lost response may follow a committed erasure.
      if (current()) dispatch({ type: 'memory_file_forget', forget: { id, request, phase: 'unconfirmed',
        error: t('memory-files.forget.unconfirmed') } })
      return false
    } finally {
      dispatch({ type: 'memory_file_write_busy', busy: false })
      if (refresh) await refreshFiles()
    }
  }

  return {
    cancelReads,
    confirmManagedMemoryForget,
    askManagedMemoryForget(target: MemoryFileDetailView) {
      const { detail, selection, writing, editor, forget } = state()
      if (!active() || writing || editor || forget?.phase === 'unconfirmed' || detail !== target || !selection
        || !canForgetMemoryFile(target) || selection.restrictionId) return
      dispatch({ type: 'memory_file_forget', forget: { id: ++forgetId, phase: 'confirm', title: target.title,
        request: { operationId: globalThis.crypto.randomUUID(), identity: target.identity, version: target.version } } })
    },
    cancelManagedMemoryForget(id: number) {
      if (active() && !state().writing && state().forget?.id === id && state().forget?.phase === 'confirm') {
        dispatch({ type: 'memory_file_forget', forget: null })
      }
    },
    saveMemoryFileEditor,
    startMemoryFileEditor(target?: MemoryFileDetailView) {
      const { selection, detail, editor, writing } = state()
      if (!active() || writing || editor) return
      if (target) {
        if (detail !== target || !canEditMemoryFile(target)) return
        openEdit(target)
      } else if (!selection) {
        setEditor({ id: ++editorId, kind: 'create', draft: { title: '', text: '' } })
      }
    },
    cancelMemoryFileEditor(id: number) {
      if (editorCurrent(id)) setEditor(null)
    },
    acceptMemoryFileEditVersion(id: number, target: MemoryFileDetailView) {
      const { editor, detail, writing } = state()
      if (!editorCurrent(id) || editor?.kind !== 'edit' || !editor.conflict || writing || detail !== target
        || !canEditMemoryFile(target) || !sameMemoryFile(target.identity, editor.identity)) return
      // The old draft may quote evidence the owner has since withdrawn.
      openEdit(target)
    },
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
