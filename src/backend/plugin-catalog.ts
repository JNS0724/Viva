import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { vivaFit, type VivaFit } from './plugin-fit.ts'

/**
 * The company source's plugins, for 能力 · 插件 · 添加插件 (plugins-ipc.ts): what its search finds, kept to the packages
 * that are dsh plugins (a `dsh.bundle` in their package.json), each with whether it works in Viva (plugin-fit.ts);
 * and, before an install, the same said of the spec the user gave. Both ask the source through the very pnpm dsh's
 * plugin manager installs with (dsh-launch.ts): its token, its scopes pinned to the source, its proxy settings, so
 * what is listed is what can be installed.
 *
 * On Windows that pnpm is a .cmd, run through the shell, which reads its arguments: nothing typed or answered goes on
 * the command line unless it is plain words, package names or exact versions.
 */
export const CATALOG_LIMIT = 20
/** Nothing typed: the word dsh plugins are named by (`dsh-…`, `@scope/dsh-…`). */
export const DEFAULT_QUERY = 'dsh'
const MAX_QUERY_CHARS = 100
const MAX_DESCRIPTION_CHARS = 500
const MAX_DETAIL_CHARS = 300
/** How many package.json lookups run at once. */
const LOOKUPS_AT_ONCE = 4
const PNPM_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

const QUERY_WORD = /^[\p{L}\p{N}@/._-]+$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const MAX_NAME_CHARS = 214
/** An exact version or a dist-tag: no ranges, which a shell would read. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

/** The pnpm the plugin manager installs with: its program, where it runs, its arguments for the source, its environment. */
export interface PnpmCall { command: string, cwd: string, args: readonly string[], env: Readonly<Record<string, string | undefined>> }
/** Runs pnpm with `args` before the call's own; its output, or throws (with the run's `stderr`). */
export type RunPnpm = (call: PnpmCall, args: readonly string[]) => Promise<string>

export interface CatalogEntry { name: string, version: string, description: string | null, fit: VivaFit }
export type CatalogProblem = 'no-source' | 'query' | 'search'
export type CatalogAnswer = { ok: true, entries: CatalogEntry[] } | { ok: false, problem: CatalogProblem, detail: string | null }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const isName = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_NAME_CHARS && PACKAGE_NAME.test(value)
const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value)
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)

/** What a failed run said: its first line of error output, else its message. */
function detailOf(err: unknown): string | null {
  const said = String(record(err).stderr ?? '').split('\n').map((line) => line.trim()).find(Boolean)
  return text(said ?? (err instanceof Error ? err.message : null), MAX_DETAIL_CHARS)
}

/** The words to search with: the default for nothing typed, null for anything a shell could read. */
function keywordsOf(query: string): string[] | null {
  if (query.length > MAX_QUERY_CHARS) return null
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return [DEFAULT_QUERY]
  return words.every((word) => QUERY_WORD.test(word)) ? words : null
}

/** A package's package.json at `spec` (name or name@version), as the source has it; null when it cannot be read. */
async function manifestOf(pnpm: PnpmCall, run: RunPnpm, spec: string): Promise<unknown> {
  try {
    return JSON.parse(await run(pnpm, ['view', spec, '--json', ...pnpm.args]))
  } catch {
    return null
  }
}

/** Runs `work` on each of `items`, at most `limit` at once, the answers in the items' order. */
async function eachAtMost<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const answers: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      answers[index] = await work(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return answers
}

/**
 * The dsh plugins the company source finds for `query`, each with whether it works in Viva. A package whose
 * package.json cannot be read is kept, its fit unknown (installing it still checks it is a plugin); one that can be
 * read and is not a plugin is left out. Null `pnpm`: no company source to ask.
 */
export async function searchCatalog({ query, pnpm, run }: { query: string, pnpm: PnpmCall | null, run: RunPnpm }): Promise<CatalogAnswer> {
  if (!pnpm) return { ok: false, problem: 'no-source', detail: null }
  const keywords = keywordsOf(query)
  if (!keywords) return { ok: false, problem: 'query', detail: null }
  let found: unknown
  try {
    found = JSON.parse(await run(pnpm, ['search', ...keywords, '--json', '--search-limit', String(CATALOG_LIMIT), ...pnpm.args]))
  } catch (err) {
    return { ok: false, problem: 'search', detail: detailOf(err) }
  }
  const seen = new Set<string>()
  const candidates = (Array.isArray(found) ? found : []).map(record).filter((item) => {
    if (!isName(item.name) || !isVersion(item.version) || seen.has(item.name)) return false
    seen.add(item.name)
    return true
  }).slice(0, CATALOG_LIMIT)
  const looked = await eachAtMost(candidates, LOOKUPS_AT_ONCE, async (item) => {
    const name = item.name as string, version = item.version as string
    const manifest = await manifestOf(pnpm, run, `${name}@${version}`)
    if (manifest !== null && record(record(manifest).dsh).bundle === undefined) return null
    const description = text(item.description, MAX_DESCRIPTION_CHARS) ?? text(record(manifest).description, MAX_DESCRIPTION_CHARS)
    return { name, version, description, fit: manifest === null ? { kind: 'unknown' as const } : vivaFit(manifest) }
  })
  return { ok: true, entries: looked.filter((entry): entry is CatalogEntry => entry !== null) }
}

/**
 * Whether what `spec` names works in Viva, before it is installed: a registry name (or name@version) by its
 * package.json on the source, a folder by its own; a git address, a tarball or a version range is not looked up.
 */
export async function specFit({ spec, pnpm, run }: { spec: string, pnpm: PnpmCall | null, run: RunPnpm }): Promise<VivaFit> {
  const given = spec.trim()
  if (path.isAbsolute(given)) {
    try {
      return vivaFit(JSON.parse(fs.readFileSync(path.join(given, 'package.json'), 'utf8')))
    } catch {
      return { kind: 'unknown' }
    }
  }
  const at = given.lastIndexOf('@')
  const [name, version] = at > 0 ? [given.slice(0, at), given.slice(at + 1)] : [given, null]
  if (!pnpm || !isName(name) || (version !== null && !isVersion(version))) return { kind: 'unknown' }
  const manifest = await manifestOf(pnpm, run, given)
  return manifest === null ? { kind: 'unknown' } : vivaFit(manifest)
}

/** pnpm run for real: a .cmd on Windows only through the shell, its path quoted (as plugin-registry.ts pnpmScopes). */
export function pnpmRunner({ platform = process.platform, timeoutMs = PNPM_TIMEOUT_MS }: { platform?: string, timeoutMs?: number } = {}): RunPnpm {
  const run = promisify(execFile)
  return async (call, args) => {
    const shell = platform === 'win32'
    const { stdout } = await run(shell ? `"${call.command}"` : call.command, [...args], {
      cwd: call.cwd, env: { ...call.env }, shell, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true,
    })
    return stdout
  }
}
