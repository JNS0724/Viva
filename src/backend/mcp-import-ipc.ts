import { t } from '../shared/i18n/translate.ts'
import { handlerOf, type IpcRegistry } from '../shared/ipc-contract.ts'
import { shortPath, type EnvLookup } from './dsh-mcp-import.ts'
import { readClientServers, scanMcp, type McpCandidate, type McpSource } from './mcp-import.ts'
import { serverView, type ServerConfig } from './mcp-config.ts'

/**
 * IPC for bringing MCP servers in from other clients (能力 · MCP · 导入, mcp-import.ts): the clients found, a scan of
 * one, and the import of those ticked, saved in one write and the session's servers attached again once. The window
 * names a client by its id and a scan by its id, never a path, and gets no secret: a candidate is its names, how it
 * connects and why. The import reads the client again; a server ticked that would now be saved under another name,
 * or not at all, stops it, and the new scan goes back to be looked at again.
 */
const candidateView = ({ config, ...rest }: McpCandidate) => ({ ...rest, type: config?.type ?? null })

export function registerMcpImportIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: {
  store: { list: () => ServerConfig[], addMany: (configs: readonly ServerConfig[]) => void },
  sources: () => McpSource[],
  /** How the login shell would fill in `${VAR}`, and whether it finds a command. */
  shell: () => Promise<{ lookup: EnvLookup, findCommand: (command: string) => string | null }>,
  /** Attaches the session's servers again; what the agent says of them after. */
  applyMcp: () => Promise<object | null>,
  newId?: () => string,
}) {
  const { store, sources, shell, applyMcp, newId = () => String(Date.now()) } = deps
  const handle = handlerOf(ipcMain)
  let scanned: { id: string, sourceId: string, label: string, candidates: readonly McpCandidate[] } | null = null
  const scanView = () => ({ scanId: scanned!.id, label: scanned!.label, candidates: scanned!.candidates.map(candidateView) })

  async function scan(sourceId: string) {
    const source = sources().find((one) => one.id === sourceId)
    if (!source) throw new Error(t('main.mcp-import.no.source'))
    const tools = await shell()
    return { source, candidates: scanMcp(readClientServers(source.file), { taken: store.list().map((server) => server.name), ...tools }) }
  }

  handle('ext:mcp-sources', () => sources().map(({ file, ...source }) => ({ ...source, where: shortPath(file) })))

  handle('ext:scan-mcp', async (sourceId) => {
    const { source, candidates } = await scan(sourceId)
    scanned = { id: newId(), sourceId, label: source.label, candidates }
    return scanView()
  })

  /** Whether every one ticked would be saved as it was shown. */
  const asShown = (fresh: readonly McpCandidate[], picks: readonly string[]) => picks.every((entry) => {
    const shown = scanned!.candidates.find((candidate) => candidate.entry === entry)
    const now = fresh.find((candidate) => candidate.entry === entry)
    return shown && now?.config && now.name === shown.name && now.why === shown.why
  })

  handle('ext:import-mcp', async (scanId, picks) => {
    if (!scanned || scanned.id !== scanId) throw new Error(t('main.skill-import.scan.again'))
    const { candidates } = await scan(scanned.sourceId)
    if (!asShown(candidates, picks)) {
      scanned = { ...scanned, id: newId(), candidates }
      return { changed: true, scan: scanView() }
    }
    const chosen = candidates.filter((candidate) => picks.includes(candidate.entry) && candidate.config).map((candidate) => candidate.config!)
    if (chosen.length) store.addMany(chosen)
    const info = chosen.length ? await applyMcp() : null
    const missing = chosen.filter((server) => server.missing.length)
    const notice = [
      chosen.length ? t('main.mcp-import.imported', { count: chosen.length, names: chosen.map((server) => server.name).join('、') }) : '',
      ...missing.map((server) => t('main.mcp-import.still.missing', { name: server.name, keys: server.missing.join('、') })),
    ].filter(Boolean).join(' ')
    return { imported: chosen.map((server) => server.name), notice, info, servers: store.list().map(serverView) }
  })
}
