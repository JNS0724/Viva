import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import YAML from 'yaml'
import { type ServerConfig, validateServer } from './mcp-config.ts'

/**
 * The MCP servers of the user's own dsh, read so Viva can take them over with their keys. dsh keeps them as
 * `@deepseek-ai/dsh-mcp-client` entries in a profile's entry list: `profiles/<p>/cordis.yml` (usually an empty
 * root), then that profile's `cordis.patch.yml`, then the home's `cordis.patch.yml`, each a list of patches that
 * insert entries or override one by id. A key is written either as it is or as a `!!js` expression; Viva reads
 * the expressions that only name environment variables (as dsh would see them: the terminal's environment,
 * then the home's `.env`) and never runs anything else. A key it cannot read comes over as missing, by name.
 */
const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'
const TRANSPORTS: Readonly<Record<string, ServerConfig['type']>> = { stdio: 'stdio', 'streamable-http': 'http' }
const SHELL_ENV_TIMEOUT_MS = 5000
const SHELL_ENV_MAX_BYTES = 1024 * 1024
const ENV_MARK = '__VIVA_ENV__'

/** What a `!!js` scalar is read as: its source, kept unevaluated. */
type Expression = { js: string }
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (source: string): Expression => ({ js: source }) }
const isExpression = (value: unknown): value is Expression => typeof value === 'object' && value !== null && typeof (value as Expression).js === 'string'

export type EnvLookup = (name: string) => string | undefined

/** The dsh home the user's own `dsh` uses: DSH_HOME, else ~/.dsh. */
export const userDshHome = (env: Record<string, string | undefined> = process.env, home = os.homedir()): string =>
  (env.DSH_HOME ? path.resolve(env.DSH_HOME) : path.join(home, '.dsh'))

const ENV_NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*`
const ENV_REF = String.raw`process\.env(?:\.(${ENV_NAME})|\[\s*(['"])(${ENV_NAME})\2\s*\])`
const ONLY_REF = new RegExp(`^${ENV_REF}$`)
const REF_WITH_DEFAULT = new RegExp(String.raw`^${ENV_REF}\s*(?:\?\?|\|\|)\s*(['"])(.*)\4$`, 's')
const STRING_LITERAL = /^(['"])((?:(?!\1)[^\\]|\\.)*)\1$/s
const TEMPLATE_PART = /\$\{([^}]*)\}/g

const refName = (match: RegExpMatchArray) => match[1] ?? match[3]
/** An unset variable and an empty one are alike: neither gives a key. */
const lookupValue = (lookup: EnvLookup, name: string) => lookup(name) || undefined

/**
 * The value of a `!!js` expression when it only reads environment variables: `process.env.X`, a string literal,
 * `process.env.X ?? 'default'`, or a template of literal text and `${process.env.X}`. Anything else is not
 * evaluated, and gives undefined.
 */
export function resolveExpression(source: string, lookup: EnvLookup): string | undefined {
  const expression = source.trim()
  const ref = expression.match(ONLY_REF)
  if (ref) return lookupValue(lookup, refName(ref))
  const withDefault = expression.match(REF_WITH_DEFAULT)
  if (withDefault) return lookupValue(lookup, refName(withDefault)) ?? withDefault[5]
  const literal = expression.match(STRING_LITERAL)
  if (literal) return literal[2]
  if (!expression.startsWith('`') || !expression.endsWith('`') || expression.length < 2) return undefined
  let complete = true
  const text = expression.slice(1, -1).replace(TEMPLATE_PART, (_whole, inner: string) => {
    const part = inner.trim().match(ONLY_REF)
    const value = part ? lookupValue(lookup, refName(part)) : undefined
    if (value === undefined) complete = false
    return value ?? ''
  })
  return complete && !text.includes('`') ? text : undefined
}

/** A plain value as it is; an expression as resolveExpression reads it. */
function valueOf(raw: unknown, lookup: EnvLookup): string | undefined {
  if (isExpression(raw)) return resolveExpression(raw.js, lookup)
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return undefined
}

/** A profile entry, as far as this reads it. */
type Entry = { id?: string, name?: string, config?: any, group?: boolean, disabled?: boolean | null }

function readList(file: string): unknown[] | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const data = YAML.parse(text, { customTags: [JS_TAG] })
  if (data === null || data === undefined) return []
  if (!Array.isArray(data)) throw new Error('not a list')
  return data
}

/**
 * The entries of one profile once its layers are applied: the root list, then each patch list in order. Groups
 * are walked into; a patch's `insert` adds entries, one naming an id replaces that entry's config or disables it.
 */
function profileEntries(layers: ReadonlyArray<{ kind: 'root' | 'patch', list: readonly unknown[] }>): Entry[] {
  const byId = new Map<string, Entry>()
  const entries: Entry[] = []
  const add = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const entry = { ...(raw as Entry) }
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(add)
    entries.push(entry)
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  for (const { kind, list } of layers) {
    for (const item of list) {
      if (kind === 'root') {
        add(item)
        continue
      }
      if (!item || typeof item !== 'object') continue
      const patch = item as Entry & { insert?: unknown }
      if (Array.isArray(patch.insert)) patch.insert.forEach(add)
      const target = typeof patch.id === 'string' ? byId.get(patch.id) : undefined
      if (!target) continue
      if ('config' in patch) target.config = patch.config
      if (patch.disabled !== undefined) target.disabled = patch.disabled
    }
  }
  return entries
}

/** The key/value pairs of `env` or `headers`: those Viva could read, and the names of the rest. */
function pairsOf(raw: unknown, lookup: EnvLookup): { values: Record<string, string>, missing: string[] } {
  const values: Record<string, string> = {}
  const missing: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { values, missing }
  for (const [name, value] of Object.entries(raw)) {
    const read = valueOf(value, lookup)
    if (read === undefined || read === '') missing.push(name)
    else values[name] = read
  }
  return { values, missing }
}

/** One dsh-mcp-client config as a Viva server, or why it cannot be one. */
function serverOf(config: any, lookup: EnvLookup): ServerConfig {
  const name = String(config?.serverName ?? '')
  const type = TRANSPORTS[config?.transport]
  if (!type) throw new Error(`不支持的连接方式：${String(config?.transport).slice(0, 40)}`)
  const field = (raw: unknown, what: string) => {
    if (raw === undefined || raw === null) return ''
    const value = valueOf(raw, lookup)
    if (value === undefined) throw new Error(`${what}用了 Viva 读不懂的写法`)
    return value
  }
  if (type === 'http') {
    const { values, missing } = pairsOf(config.headers, lookup)
    return validateServer({ name, type, command: '', args: [], url: field(config.url, '服务器地址'), env: {}, headers: values, missing }, [])
  }
  const args = Array.isArray(config.args) ? config.args.map((arg: unknown) => field(arg, '启动参数')) : []
  const { values, missing } = pairsOf(config.env, lookup)
  return validateServer({ name, type, command: field(config.command, '启动命令'), args, url: '', env: values, headers: {}, missing }, [])
}

const isDir = (dir: string) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false

/**
 * The MCP servers configured in a dsh home, each once (the first profile naming it wins), and the entries that
 * could not be taken, with why. Throws only when the folder is missing or plainly not a dsh home.
 */
export function readDshMcpServers(dshHome: string, { lookup }: { lookup: EnvLookup }): {
  servers: ServerConfig[], problems: Array<{ name: string, reason: string }>,
} {
  if (!isDir(dshHome)) throw new Error(`找不到文件夹：${dshHome}`)
  const profilesDir = path.join(dshHome, 'profiles')
  const homePatch = path.join(dshHome, 'cordis.patch.yml')
  if (!isDir(profilesDir) && !fs.existsSync(homePatch)) throw new Error(`这个文件夹不像 dsh 的文件夹（里面没有 profiles）：${dshHome}`)

  const problems: Array<{ name: string, reason: string }> = []
  const layer = (file: string, kind: 'root' | 'patch') => {
    try {
      const list = readList(file)
      return list ? [{ kind, list }] : []
    } catch (err: any) {
      problems.push({ name: path.relative(dshHome, file), reason: `读不懂这个文件：${String(err.message).split('\n')[0]}` })
      return []
    }
  }
  const home = layer(homePatch, 'patch')
  const profiles = isDir(profilesDir) ? fs.readdirSync(profilesDir).filter((name) => isDir(path.join(profilesDir, name))).sort() : []

  const servers = new Map<string, ServerConfig>()
  const reported = new Set<string>()
  for (const profile of profiles) {
    const dir = path.join(profilesDir, profile)
    const entries = profileEntries([...layer(path.join(dir, 'cordis.yml'), 'root'), ...layer(path.join(dir, 'cordis.patch.yml'), 'patch'), ...home])
    for (const entry of entries) {
      if (entry.name !== MCP_PLUGIN || entry.disabled) continue
      const name = String(entry.config?.serverName ?? entry.id ?? '')
      if (servers.has(name) || reported.has(name)) continue
      try {
        servers.set(name, serverOf(entry.config, lookup))
      } catch (err: any) {
        reported.add(name)
        problems.push({ name, reason: err.message })
      }
    }
  }
  return { servers: [...servers.values()], problems }
}

/**
 * How dsh would find an environment variable: the environment it is started with (the terminal's, which an app
 * opened from the Dock does not have, so it is read from the login shell), then the home's `.env`.
 */
export function envLookup({ dshHome, shellEnv, processEnv }: {
  dshHome: string, shellEnv: Record<string, string | undefined>, processEnv: Record<string, string | undefined>,
}): EnvLookup {
  let dotEnv: Record<string, string | undefined> = {}
  try {
    dotEnv = parseEnv(fs.readFileSync(path.join(dshHome, '.env'), 'utf8'))
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
  }
  return (name) => shellEnv[name] || processEnv[name] || dotEnv[name] || undefined
}

/** What an import did: the servers added (with the keys they still miss), names skipped as in use, entries refused. */
export interface ImportResult {
  dir: string
  added: Array<{ name: string, missing: string[] }>
  skipped: string[]
  problems: Array<{ name: string, reason: string }>
}

/**
 * Takes the servers of the dsh home at `dir` over into the store, all in one write. A server whose name is
 * already in use (in any case) is left alone: what the user set up in Viva wins.
 */
export async function importDshServers({ dir, store, takenNames, shellEnv = () => loginShellEnv(), processEnv = process.env }: {
  dir: string,
  store: { addMany: (configs: readonly ServerConfig[]) => void },
  takenNames: () => readonly string[],
  shellEnv?: () => Promise<Record<string, string | undefined>>,
  processEnv?: Record<string, string | undefined>,
}): Promise<ImportResult> {
  const lookup = envLookup({ dshHome: dir, shellEnv: await shellEnv(), processEnv })
  const { servers, problems } = readDshMcpServers(dir, { lookup })
  const taken = new Set(takenNames().map((name) => name.toLowerCase()))
  const fresh = servers.filter((server) => !taken.has(server.name.toLowerCase()))
  if (fresh.length) store.addMany(fresh)
  return {
    dir,
    added: fresh.map((server) => ({ name: server.name, missing: server.missing })),
    skipped: servers.filter((server) => taken.has(server.name.toLowerCase())).map((server) => server.name),
    problems,
  }
}

/** A folder as the user names it (`~/work/.dsh` included), made absolute. */
export const expandHome = (dir: string, home = os.homedir()): string =>
  path.resolve(dir === '~' ? home : /^~[\\/]/.test(dir) ? path.join(home, dir.slice(2)) : dir)

/** A path under the home folder written from ~, as people say it. */
export function shortPath(file: string, home = os.homedir()): string {
  const relative = path.relative(home, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join('~', relative) : file
}

/**
 * What an import did, in a few sentences: for the settings page, or (forModel) for the model to tell the user,
 * which also says when it takes effect. Names only: no key's value is ever in it.
 */
export function importSummary(result: ImportResult, { home = os.homedir(), forModel = false } = {}): string {
  const where = shortPath(result.dir, home)
  if (!result.added.length && !result.skipped.length && !result.problems.length) return `在 ${where} 里没有找到 MCP 服务器。`
  const names = (list: readonly string[]) => list.join('、')
  const lacking = result.added.filter((server) => server.missing.length)
  const fill = forModel ? '用户可以在 设置 → 扩展 里点「编辑」补上' : '点「编辑」补上就能连接'
  return [
    result.added.length
      ? `已从 ${where} 导入 ${result.added.length} 个：${names(result.added.map((server) => server.name))}${forModel ? '，这一轮结束后生效' : ''}。`
      : '没有新的服务器可以导入。',
    result.skipped.length ? `跳过 ${result.skipped.length} 个重名的（${names(result.skipped)}）。` : '',
    ...lacking.map((server) => `${server.name} 还缺 ${names(server.missing)}，${fill}。`),
    result.problems.length ? `没能导入：${result.problems.map((problem) => `${problem.name}（${problem.reason}）`).join('；')}。` : '',
    forModel && result.added.length ? '密钥已加密保存在这台电脑上，你看不到它们的值。' : '',
  ].join('')
}

/** `env -0` output: NAME=value records ended by NUL. */
export function parseShellEnv(output: string): Record<string, string> {
  return Object.fromEntries(output.split('\0').flatMap((record) => {
    const at = record.indexOf('=')
    return at > 0 ? [[record.slice(0, at), record.slice(at + 1)]] : []
  }))
}

/**
 * The login shell's environment, where the user's tokens are usually exported. Empty on Windows, where apps get
 * the user's variables anyway, and when the shell cannot be run or takes too long.
 */
export function loginShellEnv({ platform = process.platform, shell = process.env.SHELL } = {}): Promise<Record<string, string>> {
  if (platform === 'win32') return Promise.resolve({})
  return new Promise((resolve) => {
    execFile(shell || '/bin/zsh', ['-ilc', `printf '${ENV_MARK}'; env -0`], { timeout: SHELL_ENV_TIMEOUT_MS, maxBuffer: SHELL_ENV_MAX_BYTES }, (err, stdout) => {
      const at = stdout ? stdout.indexOf(ENV_MARK) : -1
      if (err || at < 0) return resolve({})
      resolve(parseShellEnv(stdout.slice(at + ENV_MARK.length)))
    })
  })
}
