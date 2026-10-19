import fs from 'node:fs'
import { parseServerInput, serverView } from './mcp-config.js'
import { importSkill, listSkills, removeSkill } from './skills.js'

const MAX_ID_CHARS = 300

function assertName(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_CHARS) throw new Error('invalid name')
  return value
}

/**
 * IPC for the 扩展 section of settings: the user's MCP servers and skills.
 * Changing the MCP servers reattaches the current session so the agent gets the new tools right away.
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {{
 *   store: ReturnType<import('./mcp-config.js').createMcpConfigStore>,
 *   roots: () => ReturnType<import('./skills.js').skillRoots>,
 *   mcpStatus: () => { active: string[], dropped: Array<{ name: string, reason: string }> },
 *   applyMcp: () => Promise<object | null>,
 *   chooseSkill: () => Promise<string | null>,
 *   trash: (file: string) => Promise<void>,
 *   openPath: (dir: string) => Promise<string>,
 * }} deps
 */
export function registerExtensionsIpc(ipcMain, deps) {
  const { store, roots, mcpStatus, applyMcp, chooseSkill, trash, openPath } = deps
  const handle = (channel, listener) => ipcMain.handle(channel, (_event, ...args) => listener(...args))
  const userRoot = () => roots().find((root) => root.managed)

  const view = () => ({
    servers: store.list().map(serverView),
    status: mcpStatus(),
    skills: listSkills(roots()),
    skillDir: userRoot().dir,
  })

  handle('ext:get', view)

  handle('ext:add-mcp', async (input) => {
    const taken = store.list().map((server) => server.name)
    store.add(parseServerInput(input, taken))
    const info = await applyMcp()
    return { ...view(), info }
  })

  handle('ext:remove-mcp', async (name) => {
    store.remove(assertName(name))
    const info = await applyMcp()
    return { ...view(), info }
  })

  handle('ext:import-skill', async () => {
    const source = await chooseSkill()
    if (!source) return { ...view(), imported: null }
    const imported = importSkill(source, userRoot().dir)
    return { ...view(), imported }
  })

  handle('ext:remove-skill', async (id) => {
    const removed = await removeSkill(assertName(id), roots(), trash)
    return { ...view(), removed }
  })

  handle('ext:open-skill-dir', async () => {
    const dir = userRoot().dir
    fs.mkdirSync(dir, { recursive: true })
    const problem = await openPath(dir)
    if (problem) throw new Error(problem)
  })
}
