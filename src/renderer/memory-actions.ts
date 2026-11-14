import { t } from '../shared/i18n/translate.ts'
import type { MemoryChangeRecord } from '../shared/ipc-results.ts'
const SEARCH_DEBOUNCE_MS = 200
const NOTICE_TOAST_MS = 6000
/** The profile fields the intro asks for: all three. Sites and documents are only read, not kept. */
export const INTRO_FIELDS = Object.freeze(['role', 'projects', 'preferences'])

const lines = (text: unknown) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean)

/** What the intro form gives: the profile fields, and the sites (one a line) to read. */
type IntroValues = Readonly<Record<string, string | undefined>>
/** A memory as the 关于你 page lists it. */
type MemoryItem = { id: number, revision: number }
type ConflictResolution = Parameters<AgentApi['resolveMemoryConflictPair']>[2]
type ConflictInterval = Parameters<AgentApi['resolveMemoryConflictPair']>[5]

/**
 * What the agent is asked after the intro when the user gave sites or documents: read them and fill in
 * the profile with the memory tools. Shown in the thread like any question, so nothing happens unseen.
 */
export function introPrompt({ sources, docs }: { sources: readonly string[], docs: ReadonlyArray<{ path: string }> }) {
  return [
    t("memory-actions.get.to.know.me.first.read.the"),
    t("memory-actions.save.each.fact.using.memory.remember.kind"),
    ...[...sources, ...docs.map((doc) => doc.path)].map((item) => `- ${item}`),
  ].join('\n')
}

/** The intro form's values as profile changes: only filled fields, so skipping one never clears it. */
export function introChanges(values: IntroValues) {
  return Object.fromEntries(INTRO_FIELDS.map((key) => [key, String(values[key] ?? '').trim()]).filter(([, value]) => value))
}

/** "已记住：周报每周五交给张三" / "已记住 3 条" / "已补充画像：在推进的事". */
export function memoryNotice({ memories = [], invalidated = [] }: { memories?: readonly string[], invalidated?: readonly string[] }) {
  const remembered = memories.length === 1 ? t("memory-actions.remembered", { value1: memories[0] }) : memories.length > 1 ? t("memory-actions.remembered.new.facts", { length: memories.length }) : ''
  const replaced = invalidated.length === 1 ? t("memory-actions.is.no.longer.used", { value1: invalidated[0] }) : invalidated.length > 1 ? t("memory-actions.old.memories.are.no.longer.used", { length: invalidated.length }) : ''
  return [remembered, replaced].filter(Boolean).join('；')
}

/** The "关于你" page and the intro. */
export function createMemoryActions({ api, getState, dispatch, errorMessage, showToast, ask }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage' | 'showToast' | 'ask'>) {
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let changesRequest = 0
  let invalidRequest = 0
  const fail = (err: unknown) => dispatch({ type: 'memory_failed', message: errorMessage(err) })

  async function loadMemory() {
    try {
      dispatch({ type: 'memory_loaded', data: await api.getMemory() })
    } catch (err) {
      fail(err)
    }
  }

  async function runSearch(query: string) {
    try {
      dispatch({ type: 'memory_listed', query, ...await api.listMemories(query.trim()) })
    } catch (err) {
      fail(err)
    }
  }

  async function loadChanges() {
    const request = ++changesRequest
    try {
      const changes = await api.listMemoryChanges()
      if (request === changesRequest && getState().memory.changesOpen) dispatch({ type: 'memory_changes_listed', changes })
    } catch (err) {
      if (request === changesRequest && getState().memory.changesOpen) fail(err)
    }
  }

  async function loadInvalid() {
    const request = ++invalidRequest
    try {
      const items = await api.listInvalidMemories()
      if (request === invalidRequest && getState().memory.invalidOpen) dispatch({ type: 'memory_invalid_listed', items })
    } catch (err) {
      if (request === invalidRequest && getState().memory.invalidOpen) fail(err)
    }
  }

  async function refreshMemoryViews() {
    await loadMemory()
    const current = getState().memory
    await Promise.all([
      current.open && current.query.trim() ? runSearch(current.query) : null,
      current.invalidOpen ? loadInvalid() : null,
      current.changesOpen ? loadChanges() : null,
    ])
  }

  async function reviseFromHistory(write: (operation: string) => Promise<boolean>) {
    if (getState().memory.changeBusy) return false
    dispatch({ type: 'memory_change_busy', busy: true })
    try {
      if (!await write(globalThis.crypto.randomUUID())) throw new Error(t('main.memory.revision.conflict'))
      await refreshMemoryViews()
      return true
    } catch (err) {
      await refreshMemoryViews()
      fail(err)
      return false
    } finally {
      dispatch({ type: 'memory_change_busy', busy: false })
    }
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
    loadMemory,
    openProfile(view = 'profile') {
      dispatch({ type: 'memory_open', view })
      loadMemory()
    },
    closeProfile() {
      invalidRequest++
      changesRequest++
      dispatch({ type: 'memory_close' })
    },
    editField: (key: string | null) => dispatch({ type: 'memory_edit', key }),
    editMemoryEntry: (target: MemoryItem | null) => dispatch({ type: 'memory_edit_entry', target }),
    editMemoryConflict: (key: string | null) => dispatch({ type: 'memory_conflict_edit', key }),

    async toggleMemoryChanges() {
      if (getState().memory.changesOpen) {
        changesRequest++
        dispatch({ type: 'memory_changes_closed' })
        return
      }
      dispatch({ type: 'memory_changes_opened' })
      await loadChanges()
    },

    async saveField(key: string, value: string) {
      dispatch({ type: 'memory_busy' })
      try {
        dispatch({ type: 'memory_profile_saved', profile: await api.saveProfile({ [key]: value }, globalThis.crypto.randomUUID()) })
      } catch (err) {
        fail(err)
      }
    },

    searchMemories(query: string) {
      dispatch({ type: 'memory_query', query })
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS)
    },

    /** Whether it was saved, so the field can be cleared. */
    async addMemory(text: string): Promise<boolean> {
      if (!text.trim()) return false
      dispatch({ type: 'memory_busy' })
      try {
        dispatch({ type: 'memory_added', memory: await api.addMemory(text.trim(), 'fact', globalThis.crypto.randomUUID()) })
        return true
      } catch (err) {
        fail(err)
        return false
      }
    },

    async editMemory(memory: MemoryItem, text: string) {
      try {
        await api.updateMemory(memory.id, text, memory.revision, globalThis.crypto.randomUUID())
        if (getState().memory.editingMemory?.id === memory.id) dispatch({ type: 'memory_edit_entry', target: null })
        await runSearch(getState().memory.query)
        return true
      } catch (err) {
        fail(err)
        return false
      }
    },

    async forgetMemory(memory: MemoryItem) {
      try {
        await api.forgetMemory(memory.id, memory.revision, globalThis.crypto.randomUUID())
        await runSearch(getState().memory.query)
      } catch (err) {
        fail(err)
      }
    },

    async deleteMemory(memory: MemoryItem) {
      try {
        if (await api.deleteMemory(memory.id, memory.revision, globalThis.crypto.randomUUID())) {
          dispatch({ type: 'memory_removed', id: memory.id })
          await runSearch(getState().memory.query)
          showToast(t("memory-actions.memory.deleted"))
        }
      } catch (err) {
        fail(err)
      }
    },

    /** Opens or closes the list of memories that no longer count. */
    async toggleInvalid() {
      if (getState().memory.invalidOpen) {
        invalidRequest++
        dispatch({ type: 'memory_invalid_closed' })
        return
      }
      dispatch({ type: 'memory_invalid_opened' })
      await loadInvalid()
    },

    async reviveMemory(memory: MemoryItem) {
      try {
        dispatch({ type: 'memory_revived', memory: await api.restoreMemory(memory.id, memory.revision, globalThis.crypto.randomUUID()) })
      } catch (err) {
        fail(err)
      }
    },

    resolveMemoryConflictPair(first: MemoryItem, second: MemoryItem, resolution: ConflictResolution, conflictId: number, interval: ConflictInterval) {
      return reviseFromHistory(async operation => {
        const resolved = await api.resolveMemoryConflictPair(
          { id: first.id, revision: first.revision }, { id: second.id, revision: second.revision }, resolution, operation, conflictId, interval,
        )
        if (resolved) dispatch({ type: 'memory_conflict_edit', key: null })
        return resolved
      })
    },

    async undoMemoryChange(change: MemoryChangeRecord) {
      if (await reviseFromHistory(async operation => {
        const result = await api.undoMemoryChange(change.id, change.revision, operation, change.expectedRevisions)
        if (result.status === 'applied') return true
        if (!result.current.length) return false
        throw new Error(t('memory-actions.memory.change.conflict', { ids: result.current.map(({ id }) => `#${id}`).join(', ') }))
      })) {
        showToast(t('memory-actions.memory.change.undone'))
      }
    },

    async rebuildMemoryIndexes() {
      if (getState().memory.rebuildingIndexes) return
      dispatch({ type: 'memory_index_rebuild', busy: true })
      try {
        const result = await api.rebuildMemoryIndexes()
        const message = result.fullText && result.semantic ? t('memory-actions.index.rebuild.started')
          : result.fullText ? t('memory-actions.index.rebuild.full-text-only')
            : result.semantic ? t('memory-actions.index.rebuild.semantic-only') : t('memory-actions.index.rebuild.failed')
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

    /** The agent saved something during the last turn: say so, and keep an open page current. */
    onMemoryChanged(event: { memories?: readonly string[], invalidated?: readonly string[], failure?: string }) {
      if (event.failure) showToast(event.failure)
      const text = memoryNotice(event)
      if (text) showToast(text, { action: { label: t("app.view"), kind: 'open-profile' }, ms: NOTICE_TOAST_MS })
      void refreshMemoryViews()
    },
  }
}
