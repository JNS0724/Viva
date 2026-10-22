import { serverView } from './mcp-config.ts'
import { listSkills, removeSkill } from './skills.ts'

const MAX_ID_CHARS = 300

function assertName(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_CHARS) throw new Error('invalid name')
  return value
}

/**
 * IPC for the 扩展 section of settings: the user's MCP servers and skills, to list and remove. Adding
 * happens in the conversation (viva-config, config-channel.js). Removing a server reattaches the session.
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {{
 *   store: ReturnType<import('./mcp-config.ts').createMcpConfigStore>,
 *   roots: () => ReturnType<import('./skills.ts').skillRoots>,
 *   mcpStatus: () => { active: string[], dropped: Array<{ name: string, reason: string }> },
 *   applyMcp: () => Promise<object | null>,
 *   trash: (file: string) => Promise<void>,
 * }} deps
 */
export function registerExtensionsIpc(ipcMain, deps) {
  const { store, roots, mcpStatus, applyMcp, trash } = deps
  const handle = (channel, listener) => ipcMain.handle(channel, (_event, ...args) => listener(...args))
  const userRoot = () => roots().find((root) => root.managed)

  const view = () => ({
    servers: store.list().map(serverView),
    status: mcpStatus(),
    skills: listSkills(roots()),
    skillDir: userRoot().dir,
  })

  handle('ext:get', view)

  handle('ext:remove-mcp', async (name) => {
    store.remove(assertName(name))
    const info = await applyMcp()
    return { ...view(), info }
  })

  handle('ext:remove-skill', async (id) => {
    const removed = await removeSkill(assertName(id), roots(), trash)
    return { ...view(), removed }
  })
}
