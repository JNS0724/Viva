import { t } from '../shared/i18n/translate.ts'
import { createMemoryFileActions } from './memory-file-actions.ts'
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

export function memoryNotice(memories: readonly string[] = []) {
  if (memories.length === 1) return t('memory-actions.remembered', { value1: memories[0] })
  return memories.length > 1 ? t('memory-actions.remembered.new.items', { length: memories.length }) : ''
}

/** The "关于你" page and the intro. */
export function createMemoryActions({ api, getState, dispatch, errorMessage, showToast, ask }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage' | 'showToast' | 'ask'>) {
  const files = createMemoryFileActions({ api, getState, dispatch, showToast, errorMessage })
  let memoryRequest = 0
  const fail = (err: unknown) => dispatch({ type: 'memory_failed', message: errorMessage(err) })

  async function loadMemory() {
    const request = ++memoryRequest
    try {
      const data = await api.getMemory()
      if (request !== memoryRequest) return false
      dispatch({ type: 'memory_loaded', data })
      await files.refreshFiles()
      return request === memoryRequest
    } catch (err) {
      if (request === memoryRequest) dispatch({ type: 'memory_load_failed', message: errorMessage(err) })
      return false
    }
  }

  async function refreshMemoryViews() {
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
    loadMemory,
    openProfile(view = 'profile') {
      files.cancelReads()
      dispatch({ type: 'memory_open', view })
      loadMemory()
    },
    closeProfile() {
      files.cancelReads()
      memoryRequest++
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
        const message = t(result.files?.lexical ? 'memory-files.index.rebuilt' : 'memory-actions.index.rebuild.failed')
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
    onMemoryChanged(event: { memories?: readonly string[], failure?: string }) {
      if (event.failure) showToast(event.failure)
      const text = memoryNotice(event.memories)
      if (text) showToast(text, { action: { label: t("app.view"), kind: 'open-profile' }, ms: NOTICE_TOAST_MS })
      void refreshMemoryViews()
    },
  }
}
