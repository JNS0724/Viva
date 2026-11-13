/**
 * Which tools may be a source: those a plugin or MCP server added, not dsh's or Viva's own, and none whose name says
 * it changes something. dsh does not say whether a tool only reads (MCP's readOnlyHint does not reach it), so this is
 * a first filter only: the user confirms each one before it is called, and again before it runs on a timer.
 */

/** dsh's and Viva's own tools, by exact name. */
const BUILT_IN: ReadonlySet<string> = new Set([
  'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'bash', 'pwsh', 'read_image', 'working_directory', 'skill', 'workflow',
  'web_search', 'web_fetch', 'todo_write', 'exit_plan_mode', 'plugin_manager', 'ask_user_question',
  'get_goal', 'create_goal', 'update_goal', 'subagent', 'subagent_fork',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'search_conversations', 'read_conversation',
  'list_background_tasks', 'get_background_task', 'memory_remember', 'memory_recall', 'memory_forget', 'commit_route',
  'cordis_inspect_list', 'cordis_inspect_query', 'create_worktree',
  // dsh's MCP resource browser: it reads any server's resources, not one kind of message.
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
])
/** Prefixes of whole families of built-in tools. */
const BUILT_IN_PREFIXES = ['viva_', 'subagent_', 'team_', 'job_', 'terminal_']

/** Verbs that mean a change, as a word of the tool's own name (after an MCP server's prefix). */
const CHANGES = /(^|[_\-.])(send|delete|remove|create|update|write|post|put|patch|close|archive|move|mark|reply|forward|set|add|edit|upload|approve|reject|merge|comment|assign|invite|cancel|publish|submit|transfer|pay|run|exec|execute|start|stop|kill|restart|install|uninstall|enable|disable)($|[_\-.])/i

/** The tool's own name: an MCP tool's after its server. */
export const ownName = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : tool)

export function isBuiltIn(tool: string): boolean {
  return BUILT_IN.has(tool) || BUILT_IN_PREFIXES.some((prefix) => tool.startsWith(prefix))
}

/** Its name says it changes something. */
export const soundsLikeChange = (tool: string) => CHANGES.test(ownName(tool))

export type Candidacy = { ok: true } | { ok: false, reason: 'built-in' | 'changes' }

export function candidacy(tool: string): Candidacy {
  if (isBuiltIn(tool)) return { ok: false, reason: 'built-in' }
  if (soundsLikeChange(tool)) return { ok: false, reason: 'changes' }
  return { ok: true }
}
