import fs from 'node:fs'
import path from 'node:path'
import { t } from '../shared/i18n/translate.ts'
import { loginShellEnv, type EnvLookup } from './dsh-mcp-import.ts'
import { EXTRA_COMMAND_DIRS, resolveCommand, validateServer, type ServerConfig } from './mcp-config.ts'

/**
 * MCP servers brought in from another client's settings (Claude Desktop, Claude Code, Cursor: `mcpServers` in JSON),
 * each read into a server as Viva keeps it and checked by Viva's own rules (mcp-config.ts validateServer) before any
 * is saved. A key written as `${VAR}` (or `${env:VAR}`) takes its value from the login shell, as the client would;
 * one the shell has not is kept by name, to be filled in. A legacy SSE server, or one whose command cannot be found,
 * is refused with why; a name Viva cannot use is put right, and one Viva has is offered renamed, not ticked. The
 * client's file is only read.
 */
const NAME_LENGTH = 32
const REF = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g

/** A client found with servers in its settings. */
export interface McpSource { id: string, label: string, file: string, count: number }

/** Where each client keeps its servers, by platform. */
function clientFiles({ home, platform, appData }: { home: string, platform: string, appData: string }) {
  const desktop = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? path.join(appData, 'Claude') : path.join(home, '.config', 'Claude')
  return [
    { id: 'claude-desktop', label: 'Claude Desktop', file: path.join(desktop, 'claude_desktop_config.json') },
    { id: 'claude-code', label: 'Claude Code', file: path.join(home, '.claude.json') },
    { id: 'cursor', label: 'Cursor', file: path.join(home, '.cursor', 'mcp.json') },
  ]
}

/** The servers a client's settings file names (`mcpServers`); none when it is missing, not JSON, or has none. */
export function readClientServers(file: string): Array<{ entry: string, value: unknown }> {
  try {
    const servers: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
    return Object.entries(servers as Record<string, unknown>).map(([entry, value]) => ({ entry, value }))
  } catch {
    return []
  }
}

/** The clients on this computer with any servers in their settings. */
export function mcpSources(where: { home: string, platform: string, appData: string }): McpSource[] {
  return clientFiles(where).map((client) => ({ ...client, count: readClientServers(client.file).length })).filter((client) => client.count > 0)
}

/** ready: saved as it is (`missing` its keys still to fill in); fixable: saved under `name`; blocked: not at all. */
export type McpWhy = 'ready' | 'missing' | 'name' | 'taken' | 'sse' | 'command' | 'invalid'

export interface McpCandidate {
  /** Its name in the client's settings. */
  entry: string
  /** The name it is saved under. */
  name: string
  status: 'ready' | 'fixable' | 'blocked'
  why: McpWhy
  /** The keys still to fill in, or why it was refused. */
  detail: string | null
  /** As Viva would save it; null when refused. Holds secrets: never sent to the window. */
  config: ServerConfig | null
  picked: boolean
}

/** `${VAR}` filled in from the shell; undefined when one is not there. */
function filled(text: string, lookup: EnvLookup): string | undefined {
  let complete = true
  const value = text.replace(REF, (_match, name: string) => {
    const found = lookup(name)
    if (found === undefined) complete = false
    return found ?? ''
  })
  return complete ? value : undefined
}

/** Keys with their values filled in; those the shell has no value for, by name. */
function pairsOf(raw: unknown, lookup: EnvLookup): { values: Record<string, string>, missing: string[] } {
  const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw as Record<string, unknown>) : []
  const read = entries.map(([name, value]) => [name, filled(String(value ?? ''), lookup)] as const)
  return {
    values: Object.fromEntries(read.filter((pair): pair is readonly [string, string] => pair[1] !== undefined)),
    missing: read.filter(([, value]) => value === undefined).map(([name]) => name),
  }
}

const usableName = (entry: string) => entry.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_LENGTH)

type Read = { config: ServerConfig } | { refused: 'sse' | 'command' | 'invalid', detail: string | null }

/** A client's entry as Viva would save it, or why it cannot be. */
function readEntry(name: string, value: unknown, lookup: EnvLookup, findCommand: (command: string) => string | null): Read {
  const entry = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const kind = String(entry.type ?? entry.transport ?? '').toLowerCase()
  if (kind === 'sse') return { refused: 'sse', detail: null }
  const url = typeof entry.url === 'string' ? entry.url : typeof entry.serverUrl === 'string' ? entry.serverUrl : ''
  const http = kind === 'http' || kind === 'streamable-http' || kind === 'streamablehttp' || (!entry.command && Boolean(url))
  try {
    if (http) {
      const { values, missing } = pairsOf(entry.headers, lookup)
      return { config: validateServer({ name, type: 'http', command: '', args: [], url: filled(url, lookup) ?? url, env: {}, headers: values, missing }, []) }
    }
    const command = filled(String(entry.command ?? ''), lookup) ?? ''
    if (command && !findCommand(command)) return { refused: 'command', detail: command }
    const args = Array.isArray(entry.args) ? entry.args.map((arg) => filled(String(arg), lookup) ?? String(arg)) : []
    const { values, missing } = pairsOf(entry.env, lookup)
    return { config: validateServer({ name, type: 'stdio', command, args, url: '', env: values, headers: {}, missing }, []) }
  } catch (err) {
    return { refused: 'invalid', detail: err instanceof Error ? err.message : String(err) }
  }
}

/** `name`, or the first of name-2, name-3… not taken (in any case). */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; ; n += 1) if (!taken.has(`${name}-${n}`.toLowerCase())) return `${name}-${n}`
}

/**
 * Each entry read and checked; `taken` is the names Viva has. Those whose name needs no change settle first, so of
 * two with one name the one renamed is the other.
 */
export function scanMcp(entries: ReadonlyArray<{ entry: string, value: unknown }>, { taken, lookup, findCommand }: {
  taken: readonly string[], lookup: EnvLookup, findCommand: (command: string) => string | null,
}): McpCandidate[] {
  const order = [...entries.filter((item) => usableName(item.entry) === item.entry), ...entries.filter((item) => usableName(item.entry) !== item.entry)]
  let claimed = new Set(taken.map((name) => name.toLowerCase()))
  const scanned = order.map((item): McpCandidate => {
    const base = usableName(item.entry)
    if (!base) return { entry: item.entry, name: item.entry, status: 'blocked', why: 'invalid', detail: t('main.mcp-import.no.name'), config: null, picked: false }
    const name = freeName(base, claimed)
    const read = readEntry(name, item.value, lookup, findCommand)
    if ('refused' in read) return { entry: item.entry, name, status: 'blocked', why: read.refused, detail: read.detail, config: null, picked: false }
    claimed = new Set([...claimed, name.toLowerCase()])
    const why: McpWhy = name !== base ? 'taken' : base !== item.entry ? 'name' : read.config.missing.length ? 'missing' : 'ready'
    const detail = read.config.missing.length ? read.config.missing.join('、') : null
    return { entry: item.entry, name, status: why === 'taken' || why === 'name' ? 'fixable' : 'ready', why, detail, config: read.config, picked: why !== 'taken' }
  })
  return entries.map((item) => scanned.find((candidate) => candidate.entry === item.entry)!)
}

/**
 * What the login shell gives a client started from it, which an app opened from the Dock lacks: its variables, to
 * fill in `${VAR}`, and its PATH, to find a server's command.
 */
export async function loginShellTools(): Promise<{ lookup: EnvLookup, findCommand: (command: string) => string | null }> {
  const env: Record<string, string | undefined> = { ...process.env, ...await loginShellEnv() }
  return {
    lookup: (name) => env[name] || undefined,
    findCommand: (command) => resolveCommand(command, { env, extraDirs: EXTRA_COMMAND_DIRS }),
  }
}
