import { t } from '../shared/i18n/translate.ts'
import { importSummary, shortPath, type ImportResult } from './dsh-mcp-import.ts'
import { handlerOf, type IpcRegistry } from './ipc-contract.ts'
import { editServer, serverView, type createMcpConfigStore, type ServerChanges } from './mcp-config.ts'
import { listSkills, removeSkill, type skillRoots } from './skills.ts'

const MAX_ID_CHARS = 300
const MAX_FIELD_CHARS = 4000
const MAX_KEYS = 30

function assertName(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_CHARS) throw new Error('invalid name')
  return value
}

const field = (value: unknown, what: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > MAX_FIELD_CHARS) throw new Error(`invalid ${what}`)
  return value
}

/**
 * The edit form as sent: name, type, command, url as typed; args one per line; keys as [{ name, value }], a blank
 * value keeping the saved one. Only shapes are checked here; editServer checks what they mean.
 */
export function formChanges(input: Record<string, unknown>): ServerChanges {
  const type = input.type === undefined ? undefined : input.type === 'http' ? 'http' : input.type === 'stdio' ? 'stdio' : null
  if (type === null) throw new Error('invalid type')
  const args = field(input.args, 'args')
  const keys = input.keys === undefined ? undefined : input.keys
  if (keys !== undefined && (!Array.isArray(keys) || keys.length > MAX_KEYS)) throw new Error('invalid keys')
  return {
    name: field(input.name, 'name')?.trim(),
    type,
    command: field(input.command, 'command')?.trim(),
    args: args === undefined ? undefined : args.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean),
    url: field(input.url, 'url')?.trim(),
    keys: keys?.map((key: any) => ({ name: field(key?.name, 'key name') ?? '', value: field(key?.value, 'key value') ?? '' })),
  }
}

/** Where MCP servers can be imported from: dsh's default home, and the folder used last time if it was another. */
export interface DshDirs { defaultDir: string, lastDir: string }

/**
 * IPC for the 扩展 section of settings: the user's MCP servers and skills, to list, edit and remove, and the
 * servers of the user's own dsh, to import with their keys. Adding one by hand happens in the conversation
 * (viva-config, config-channel.js). Any change to the servers reattaches the session.
 */
export function registerExtensionsIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: {
  store: ReturnType<typeof createMcpConfigStore>,
  roots: () => ReturnType<typeof skillRoots>,
  mcpStatus: () => { active: string[], dropped: Array<{ name: string, reason: string }> },
  applyMcp: () => Promise<object | null>,
  trash: (file: string) => Promise<void>,
  dshDirs: () => DshDirs,
  /** The system's folder dialog; null when the user cancels. */
  chooseDshDir: () => Promise<string | null>,
  importDsh: (dir: string) => Promise<ImportResult>,
  rememberDshDir: (dir: string) => void,
}) {
  const { store, roots, mcpStatus, applyMcp, trash, dshDirs, chooseDshDir, importDsh, rememberDshDir } = deps
  const handle = handlerOf(ipcMain)
  const userRoot = () => roots().find((root) => root.managed)

  const view = () => {
    const { defaultDir, lastDir } = dshDirs()
    return {
      servers: store.list().map(serverView),
      status: mcpStatus(),
      skills: listSkills(roots()),
      skillDir: userRoot()?.dir,
      dsh: { defaultLabel: shortPath(defaultDir), lastLabel: lastDir && lastDir !== defaultDir ? shortPath(lastDir) : '' },
    }
  }

  handle('ext:get', view)

  handle('ext:remove-mcp', async (name) => {
    store.remove(assertName(name))
    const info = await applyMcp()
    return { ...view(), info }
  })

  handle('ext:update-mcp', async (name, input) => {
    const current = store.list().find((server) => server.name === assertName(name))
    if (!current) throw new Error(t("main.extensions-ipc.no.server.named", { name: name }))
    const next = editServer(current, formChanges(input), store.list().map((server) => server.name))
    store.update(current.name, next)
    const info = await applyMcp()
    return { ...view(), info, name: next.name }
  })

  /** The folder is never given by the page: dsh's default, the one used last, or one the user picks now. */
  handle('ext:import-dsh', async (from) => {
    const { defaultDir, lastDir } = dshDirs()
    const dir = from === 'choose' ? await chooseDshDir() : from === 'last' && lastDir ? lastDir : defaultDir
    if (!dir) return { ...view(), cancelled: true }
    const result = await importDsh(dir)
    if (dir !== defaultDir) rememberDshDir(dir)
    const info = result.added.length ? await applyMcp() : null
    return { ...view(), info, imported: result.added.map((server) => server.name), notice: importSummary(result) }
  })

  handle('ext:remove-skill', async (id) => {
    const removed = await removeSkill(assertName(id), roots(), trash)
    return { ...view(), removed }
  })
}
