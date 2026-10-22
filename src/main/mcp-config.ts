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

/** A server as the main process holds it: its secrets (env, headers) decrypted. */
export interface ServerConfig {
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  headers: Record<string, string>
}

const lines = (text: unknown) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

function requireText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${what}`)
  if (value.length > max) throw new Error(`${what}太长了`)
  return value.trim()
}

/** "KEY=VALUE" per line. */
function parsePairs(text: unknown, { pattern, what }: { pattern: RegExp, what: string }): Record<string, string> {
  const pairs = lines(text).map((line) => {
    const at = line.indexOf('=')
    if (at <= 0) throw new Error(`${what}要写成「名称=值」，每行一个：${line.slice(0, 40)}`)
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (!pattern.test(name)) throw new Error(`${what}名称不合法：${name.slice(0, 40)}`)
    if (value.length > MAX_SECRET_CHARS) throw new Error(`${what}「${name}」的值太长了`)
    return [name, value]
  })
  if (pairs.length > MAX_PAIRS) throw new Error(`${what}最多 ${MAX_PAIRS} 个`)
  const names = pairs.map(([name]) => name)
  if (new Set(names).size !== names.length) throw new Error(`${what}有重复的名称`)
  return Object.fromEntries(pairs)
}

function parseUrl(value: unknown): string {
  const text = requireText(value, '服务器地址', MAX_URL_CHARS)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('服务器地址不是有效的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('服务器地址要以 http:// 或 https:// 开头')
  return url.toString()
}

/**
 * Validates what the settings form sends. Text fields are as typed: arguments one per line,
 * environment variables and headers as "NAME=value" lines.
 * @param input untrusted: each field is checked below
 * @param takenNames names already in use (the memory server's included)
 */
export function parseServerInput(input: any, takenNames: readonly string[]): ServerConfig {
  if (!input || typeof input !== 'object') throw new Error('invalid MCP server')
  const name = requireText(input.name, '名称', 32)
  if (!NAME_PATTERN.test(name)) throw new Error('名称只能用英文字母、数字、- 和 _，最多 32 个字符')
  if (takenNames.some((taken) => taken.toLowerCase() === name.toLowerCase())) throw new Error(`已经有名为「${name}」的服务器了`)
  if (!SERVER_TYPES.includes(input.type)) throw new Error('请选择连接方式')
  if (input.type === 'http') {
    return { name, type: 'http', command: '', args: [], url: parseUrl(input.url), env: {}, headers: parsePairs(input.headers, { pattern: HEADER_NAME_PATTERN, what: '请求头' }) }
  }
  const args = lines(input.args)
  if (args.length > MAX_ARGS || args.some((arg) => arg.length > MAX_ARG_CHARS)) throw new Error('参数太多或太长了')
  return {
    name, type: 'stdio', command: requireText(input.command, '启动命令', MAX_COMMAND_CHARS), args, url: '',
    env: parsePairs(input.env, { pattern: ENV_NAME_PATTERN, what: '环境变量' }), headers: {},
  }
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

/**
 * The servers as ACP `session/new` expects them. A stdio server whose command cannot be found is left
 * out and reported, so one typo doesn't stop the agent from starting.
 */
export function toAcpServers(configs: readonly ServerConfig[], { resolve = resolveCommand }: { resolve?: (command: string) => string | null } = {}): {
  servers: object[], missing: Array<{ name: string, reason: string }>,
} {
  const missing: Array<{ name: string, reason: string }> = []
  const servers = configs.flatMap((config): object[] => {
    if (config.type === 'http') return [{ type: 'http', name: config.name, url: config.url, headers: toPairs(config.headers) }]
    const command = resolve(config.command)
    if (!command) {
      missing.push({ name: config.name, reason: `找不到命令：${config.command}` })
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
})

/** A server as kept on disk: its secrets encrypted (base64 of the JSON), or null. */
interface StoredServer { name: string, type: 'stdio' | 'http', command?: string, args?: string[], url?: string, secrets?: string | null }

export function createMcpConfigStore({ file, crypto, onError = () => {} }: { file: string, crypto: Encryption, onError?: (err: Error) => void }) {
  function readStored(): StoredServer[] {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(data?.servers) ? data.servers : []
    } catch (err) {
      if (err.code !== 'ENOENT') onError(err)
      return []
    }
  }

  function decryptSecrets(stored: StoredServer): Pick<ServerConfig, 'env' | 'headers'> {
    if (!stored.secrets) return { env: {}, headers: {} }
    try {
      const secrets = JSON.parse(crypto.decryptString(Buffer.from(stored.secrets, 'base64')))
      return { env: secrets.env ?? {}, headers: secrets.headers ?? {} }
    } catch (err) {
      onError(new Error(`could not decrypt the secrets of MCP server "${stored.name}": ${err.message}`))
      return { env: {}, headers: {} }
    }
  }

  /** The servers with their secrets decrypted; only the main process ever holds these. */
  function list(): ServerConfig[] {
    return readStored().map((stored) => ({
      name: stored.name, type: stored.type, command: stored.command ?? '', args: stored.args ?? [], url: stored.url ?? '',
      ...decryptSecrets(stored),
    }))
  }

  function encrypt(config: ServerConfig): string | null {
    const hasSecrets = Object.keys(config.env).length > 0 || Object.keys(config.headers).length > 0
    if (!hasSecrets) return null
    if (!crypto.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法安全保存环境变量和请求头')
    return crypto.encryptString(JSON.stringify({ env: config.env, headers: config.headers })).toString('base64')
  }

  function writeAll(configs: readonly ServerConfig[]): void {
    const servers = configs.map((config) => ({
      name: config.name, type: config.type, command: config.command, args: config.args, url: config.url, secrets: encrypt(config),
    }))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, servers }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function add(config: ServerConfig): void {
    const current = list()
    if (current.length >= MAX_SERVERS) throw new Error(`最多添加 ${MAX_SERVERS} 个 MCP 服务器`)
    writeAll([...current, config])
  }

  function remove(name: string): void {
    const current = list()
    const next = current.filter((config) => config.name !== name)
    if (next.length === current.length) throw new Error(`没有名为「${name}」的服务器`)
    writeAll(next)
  }

  return { list, add, remove }
}
