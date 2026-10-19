import { isBusy } from './state.js'

/** What to tell the user after an MCP change, from what the main process reports back. */
export function mcpNotice(verb, name, view) {
  if (!view.info) return `已${verb}，下次连接时生效`
  const dropped = view.status.dropped.find((item) => item.name === name)
  if (verb === '添加' && dropped) return `已添加，但没能连上「${name}」：${dropped.reason}`
  return `已${verb}，当前对话已经生效`
}

/**
 * The 扩展 section of settings: the user's MCP servers and skills.
 * @param {{
 *   api: typeof window.agent, getState: () => object, dispatch: (action: object) => void,
 *   errorMessage: (err: unknown) => string,
 * }} deps
 */
export function createExtensionActions({ api, getState, dispatch, errorMessage }) {
  const fail = (err) => dispatch({ type: 'extensions_failed', message: errorMessage(err) })

  /** Runs `request` unless another change is in flight; `noticeFor` turns the answer into a status line. */
  async function change(request, noticeFor) {
    if (getState().extensions.busy) return
    dispatch({ type: 'extensions_busy' })
    try {
      const view = await request()
      dispatch({ type: 'extensions_saved', view, notice: noticeFor(view) })
      if (view.info) dispatch({ type: 'config_applied', info: view.info })
    } catch (err) {
      fail(err)
    }
  }

  /** Changing servers reattaches the session, which would cancel a running task. */
  function guardMcp() {
    if (!isBusy(getState())) return true
    dispatch({ type: 'extensions_failed', message: '先停止当前任务，再修改 MCP 服务器' })
    return false
  }

  return {
    async loadExtensions() {
      try {
        dispatch({ type: 'extensions_loaded', view: await api.getExtensions() })
      } catch (err) {
        fail(err)
      }
    },
    toggleAddServer: (adding) => dispatch({ type: 'extensions_adding', adding }),
    addServer(values) {
      if (guardMcp()) change(() => api.addMcpServer(values), (view) => mcpNotice('添加', values.name, view))
    },
    removeServer(name) {
      if (guardMcp()) change(() => api.removeMcpServer(name), (view) => mcpNotice('删除', name, view))
    },
    importSkill: () => change(() => api.importSkill(), (view) => (view.imported ? `已导入「${view.imported}」，助手马上就能用` : null)),
    removeSkill: (skill) => change(() => api.removeSkill(skill.id), () => `已把「${skill.name}」移到废纸篓`),
    async openSkillDir() {
      try {
        await api.openSkillDir()
      } catch (err) {
        fail(err)
      }
    },
  }
}
