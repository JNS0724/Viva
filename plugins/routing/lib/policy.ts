/**
 * Which tools the main agent has, in layers (docs/agent-routing-design.md §6.1). Its scope holds the first five; every
 * call is decided again before dsh's approval (tools/pre-execute), since a call outside the scope still reaches
 * approval by its name and a scope can still gain tools (a plugin registering on the agent).
 *
 *   route       commit_route: every request goes through it
 *   context     read-only history, memory, and task lookups for understanding a request
 *   dir-peek    filename-only directory listing (glob): at most once before routing to resolve ambiguous file targets
 *   peek        lightweight file/image inspection (read, grep, read_image): only after an accepted reply, bounded count
 *   app-query   read-only views of the app's own settings
 *   app-change  the app's own settings changed through their own tools (cards, approvals, key windows stay theirs);
 *               each call needs a grant from an accepted app_action
 *   execution   everything else (shell, edits/writes, web, sub-agents, MCP servers' tools): out of scope; such work
 *               goes to a task through commit_route
 */
import { APP_OPERATIONS, parsePlan, type AppOperation } from '../../../src/shared/request-routing/protocol.ts'

export const ROUTE_TOOL = 'commit_route'
export const CONTEXT_TOOLS = Object.freeze(['search_conversations', 'read_conversation', 'memory_recall', 'memory_read', 'memory_node_search', 'list_background_tasks', 'get_background_task'] as const)
export const DIR_PEEK_TOOLS = Object.freeze(['glob'] as const)
export const PEEK_TOOLS = Object.freeze(['read', 'grep', 'read_image'] as const)
export const APP_QUERY_TOOLS = Object.freeze(['schedule_list', 'viva_mcp_list', 'viva_skill_list'] as const)

export const PRE_ROUTE_GLOB_LIMIT = 1
export const DIR_PEEK_PER_REPLY = 2
export const DIR_PEEK_TURN_CAP = 3
export const PEEK_PER_REPLY = 2
export const PEEK_TURN_CAP = 3

export type ToolLayer = 'route' | 'context' | 'dir-peek' | 'peek' | 'app-query' | 'app-change' | 'execution'

const LAYERS: ReadonlyMap<string, ToolLayer> = new Map<string, ToolLayer>([
  [ROUTE_TOOL, 'route'],
  ...CONTEXT_TOOLS.map((name) => [name, 'context'] as const),
  ...DIR_PEEK_TOOLS.map((name) => [name, 'dir-peek'] as const),
  ...PEEK_TOOLS.map((name) => [name, 'peek'] as const),
  ...APP_QUERY_TOOLS.map((name) => [name, 'app-query'] as const),
  ...APP_OPERATIONS.map((name) => [name, 'app-change'] as const),
])

export const layerOf = (tool: string): ToolLayer => LAYERS.get(tool) ?? 'execution'

/** The main agent's scope: every layer but execution. */
export const MAIN_SCOPE: readonly string[] = Object.freeze([...LAYERS.keys()])

/** Leave for one call of an app tool, given by an accepted app_action. */
export type Grant = AppOperation

/** Immutable per-turn grant ledger for app operations, pre-route/post-reply filename listing, and post-reply file peeks. */
export interface TurnGrants {
  readonly app: readonly Grant[]
  readonly preRouteGlob: number
  readonly dirPeek: number
  readonly dirPeekGranted: number
  readonly peek: number
  readonly peekGranted: number
}

export const INITIAL_TURN_GRANTS: TurnGrants = Object.freeze({
  app: Object.freeze([]),
  preRouteGlob: PRE_ROUTE_GLOB_LIMIT,
  dirPeek: 0,
  dirPeekGranted: 0,
  peek: 0,
  peekGranted: 0,
})

/**
 * The app operations an accepted plan allows, read as the host read it (parsePlan, which also names an action whose
 * kind was left out): one grant per app_action, for one call of its tool.
 */
export function grantsOf(plan: unknown): Grant[] {
  const parsed = parsePlan(plan)
  return 'plan' in parsed ? parsed.plan.actions.flatMap(action => action.kind === 'app_action' ? [action.operation] : []) : []
}

/** Updates the turn's grants from an accepted plan: app_actions grant their tools, and reply grants bounded peeks. */
export function grantPlan(current: TurnGrants, plan: unknown): TurnGrants {
  const parsed = parsePlan(plan)
  if (!('plan' in parsed)) return current
  const addedApp = parsed.plan.actions.flatMap(action => action.kind === 'app_action' ? [action.operation] : [])
  const hasReply = parsed.plan.actions.some(action => action.kind === 'reply')
  const usedPreRoute = PRE_ROUTE_GLOB_LIMIT - current.preRouteGlob
  const addedDirPeek = hasReply ? Math.max(0, Math.min(DIR_PEEK_PER_REPLY, DIR_PEEK_TURN_CAP - usedPreRoute - current.dirPeekGranted)) : 0
  const addedPeek = hasReply ? Math.max(0, Math.min(PEEK_PER_REPLY, PEEK_TURN_CAP - current.peekGranted)) : 0
  if (!addedApp.length && addedDirPeek === 0 && addedPeek === 0) return current
  return Object.freeze({
    ...current,
    app: addedApp.length ? Object.freeze([...current.app, ...addedApp]) : current.app,
    dirPeek: current.dirPeek + addedDirPeek,
    dirPeekGranted: current.dirPeekGranted + addedDirPeek,
    peek: current.peek + addedPeek,
    peekGranted: current.peekGranted + addedPeek,
  })
}

/**
 * The guard's decision on one call of the main agent, and the grants left after it:
 * - dir-peek (glob) may run at most once while a request is pending, or up to DIR_PEEK_PER_REPLY times after reply without draining content peeks;
 * - peek (read, grep, read_image) requires no pending undecided request and consumes one post-reply peek grant;
 * - app-change consumes one matching app_action grant.
 */
export function admit(state: TurnGrants, tool: string, { hasPending = false }: { hasPending?: boolean } = {}): {
  allowed: boolean, state: TurnGrants, reason?: string,
} {
  const layer = layerOf(tool)
  if (layer === 'route' || layer === 'context' || layer === 'app-query') return { allowed: true, state }
  if (layer === 'execution') return { allowed: false, state, reason: '主会话只恢复上下文和调度；要做的事用 commit_route 交给任务' }
  if (layer === 'dir-peek') {
    if (!hasPending && state.dirPeek > 0) {
      return { allowed: true, state: Object.freeze({ ...state, dirPeek: state.dirPeek - 1 }) }
    }
    const usedPreRoute = PRE_ROUTE_GLOB_LIMIT - state.preRouteGlob
    if (hasPending && state.preRouteGlob > 0 && usedPreRoute + state.dirPeekGranted < DIR_PEEK_TURN_CAP) {
      return { allowed: true, state: Object.freeze({ ...state, preRouteGlob: state.preRouteGlob - 1 }) }
    }
    return {
      allowed: false,
      state,
      reason: hasPending
        ? '路由前最多调用 1 次 glob 查看文件名；若名称可能是旧对话里的代号或约定可查 search_conversations / memory_recall，否则请调用 commit_route 提交路由'
        : '主会话目录列表查看次数已用完；若文件名对不上用户说的名称或代号，请先用 search_conversations / memory_recall 查旧对话里的对应关系，确认文件名后再用 read 读取，或告知用户交给后台任务',
    }
  }
  if (layer === 'peek') {
    if (hasPending) {
      return {
        allowed: false,
        state,
        reason: '路由前不可读取或搜索文件内容；若名称可能是旧对话或记忆里的代号/约定请先查 search_conversations / memory_recall，否则请先调用 commit_route（单点速查提交 reply 后再读取，多文件或修改工作直接提交 start 交给后台任务）',
      }
    }
    if (state.peek <= 0) {
      return {
        allowed: false,
        state,
        reason: `主会话速查额度已用完（每次回复最多 ${PEEK_PER_REPLY} 次）；请直接基于已读内容如实回答，并告知用户如需完整排查可交给后台任务`,
      }
    }
    return { allowed: true, state: Object.freeze({ ...state, peek: state.peek - 1 }) }
  }
  const index = state.app.indexOf(tool as Grant)
  if (index < 0) return { allowed: false, state, reason: `先用 commit_route 提交 app_operation（operation=${tool}），再调用 ${tool}` }
  return {
    allowed: true,
    state: Object.freeze({ ...state, app: Object.freeze([...state.app.slice(0, index), ...state.app.slice(index + 1)]) }),
  }
}

/** Built-in, write-capable, shell, or app-management tools that a data source session may never invoke. */
export const FORBIDDEN_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  ROUTE_TOOL,
  ...CONTEXT_TOOLS,
  ...DIR_PEEK_TOOLS,
  ...PEEK_TOOLS,
  ...APP_QUERY_TOOLS,
  ...APP_OPERATIONS,
  'bash', 'shell', 'exec', 'command', 'edit', 'write', 'multi_edit', 'notebook_edit', 'delete', 'remove',
  'patch', 'apply_patch', 'subagent', 'subagent_fork', 'ask_user_question',
  'memory_remember', 'memory_forget', 'memory_clarify', 'memory_write',
  'web_fetch', 'web_search',
])

/** Enforces that a plugin data source session only executes explicitly allowlisted read-only tools. */
export function admitFeedSource(allowed: ReadonlySet<string>, tool: string): { allowed: boolean, reason?: string } {
  if (FORBIDDEN_SOURCE_TOOLS.has(tool) || !allowed.has(tool)) {
    return { allowed: false, reason: `数据源会话仅允许调用所选插件明确声明的只读工具；已拒绝 ${tool}` }
  }
  return { allowed: true }
}
