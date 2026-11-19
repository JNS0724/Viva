/**
 * What a dsh plugin's package.json says of it working in Viva: only what is known, not a promise. Viva runs dsh's
 * ACP composition (dsh-base and dsh-acp-app), without the browser host dsh's Web app runs: a plugin that needs that
 * host (its HTTP server, or the Web app bundle itself) cannot work here. Nothing else can be told from the manifest
 * alone (a bundle's own patch may still ask for a service Viva does not have), so the rest is "nothing known against
 * it"; whether its rows actually run is the plugin's standing (capabilities-state.ts pluginStanding). A plugin's
 * author can say it supports Viva (`"viva": { "supports": true }`), which is taken as said, not as checked.
 */
export const WEB_HOST: readonly string[] = Object.freeze(['@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-web-app'])

export type VivaFit =
  | { kind: 'declared' }
  | { kind: 'no-conflict' }
  | { kind: 'web-part' }
  | { kind: 'needs-web', needs: readonly string[] }
  | { kind: 'unknown' }

const record = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

export function vivaFit(manifest: unknown): VivaFit {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { kind: 'unknown' }
  const pkg = record(manifest)
  if (record(pkg.viva).supports === true) return { kind: 'declared' }
  const needs = [...Object.keys(record(pkg.dependencies)), ...Object.keys(record(pkg.peerDependencies))].filter((name) => WEB_HOST.includes(name))
  if (needs.length) return { kind: 'needs-web', needs: [...new Set(needs)] }
  return record(pkg.dsh).client ? { kind: 'web-part' } : { kind: 'no-conflict' }
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
