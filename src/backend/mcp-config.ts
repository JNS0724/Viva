import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'
import type { Encryption } from './settings-store.ts'

/**
 * MCP servers the user adds in settings. dsh attaches them to every session through ACP.
 * Environment variables and HTTP headers usually hold tokens, so their values are encrypted with the
 * OS keychain (safeStorage) like the API key, and the UI only ever sees their names.
 */
const FILE_VERSION = 1
export const MAX_SERVERS = 20
const MAX_ARGS = 50
const MAX_ARG_CHARS = 1000
const MAX_COMMAND_CHARS = 500
const MAX_URL_CHARS = 2000
const MAX_SECRET_CHARS = 4000
const MAX_PAIRS = 30
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,128}$/
export const SERVER_TYPES: readonly string[] = Object.freeze(['stdio', 'http'])

/**
 * A server as the main process holds it: its secrets (env, headers) decrypted. `missing` names keys it needs but
 * has no value for yet (a server taken over from dsh whose variable was not set); the user fills them in by editing.
 */
export interface ServerConfig {
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  headers: Record<string, string>
  missing: string[]
}

const lines = (text: unknown) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

function requireText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(t("main.mcp-config.enter", { what: what }))
  if (value.length > max) throw new Error(t("main.mcp-config.is.too.long", { what: what }))
  return value.trim()
}

/** "KEY=VALUE" per line. */
function parsePairs(text: unknown, what: string): Record<string, string> {
  const pairs = lines(text).map((line) => {
    const at = line.indexOf('=')
    if (at <= 0) throw new Error(t("main.mcp-config.must.use.name.value.one.per.line", { what: what, value2: line.slice(0, 40) }))
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
  })
  const names = pairs.map(([name]) => name)
  if (new Set(names).size !== names.length) throw new Error(t("main.mcp-config.contains.duplicate.names", { what: what }))
  return Object.fromEntries(pairs)
}

function parseUrl(value: unknown): string {
  const text = requireText(value, t("main.config-channel.server.address"), MAX_URL_CHARS)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(t("main.mcp-config.server.address.is.not.a.valid.url"))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(t("main.mcp-config.server.address.must.start.with.http.or"))
  return url.toString()
}

/** The keys of one kind (env or headers), with the names still missing a value: names fit, values fit. */
function checkKeys(values: Record<string, string>, missing: readonly string[], kind: ServerConfig['type']) {
  const http = kind === 'http'
  const what = http ? t("main.mcp-config.headers") : t("main.mcp-config.environment.variables")
  const pattern = http ? HEADER_NAME_PATTERN : ENV_NAME_PATTERN
  const names = [...Object.keys(values), ...missing]
  if (names.length > MAX_PAIRS) throw new Error(t("main.mcp-config.allows.at.most.entries", { what: what, MAX_PAIRS: MAX_PAIRS }))
  if (new Set(names.map((name) => (http ? name.toLowerCase() : name))).size !== names.length) throw new Error(t("main.mcp-config.contains.duplicate.names", { what: what }))
  for (const name of names) if (!pattern.test(name)) throw new Error(t("main.mcp-config.invalid.name", { what: what, value2: name.slice(0, 40) }))
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string') throw new Error(t("main.mcp-config.invalid.value.for", { what: what, name: name }))
    if (value.length > MAX_SECRET_CHARS) throw new Error(t("main.mcp-config.value.for.is.too.long", { what: what, name: name }))
    if (http && /[\r\n]/.test(value)) throw new Error(t("main.mcp-config.header.must.be.on.one.line", { name: name }))
  }
}

/**
 * Checks a whole server, however it was made (the form, an edit, dsh's config), and returns it as stored: the
 * fields of its type only, the URL normalized.
 * @param takenNames names already in use by other servers (the memory server's included)
 */
export function validateServer(config: ServerConfig, takenNames: readonly string[]): ServerConfig {
  const name = requireText(config.name, t("main.mcp-config.name"), 32)
  if (!NAME_PATTERN.test(name)) throw new Error(t("main.mcp-config.names.must.use.english.letters.numbers.and"))
  if (takenNames.some((taken) => taken.toLowerCase() === name.toLowerCase())) throw new Error(t("main.mcp-config.a.server.named.already.exists", { name: name }))
  if (!SERVER_TYPES.includes(config.type)) throw new Error(t("main.mcp-config.choose.a.connection.type"))
  const missing = [...new Set(config.missing ?? [])]
  if (config.type === 'http') {
    const url = parseUrl(config.url)
    checkKeys(config.headers, missing, 'http')
    return { name, type: 'http', command: '', args: [], url, env: {}, headers: { ...config.headers }, missing }
  }
  const command = requireText(config.command, t("main.config-channel.launch.command"), MAX_COMMAND_CHARS)
  const args = [...config.args]
  if (args.length > MAX_ARGS || args.some((arg) => typeof arg !== 'string' || arg.length > MAX_ARG_CHARS)) throw new Error(t("main.mcp-config.too.many.or.overly.long.arguments"))
  checkKeys(config.env, missing, 'stdio')
  return { name, type: 'stdio', command, args, url: '', env: { ...config.env }, headers: {}, missing }
}

/**
 * Validates what the settings form sends. Text fields are as typed: arguments one per line,
 * environment variables and headers as "NAME=value" lines.
 * @param input untrusted: each field is checked below
 * @param takenNames names already in use (the memory server's included)
 */
export function parseServerInput(input: any, takenNames: readonly string[]): ServerConfig {
  if (!input || typeof input !== 'object') throw new Error('invalid MCP server')
  const http = input.type === 'http'
  return validateServer({
    name: input.name, type: input.type, command: input.command, args: lines(input.args), url: input.url,
    env: http ? {} : parsePairs(input.env, t("main.mcp-config.environment.variables")), headers: http ? parsePairs(input.headers, t("main.mcp-config.headers")) : {}, missing: [],
  }, takenNames)
}

/** What an edit changes; a field left out stays as it was. */
export interface ServerChanges {
  name?: string
  type?: ServerConfig['type']
  command?: string
  args?: string[]
  url?: string
  /** Every key the server keeps, as the form lists them: a blank value keeps the saved one. Left out: all kept. */
  keys?: ReadonlyArray<{ name: string, value: string }>
  /** Values to set besides (keys typed on the card in the conversation). */
  values?: Readonly<Record<string, string>>
}

/**
 * A server after an edit: what changed replaced, saved keys kept unless typed again, keys without a value
 * listed as missing. Keys follow the server when it changes type (environment variables become headers).
 * @param takenNames names in use by every server, this one's included
 */
export function editServer(current: ServerConfig, changes: ServerChanges, takenNames: readonly string[]): ServerConfig {
  const saved: Record<string, string> = { ...current.env, ...current.headers }
  const typed = Object.fromEntries((changes.keys ?? []).filter((key) => key.value.trim()).map((key) => [key.name.trim(), key.value.trim()]))
  const next = { ...saved, ...typed, ...changes.values }
  const listed = changes.keys ? changes.keys.map((key) => key.name.trim()).filter(Boolean) : [...Object.keys(saved), ...current.missing]
  const names = [...new Set([...listed, ...Object.keys(changes.values ?? {})])]
  const kept = Object.fromEntries(names.filter((name) => next[name] !== undefined).map((name) => [name, next[name]]))
  const type = changes.type ?? current.type
  const others = takenNames.filter((name) => name.toLowerCase() !== current.name.toLowerCase())
  return validateServer({
    name: changes.name ?? current.name,
    type,
    command: changes.command ?? current.command,
    args: changes.args ?? current.args,
    url: changes.url ?? current.url,
    env: type === 'stdio' ? kept : {},
    headers: type === 'http' ? kept : {},
    missing: names.filter((name) => next[name] === undefined),
  }, others)
}

/** Absolute path of `command`, looked up on PATH like a shell would (PATHEXT on Windows), or null. */
export function resolveCommand(command: string, { env = process.env, platform = process.platform, exists = fs.existsSync, extraDirs = [] }: {
  env?: Record<string, string | undefined>, platform?: string, exists?: (file: string) => boolean, extraDirs?: readonly string[],
} = {}): string | null {
  if (path.isAbsolute(command)) return exists(command) ? command : null
  if (/[\\/]/.test(command)) {
    const resolved = path.resolve(command)
    return exists(resolved) ? resolved : null
  }
  const delimiter = platform === 'win32' ? ';' : ':'
  const dirs = [...String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), ...extraDirs]
  const extensions = platform === 'win32'
    ? ['', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())]
    : ['']
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/** Apps started from the Dock or Finder get a short PATH; these are where Node and friends usually live. */
export const EXTRA_COMMAND_DIRS: readonly string[] = Object.freeze(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])

const toPairs = (record: Record<string, string>) => Object.entries(record).map(([name, value]) => ({ name, value }))

/** A server as ACP `session/new` takes it: named, and run as a command or reached over HTTP. */
export type AcpServer = { name: string, [field: string]: any }

/**
 * The servers as ACP `session/new` expects them. A stdio server whose command cannot be found is left
 * out and reported, so one typo doesn't stop the agent from starting.
 */
export function toAcpServers(configs: readonly ServerConfig[], { resolve = resolveCommand }: { resolve?: (command: string) => string | null } = {}): {
  servers: AcpServer[], missing: Array<{ name: string, reason: string }>,
} {
  const missing: Array<{ name: string, reason: string }> = []
  const servers = configs.flatMap((config): AcpServer[] => {
    if (config.type === 'http') return [{ type: 'http', name: config.name, url: config.url, headers: toPairs(config.headers) }]
    const command = resolve(config.command)
    if (!command) {
      missing.push({ name: config.name, reason: t("main.mcp-config.command.not.found", { command: config.command }) })
      return []
    }
    return [{ name: config.name, command, args: config.args, env: toPairs(config.env) }]
  })
  return { servers, missing }
}

/** What the settings page shows: everything except secret values. */
export const serverView = (config: ServerConfig) => ({
  name: config.name,
  type: config.type,
  command: config.command,
  args: config.args,
  url: config.url,
  envNames: Object.keys(config.env),
  headerNames: Object.keys(config.headers),
  missingNames: config.missing,
})

/** A server as kept on disk: its secrets encrypted (base64 of the JSON), or null; the names still missing a value. */
interface StoredServer { name: string, type: 'stdio' | 'http', command?: string, args?: string[], url?: string, secrets?: string | null, missing?: string[] }

export function createMcpConfigStore({ file, crypto, onError = () => {} }: { file: string, crypto: Encryption, onError?: (err: Error) => void }) {
  function readStored(): StoredServer[] {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(data?.servers) ? data.servers : []
    } catch (err: any) {
      if (err.code !== 'ENOENT') onError(err)
      return []
    }
  }

  function decryptSecrets(stored: StoredServer): Pick<ServerConfig, 'env' | 'headers'> {
    if (!stored.secrets) return { env: {}, headers: {} }
    try {
      const secrets = JSON.parse(crypto.decryptString(Buffer.from(stored.secrets, 'base64')))
      return { env: secrets.env ?? {}, headers: secrets.headers ?? {} }
    } catch (err: any) {
      onError(new Error(`could not decrypt the secrets of MCP server "${stored.name}": ${err.message}`))
      return { env: {}, headers: {} }
    }
  }

  /** The servers with their secrets decrypted; only the main process ever holds these. */
  function list(): ServerConfig[] {
    return readStored().map((stored) => ({
      name: stored.name, type: stored.type, command: stored.command ?? '', args: stored.args ?? [], url: stored.url ?? '',
      ...decryptSecrets(stored), missing: Array.isArray(stored.missing) ? stored.missing : [],
    }))
  }

  function encrypt(config: ServerConfig): string | null {
    const hasSecrets = Object.keys(config.env).length > 0 || Object.keys(config.headers).length > 0
    if (!hasSecrets) return null
    if (!crypto.isEncryptionAvailable()) throw new Error(t("main.mcp-config.system.keychain.unavailable.environment.variables.and.headers"))
    return crypto.encryptString(JSON.stringify({ env: config.env, headers: config.headers })).toString('base64')
  }

  function writeAll(configs: readonly ServerConfig[]): void {
    const servers = configs.map((config) => ({
      name: config.name, type: config.type, command: config.command, args: config.args, url: config.url, secrets: encrypt(config),
      ...(config.missing.length ? { missing: config.missing } : {}),
    }))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, servers }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  /** Several at once (an import), in one write: all of them or, past the limit, none. */
  function addMany(configs: readonly ServerConfig[]): void {
    const current = list()
    if (current.length + configs.length > MAX_SERVERS) throw new Error(t("main.mcp-config.up.to.mcp.servers.allowed.currently", { MAX_SERVERS: MAX_SERVERS, length: current.length }))
    writeAll([...current, ...configs])
  }

  const add = (config: ServerConfig): void => addMany([config])

  /** The server named `name` replaced by `config`, in its place in the list. */
  function update(name: string, config: ServerConfig): void {
    const current = list()
    if (!current.some((server) => server.name === name)) throw new Error(t("main.extensions-ipc.no.server.named", { name: name }))
    writeAll(current.map((server) => (server.name === name ? config : server)))
  }

  function remove(name: string): void {
    const current = list()
    const next = current.filter((config) => config.name !== name)
    if (next.length === current.length) throw new Error(t("main.extensions-ipc.no.server.named", { name: name }))
    writeAll(next)
  }

  return { list, add, addMany, update, remove }
}
