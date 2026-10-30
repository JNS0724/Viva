import { t } from '../shared/i18n/translate.ts'
const SEARCH_DEBOUNCE_MS = 200
const UNDO_TOAST_MS = 8000
const NOTICE_TOAST_MS = 6000
/** The profile fields the intro asks for: all three. Sites and documents are only read, not kept. */
export const INTRO_FIELDS = Object.freeze(['role', 'projects', 'preferences'])

const lines = (text: unknown) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean)

/** What the intro form gives: the profile fields, and the sites (one a line) to read. */
type IntroValues = Readonly<Record<string, string | undefined>>
/** A memory as the 关于你 page lists it. */
type MemoryItem = { id: number, [field: string]: any }

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

  async function saveIntro(values: IntroValues, analyze: boolean) {
    const { docs } = getState().memory
    const changes = introChanges(values)
    const profile = await api.saveProfile(changes)
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
    closeProfile: () => dispatch({ type: 'memory_close' }),
    editField: (key: string | null) => dispatch({ type: 'memory_edit', key }),

    async saveField(key: string, value: string) {
      dispatch({ type: 'memory_busy' })
      try {
        dispatch({ type: 'memory_profile_saved', profile: await api.saveProfile({ [key]: value }) })
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
        dispatch({ type: 'memory_added', memory: await api.addMemory(text.trim(), 'fact') })
        return true
      } catch (err) {
        fail(err)
        return false
      }
    },

    async deleteMemory(memory: MemoryItem) {
      try {
        const removed = await api.deleteMemory(memory.id)
        dispatch({ type: 'memory_removed', id: memory.id })
        if (removed) showToast(t("memory-actions.memory.deleted"), { action: { label: t("memory-actions.undo"), kind: 'undo-memory', payload: removed }, ms: UNDO_TOAST_MS })
      } catch (err) {
        fail(err)
      }
    },

    async undoMemoryDelete(memory: MemoryItem) {
      try {
        await api.restoreMemory(memory)
        await runSearch(getState().memory.query)
      } catch (err) {
        showToast(t("memory-actions.could.not.undo", { value1: errorMessage(err) }))
      }
    },

    /** Opens or closes the list of memories that no longer count. */
    async toggleInvalid() {
      if (getState().memory.invalidOpen) {
        dispatch({ type: 'memory_invalid_closed' })
        return
      }
      try {
        dispatch({ type: 'memory_invalid_listed', items: await api.listInvalidMemories() })
      } catch (err) {
        fail(err)
      }
    },

    async reviveMemory(memory: MemoryItem) {
      try {
        dispatch({ type: 'memory_revived', memory: await api.reviveMemory(memory.id) })
      } catch (err) {
        fail(err)
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
    onMemoryChanged(event: { memories?: readonly string[], invalidated?: readonly string[] }) {
      const text = memoryNotice(event)
      if (text) showToast(text, { action: { label: t("app.view"), kind: 'open-profile' }, ms: NOTICE_TOAST_MS })
      loadMemory()
    },
  }
}
