import { handlerOf, type IpcRegistry } from './ipc-contract.ts'
import { serverView, type createMcpConfigStore } from './mcp-config.ts'
import { listSkills, removeSkill, type skillRoots } from './skills.ts'

const MAX_ID_CHARS = 300

function assertName(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_CHARS) throw new Error('invalid name')
  return value
}

/**
 * IPC for the 扩展 section of settings: the user's MCP servers and skills, to list and remove. Adding
 * happens in the conversation (viva-config, config-channel.js). Removing a server reattaches the session.
 */
export function registerExtensionsIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: {
  store: ReturnType<typeof createMcpConfigStore>,
  roots: () => ReturnType<typeof skillRoots>,
  mcpStatus: () => { active: string[], dropped: Array<{ name: string, reason: string }> },
  applyMcp: () => Promise<object | null>,
  trash: (file: string) => Promise<void>,
}) {
  const { store, roots, mcpStatus, applyMcp, trash } = deps
  const handle = handlerOf(ipcMain)
  const userRoot = () => roots().find((root) => root.managed)

  const view = () => ({
    servers: store.list().map(serverView),
    status: mcpStatus(),
    skills: listSkills(roots()),
    skillDir: userRoot()?.dir,
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
