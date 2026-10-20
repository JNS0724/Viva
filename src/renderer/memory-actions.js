
const SEARCH_DEBOUNCE_MS = 200
const UNDO_TOAST_MS = 8000
const NOTICE_TOAST_MS = 6000
/** The profile fields the intro asks for: all three. Sites and documents are only read, not kept. */
export const INTRO_FIELDS = Object.freeze(['role', 'projects', 'preferences'])

const lines = (text) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean)

/**
 * What the agent is asked after the intro when the user gave sites or documents: read them and fill in
 * the profile with the memory tools. Shown in the thread like any question, so nothing happens unseen.
 * @param {{ sources: string[], docs: Array<{ path: string }> }} input
 */
export function introPrompt({ sources, docs }) {
  return [
    '请先了解一下我：阅读下面这些我常用的网站和文档，归纳我所在的部门、负责的领域、在推进的项目和常打交道的人，',
    '把这些逐条用 memory_remember 记下来（部门和职责用 kind=role，人用 person，项目用 project），重要的术语和约定也记下；打不开的就跳过。最后用三五句话告诉我你了解到了什么。',
    ...[...sources, ...docs.map((doc) => doc.path)].map((item) => `- ${item}`),
  ].join('\n')
}

/**
 * The intro form's values as profile changes: only filled fields, so skipping one never clears it.
 * @param {Record<string, string>} values
 */
export function introChanges(values) {
  return Object.fromEntries(INTRO_FIELDS.map((key) => [key, String(values[key] ?? '').trim()]).filter(([, value]) => value))
}

/** "已记住：周报每周五交给张三" / "已记住 3 条" / "已补充画像：在推进的事". */
export function memoryNotice({ memories = [], invalidated = [] }) {
  const remembered = memories.length === 1 ? `已记住：${memories[0]}` : memories.length > 1 ? `已记住 ${memories.length} 条新内容` : ''
  const replaced = invalidated.length === 1 ? `「${invalidated[0]}」已不再使用` : invalidated.length > 1 ? `${invalidated.length} 条旧记忆已不再使用` : ''
  return [remembered, replaced].filter(Boolean).join('；')
}

/**
 * The "关于你" page and the intro.
 * @param {{
 *   api: typeof window.agent, getState: () => object, dispatch: (action: object) => void,
 *   errorMessage: (err: unknown) => string,
 *   showToast: (text: string, options?: object) => void,
 *   ask: (text: string) => boolean,
 * }} deps
 */
export function createMemoryActions({ api, getState, dispatch, errorMessage, showToast, ask }) {
  let searchTimer = 0
  const fail = (err) => dispatch({ type: 'memory_failed', message: errorMessage(err) })

  async function loadMemory() {
    try {
      dispatch({ type: 'memory_loaded', data: await api.getMemory() })
    } catch (err) {
      fail(err)
    }
  }

  async function runSearch(query) {
    try {
      dispatch({ type: 'memory_listed', query, ...await api.listMemories(query.trim()) })
    } catch (err) {
      fail(err)
    }
  }

  async function saveIntro(values, analyze) {
    const { docs } = getState().memory
    const changes = introChanges(values)
    const profile = await api.saveProfile(changes)
    dispatch({ type: 'memory_profile_saved', profile })
    dispatch({ type: 'memory_onboarding', status: await api.setOnboarding('done') })
    dispatch({ type: 'memory_close' })
    const sources = lines(values.sources)
    const wantsReading = analyze && (sources.length > 0 || docs.length > 0)
    if (wantsReading && ask(introPrompt({ sources, docs }))) return
    showToast(wantsReading ? '已保存。连接模型后，可以再让助手阅读这些资料' : '已保存，可以在「关于你」里随时补充', {
      action: { label: '查看', kind: 'open-profile' }, ms: NOTICE_TOAST_MS,
    })
  }

  return {
    loadMemory,
    openProfile(view = 'profile') {
      dispatch({ type: 'memory_open', view })
      loadMemory()
    },
    closeProfile: () => dispatch({ type: 'memory_close' }),
    editField: (key) => dispatch({ type: 'memory_edit', key }),

    async saveField(key, value) {
      dispatch({ type: 'memory_busy' })
      try {
        dispatch({ type: 'memory_profile_saved', profile: await api.saveProfile({ [key]: value }) })
      } catch (err) {
        fail(err)
      }
    },

    searchMemories(query) {
      dispatch({ type: 'memory_query', query })
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS)
    },

    /** @returns {Promise<boolean>} whether it was saved, so the field can be cleared */
    async addMemory(text) {
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

    async deleteMemory(memory) {
      try {
        const removed = await api.deleteMemory(memory.id)
        dispatch({ type: 'memory_removed', id: memory.id })
        if (removed) showToast('已删除这条记忆', { action: { label: '撤销', kind: 'undo-memory', payload: removed }, ms: UNDO_TOAST_MS })
      } catch (err) {
        fail(err)
      }
    },

    async undoMemoryDelete(memory) {
      try {
        await api.restoreMemory(memory)
        await runSearch(getState().memory.query)
      } catch (err) {
        showToast(`撤销失败：${errorMessage(err)}`)
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

    async reviveMemory(memory) {
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

    async finishIntro(values, analyze) {
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
    onMemoryChanged(event) {
      const text = memoryNotice(event)
      if (text) showToast(text, { action: { label: '查看', kind: 'open-profile' }, ms: NOTICE_TOAST_MS })
      loadMemory()
    },
  }
}
