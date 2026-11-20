import { t } from '../shared/i18n/translate.ts'
import { createMemoryFileActions, createMemoryPageReads } from './memory-file-actions.ts'
import { memoryFilePageOpen } from './memory-file-state.ts'
import { createRequestBudget, MEMORY_READ_BUDGET_MS, RequestTimeout } from '../shared/request-budget.ts'
const NOTICE_TOAST_MS = 6000
/** The profile fields the intro asks for: all three. Sites and documents are only read, not kept. */
export const INTRO_FIELDS = Object.freeze(['role', 'projects', 'preferences'])

const lines = (text: unknown) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean)

/** What the intro form gives: the profile fields, and the sites (one a line) to read. */
type IntroValues = Readonly<Record<string, string | undefined>>
/**
 * What the agent is asked after the intro when the user gave sites or documents: read them and summarize
 * what it finds. Shown in the thread like any question, so nothing happens unseen.
 */
export function introPrompt({ sources, docs }: { sources: readonly string[], docs: ReadonlyArray<{ path: string }> }) {
  return [
    t("memory-actions.get.to.know.me.first.read.the"),
    t("memory-actions.intro.summarize"),
    ...[...sources, ...docs.map((doc) => doc.path)].map((item) => `- ${item}`),
  ].join('\n')
}

/** The intro form's values as profile changes: only filled fields, so skipping one never clears it. */
export function introChanges(values: IntroValues) {
  return Object.fromEntries(INTRO_FIELDS.map((key) => [key, String(values[key] ?? '').trim()]).filter(([, value]) => value))
}

/** The "关于你" page and the intro. */
export function createMemoryActions({ api, getState, dispatch, errorMessage, showToast, ask, readBudgetMs = MEMORY_READ_BUDGET_MS }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage' | 'showToast' | 'ask'> & { readBudgetMs?: number }) {
  const readPage = createMemoryPageReads(readBudgetMs)
  const files = createMemoryFileActions({ api, getState, dispatch, showToast, errorMessage }, readPage)
  // Status reads use a separate, lightweight owner call. Closing the list invalidates late replies.
  let watchingDream = false, dreamRequest = 0
  let pendingDreamOperation: string | undefined
  let dreamTimer: ReturnType<typeof setTimeout> | undefined
  async function refreshDream(operation?: string) {
    clearTimeout(dreamTimer)
    const request = ++dreamRequest
    const pending = pendingDreamOperation
    try {
      const status = await (operation ? api.runDream(operation) : api.getDreamStatus(pending))
      // A joined request can have a different canonical job ID. The status
      // lookup is scoped to the captured operation and never schedules work.
      if (pending && pending === pendingDreamOperation && (operation === pending || status.jobId)) pendingDreamOperation = undefined
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
  const fail = (err: unknown) => dispatch({ type: 'memory_failed', message: errorMessage(err) })

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
    dispatch({ type: 'memory_summaries_stale' })
    files.invalidateFiles()
    await loadMemory()
  }

  async function saveIntro(values: IntroValues, analyze: boolean) {
    const { docs } = getState().memory
    const changes = introChanges(values)
    const profile = await api.saveProfile(changes, globalThis.crypto.randomUUID())
    dispatch({ type: 'memory_profile_saved', profile })
    dispatch({ type: 'memory_onboarding', status: await api.setOnboarding('done') })
    dispatch({ type: 'memory_close' })
    const sources = lines(values.sources)
    const wantsReading = analyze && (sources.length > 0 || docs.length > 0)
    if (wantsReading && ask(introPrompt({ sources, docs }))) return
    showToast(wantsReading ? t("memory-actions.saved.once.a.model.is.connected.ask") : t("memory-actions.saved.you.can.add.more.in.about"), {
      action: { label: t("app.view"), kind: 'open-profile' }, ms: NOTICE_TOAST_MS,
    })
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
      pendingDreamOperation ??= globalThis.crypto.randomUUID()
      await refreshDream(pendingDreamOperation)
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
    editField: (key: string | null) => dispatch({ type: 'memory_edit', key }),
    async saveField(key: string, value: string) {
      dispatch({ type: 'memory_busy' })
      try {
        dispatch({ type: 'memory_profile_saved', profile: await api.saveProfile({ [key]: value }, globalThis.crypto.randomUUID()) })
        await refreshMemoryViews()
      } catch (err) {
        fail(err)
      }
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

    async addDocs() {
      dispatch({ type: 'memory_busy' })
      try {
        dispatch({ type: 'memory_docs_added', docs: await api.addDocs() })
      } catch (err) {
        fail(err)
      }
    },

    async finishIntro(values: IntroValues, analyze: boolean) {
      if (getState().memory.busy) return
      dispatch({ type: 'memory_busy' })
      try {
        await saveIntro(values, analyze)
      } catch (err) {
        fail(err)
      }
    },

    async skipIntro() {
      try {
        dispatch({ type: 'memory_onboarding', status: await api.setOnboarding('skipped') })
        dispatch({ type: 'memory_close' })
      } catch (err) {
        fail(err)
      }
    },

    /** Keep the profile and file views aligned with committed owner changes. */
    onMemoryChanged(event: { failure?: string }) {
      if (event.failure) showToast(event.failure)
      void refreshMemoryViews()
    },
  }
}
