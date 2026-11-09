/**
 * Which tools the main agent has, in layers (docs/agent-routing-design.md §17). Its scope holds the first four; the
 * guard repeats the decision at execution, since a scope can still gain tools (a plugin registering on the agent).
 *
 *   route       commit_route: every request goes through it
 *   context     read-only lookups for understanding a request
 *   app-query   read-only views of the app's own settings
 *   app-change  the app's own settings changed through their own tools (cards, approvals, key windows stay theirs);
 *               each call needs a grant from a committed app_action of the same request
 *   execution   everything else (shell, files, web, sub-agents, MCP servers' tools, the background-task tools):
 *               out of scope; such work goes to a task through commit_route
 */
import { APP_OPERATIONS, type AppOperation } from '../../../src/shared/request-routing/protocol.ts'

export type { AppOperation }
export const ROUTE_TOOL = 'commit_route'
export const CONTEXT_TOOLS = Object.freeze(['search_conversations', 'read_conversation', 'memory_recall', 'list_background_tasks', 'get_background_task', 'read', 'glob', 'grep', 'read_image'] as const)
export const APP_QUERY_TOOLS = Object.freeze(['schedule_list', 'viva_mcp_list', 'viva_skill_list'] as const)
export const APP_CHANGE_TOOLS: readonly AppOperation[] = APP_OPERATIONS

export type ToolLayer = 'route' | 'context' | 'app-query' | 'app-change' | 'execution'

const LAYERS: ReadonlyMap<string, ToolLayer> = new Map<string, ToolLayer>([
  [ROUTE_TOOL, 'route'],
  ...CONTEXT_TOOLS.map((name) => [name, 'context'] as const),
  ...APP_QUERY_TOOLS.map((name) => [name, 'app-query'] as const),
  ...APP_CHANGE_TOOLS.map((name) => [name, 'app-change'] as const),
])

export const layerOf = (tool: string): ToolLayer => LAYERS.get(tool) ?? 'execution'

/** The main agent's scope: every layer but execution. */
export const MAIN_SCOPE: readonly string[] = Object.freeze([...LAYERS.keys()])

export const isAppOperation = (name: string): name is AppOperation => layerOf(name) === 'app-change'

/** Leave for one call of an app tool, given by a committed app_action. */
export interface Grant { readonly requestId: string, readonly operation: AppOperation }

/**
 * The guard's decision on one call of the main agent, and the grants left after it: a grant is used up by the call
 * it allows, so one committed app_action allows exactly one change.
 */
export function admit(grants: readonly Grant[], tool: string): { allowed: boolean, grants: readonly Grant[], reason?: string } {
  const layer = layerOf(tool)
  if (layer === 'route' || layer === 'context' || layer === 'app-query') return { allowed: true, grants }
  if (layer === 'execution') return { allowed: false, grants, reason: '主会话只恢复上下文和调度；要做的事用 commit_route 交给任务' }
  const index = grants.findIndex((grant) => grant.operation === tool)
  if (index < 0) return { allowed: false, grants, reason: `先用 commit_route 提交 app_operation（operation=${tool}），再调用 ${tool}` }
  return { allowed: true, grants: [...grants.slice(0, index), ...grants.slice(index + 1)] }
}
