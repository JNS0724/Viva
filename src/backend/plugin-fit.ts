import { evaluatePluginCompatibility, readProfileVersionExemptions } from '@deepseek-ai/dsh-app-boot'

/** A manifest preflight. The installed plugin's loader state is reported separately. */
export const WEB_HOST: readonly string[] = Object.freeze(['@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app'])

export type VivaFit =
  | { kind: 'declared' }
  | { kind: 'no-conflict' }
  | { kind: 'web-part' }
  | { kind: 'needs-web', needs: readonly string[] }
  | { kind: 'dsh-version', current: string, requirements: Readonly<Record<string, string>> }
  | { kind: 'unknown' }

interface FitOptions {
  /** Omit for the bundled dsh. Null for an external dsh whose version is unknown to Viva. */
  runtimeVersion?: string | null
  exemptions?: Readonly<Record<string, readonly string[]>>
}

export function profileFitOptions(profileDir: string): FitOptions {
  if (process.env.DSH_BIN) return { runtimeVersion: null }
  try {
    return { exemptions: readProfileVersionExemptions(profileDir) }
  } catch {
    return { runtimeVersion: null }
  }
}

const record = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

export function vivaFit(manifest: unknown, { runtimeVersion, exemptions }: FitOptions = {}): VivaFit {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { kind: 'unknown' }
  const pkg = record(manifest)
  if (runtimeVersion !== null) {
    try {
      const issue = evaluatePluginCompatibility(pkg, exemptions, runtimeVersion)
      if (issue && !issue.exempted) return { kind: 'dsh-version', current: issue.runtimeVersion, requirements: issue.requirements }
    } catch {
      return { kind: 'unknown' }
    }
  }
  const dependencies = record(pkg.dependencies)
  const optional = record(pkg.optionalDependencies)
  const peers = record(pkg.peerDependencies)
  const peerMeta = record(pkg.peerDependenciesMeta)
  const needs = WEB_HOST.filter(name =>
    (Object.hasOwn(dependencies, name) && !Object.hasOwn(optional, name))
    || (Object.hasOwn(peers, name) && record(peerMeta[name]).optional !== true))
  if (needs.length) return { kind: 'needs-web', needs }
  if (record(pkg.dsh).client) return { kind: 'web-part' }
  if (record(pkg.viva).supports === true) return { kind: 'declared' }
  return { kind: runtimeVersion === null ? 'unknown' : 'no-conflict' }
}

const DISALLOWED_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'commit_route', 'bash', 'shell', 'exec', 'command', 'edit', 'write', 'multi_edit', 'notebook_edit',
  'delete', 'remove', 'patch', 'apply_patch', 'subagent', 'subagent_fork', 'ask_user_question',
  'read', 'glob', 'grep', 'read_image', 'web_fetch', 'web_search',
  'search_conversations', 'read_conversation', 'list_background_tasks', 'get_background_task',
  'memory_recall', 'memory_read', 'memory_node_search', 'memory_remember', 'memory_forget', 'memory_clarify', 'memory_write',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'viva_mcp_add', 'viva_mcp_list', 'viva_mcp_import', 'viva_skill_create', 'viva_skill_list', 'viva_skill_install', 'viva_plugin_install',
])

/**
 * Explicit read-only tools a dsh plugin declares for 动态 data sources in package.json:
 * `"viva": { "feedSource": { "readOnlyTools": [...] } }` or `"viva": { "readOnlyTools": [...] }`.
 * Built-in, write-capable, shell, memory, and app-management tools are always stripped.
 */
export function declaredReadOnlyTools(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return []
  const viva = record(record(manifest).viva)
  const raw = Array.isArray(record(viva.feedSource).readOnlyTools)
    ? record(viva.feedSource).readOnlyTools
    : Array.isArray(viva.readOnlyTools) ? viva.readOnlyTools : []
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const tools: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!name || name.length > 200 || DISALLOWED_SOURCE_TOOLS.has(name) || seen.has(name)) continue
    seen.add(name)
    tools.push(name)
  }
  return tools
}
