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

/** The same server in every part that is saved, keys and their values included (compared here, never sent). */
const sameServer = (a: ServerConfig, b: ServerConfig) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const sorted = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).sort(([x], [y]) => x.localeCompare(y)))
const canonical = (server: ServerConfig) => ({ ...server, env: sorted(server.env), headers: sorted(server.headers), missing: [...server.missing].sort() })

export function registerMcpImportIpc(ipcMain: Pick<IpcRegistry, 'handle'>, deps: {
  store: { list: () => ServerConfig[], addMany: (configs: readonly ServerConfig[]) => void },
  /** The clients found; async, as where to look comes from the login shell. */
  sources: () => McpSource[] | Promise<McpSource[]>,
  /** How the login shell would fill in `${VAR}`, and whether it finds a command. */
  shell: () => Promise<{ lookup: EnvLookup, findCommand: (command: string) => string | null }>,
  /** Attaches the session's servers again; what the agent says of them after. */
  applyMcp: () => Promise<object | null>,
  newId?: () => string,
}) {
  const { store, sources, shell, applyMcp, newId = () => String(Date.now()) } = deps
  const handle = handlerOf(ipcMain)
  type Scan = { id: string, sourceId: string, label: string, candidates: readonly McpCandidate[] }
  /** The last scan the window was shown; an import names it by id. */
  let scanned: Scan | null = null
  /** Scans begun, so one that ends after a later one does not take its place. */
  let begun = 0
  const scanView = (scan: Scan) => ({ scanId: scan.id, label: scan.label, candidates: scan.candidates.map(candidateView) })

  async function scan(sourceId: string) {
    // Both ask the login shell; asked together, neither waits on the other.
    const [found, tools] = await Promise.all([sources(), shell()])
    const source = found.find((one) => one.id === sourceId)
    if (!source) throw new Error(t('main.mcp-import.no.source'))
    return { source, candidates: scanMcp(readClientServers(source.file), { taken: store.list().map((server) => server.name), ...tools }) }
  }

  handle('ext:mcp-sources', async () => (await sources()).map(({ file, ...source }) => ({ ...source, where: shortPath(file) })))

  handle('ext:scan-mcp', async (sourceId) => {
    const turn = ++begun
    const { source, candidates } = await scan(sourceId)
    const done = { id: newId(), sourceId, label: source.label, candidates }
    if (turn === begun) scanned = done
    return scanView(done)
  })

  /** Whether every one ticked would be saved exactly as it was shown: its name, why, and the whole server, keys too. */
  const asShown = (shown: Scan, fresh: readonly McpCandidate[], picks: readonly string[]) => picks.every((entry) => {
    const before = shown.candidates.find((candidate) => candidate.entry === entry)
    const now = fresh.find((candidate) => candidate.entry === entry)
    return before?.config && now?.config && now.name === before.name && now.why === before.why && sameServer(now.config, before.config)
  })

  handle('ext:import-mcp', async (scanId, picks) => {
    // The scan asked about, held for the whole import: another scan meanwhile does not change what this one acts on.
    const shown = scanned
    const turn = begun
    if (!shown || shown.id !== scanId) throw new Error(t('main.skill-import.scan.again'))
    const { candidates } = await scan(shown.sourceId)
    if (scanned !== shown || begun !== turn) throw new Error(t('main.skill-import.scan.again'))
    if (!asShown(shown, candidates, picks)) {
      scanned = { ...shown, id: newId(), candidates }
      return { changed: true, scan: scanView(scanned) }
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
