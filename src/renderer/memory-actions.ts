import { t } from '../shared/i18n/translate.ts'
import { createMemoryFileActions, createMemoryPageReads } from './memory-file-actions.ts'
import { memoryFilePageOpen } from './memory-file-state.ts'
import { createRequestBudget, MEMORY_READ_BUDGET_MS, RequestTimeout } from '../shared/request-budget.ts'

/** The "关于你" page (resident profile, Dream status, and managed memory files). */
export function createMemoryActions({ api, getState, dispatch, errorMessage, showToast, readBudgetMs = MEMORY_READ_BUDGET_MS }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage' | 'showToast'> & { ask?: ActionDeps['ask'], readBudgetMs?: number }) {
  const readPage = createMemoryPageReads(readBudgetMs)
  const files = createMemoryFileActions({ api, getState, dispatch, showToast, errorMessage }, readPage)
  // Status reads use a separate, lightweight owner call. Closing the list invalidates late replies.
  let watchingDream = false, dreamRequest = 0
  // Unacknowledged start ID for idempotent start retry; cleared once start is acknowledged or confirmed via jobId.
  let pendingDreamRequest: string | undefined
  // Scoped read-only polling ID kept until completion receipt (`completedAt != null`) or a new manual run.
  let watchingDreamOperation: string | undefined
  let dreamTimer: ReturnType<typeof setTimeout> | undefined
  async function refreshDream(operation?: string) {
    clearTimeout(dreamTimer)
    const request = ++dreamRequest
    const watched = operation ?? watchingDreamOperation
    try {
      const status = await (operation ? api.runDream(operation) : api.getDreamStatus(watched))
      if (pendingDreamRequest && pendingDreamRequest === watched && (operation === watched || status.jobId)) {
        pendingDreamRequest = undefined
      }
      if (watched && watched === watchingDreamOperation && (status.completedAt != null || status.state === 'disabled')) {
        watchingDreamOperation = undefined
      }
      if (request === dreamRequest && watchingDream) dispatch({ type: 'memory_dream_status', status })
    } catch {
      if (request === dreamRequest && watchingDream) {
        dispatch({ type: 'memory_dream_status', status: null })
        if (operation) showToast(t('dream.start.failed'))
      }
    } finally {
      if (operation) dispatch({ type: 'memory_dream_requesting', busy: false })
      if (request === dreamRequest && watchingDream) {
        const state = getState().memory.dream?.state
        dreamTimer = setTimeout(() => { void refreshDream() }, state === 'queued' || state === 'running' ? 1000 : 10000)
      }
    }
  }
  let memoryRequest = 0, profileGeneration = 0
  let active: { page: string, lifetime: ReturnType<typeof createRequestBudget>, promise: Promise<boolean> } | undefined

  function readProfile(): Promise<boolean> {
    const page = `${getState().memory.open}:${getState().memory.view}`
    if (active?.page === page && !active.lifetime.signal.aborted) return active.promise
    active?.lifetime.cancel(); active?.lifetime.close()
    const request = ++memoryRequest, generation = profileGeneration
    const lifetime = createRequestBudget(readBudgetMs)
    const promise = lifetime.run(() => readPage(() => request === memoryRequest && !lifetime.signal.aborted,
      () => api.getMemory({ budgetMs: lifetime.remainingMs() }))).then(data => {
      if (request !== memoryRequest || generation !== profileGeneration) return false
      dispatch({ type: 'memory_loaded', data })
      return true
    }, err => {
      if (request === memoryRequest && generation === profileGeneration) dispatch({ type: 'memory_load_failed', message: err instanceof RequestTimeout ? t('memory.read.timeout') : errorMessage(err) })
      return false
    }).finally(() => { lifetime.close(); if (request === memoryRequest) active = undefined })
      .then(loaded => request === memoryRequest && generation !== profileGeneration ? readProfile() : loaded)
    active = { page, lifetime, promise }
    return promise
  }

  function loadMemory(): Promise<boolean> {
    if (memoryFilePageOpen(getState().memory)) void files.refreshFiles()
    return readProfile()
  }

  async function refreshMemoryViews() {
    profileGeneration++
    files.invalidateFiles()
    await loadMemory()
  }

  return {
    ...files,
    watchDream(visible: boolean) {
      if (visible === watchingDream) return
      watchingDream = visible
      dreamRequest++
      clearTimeout(dreamTimer)
      if (visible) void refreshDream()
    },
    async runDream() {
      const { dream, requestingDream, dreamUnavailable } = getState().memory
      if (!watchingDream || requestingDream || dreamUnavailable || !dream || ['disabled', 'running', 'queued'].includes(dream.state)) return
      dispatch({ type: 'memory_dream_requesting', busy: true })
      pendingDreamRequest ??= globalThis.crypto.randomUUID()
      watchingDreamOperation = pendingDreamRequest
      await refreshDream(pendingDreamRequest)
    },
    loadMemory,
    openProfile(view = 'profile') {
      files.cancelReads()
      dispatch({ type: 'memory_open', view })
      loadMemory()
    },
    closeProfile() {
      files.cancelReads()
      memoryRequest++
      active?.lifetime.cancel(); active?.lifetime.close(); active = undefined
      dispatch({ type: 'memory_close' })
    },

    async rebuildMemoryIndexes() {
      if (getState().memory.rebuildingIndexes) return
      dispatch({ type: 'memory_index_rebuild', busy: true })
      try {
        const result = await api.rebuildMemoryIndexes()
        const message = t(result.files?.lexical ? 'memory-actions.index.rebuild.started' : 'memory-actions.index.rebuild.failed')
        showToast(message)
      } catch {
        showToast(t('memory-actions.index.rebuild.failed'))
      } finally {
        dispatch({ type: 'memory_index_rebuild', busy: false })
      }
    },

    /** Keep the profile and file views aligned with committed owner changes. */
    onMemoryChanged(event: { failure?: string }) {
      if (event.failure) showToast(event.failure)
      void refreshMemoryViews()
    },
  }
}
