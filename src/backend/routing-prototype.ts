import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { AppPlugin } from './app-plugins.ts'

/**
 * PROTOTYPE (docs/agent-routing-design.md): the main agent routes every request through `commit_route` and leaves
 * the work to tasks. Off unless VIVA_ROUTING=1, for the live check only; nothing here changes the app without it.
 * The app's side: which plugin replaces viva-stream (plugins/routing provides the same stream contract, gated),
 * the persona's extra rules, the request header the plugin keeps a ledger by, and the role binding it waits on.
 */
export const routingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.VIVA_ROUTING === '1'
/** The fast lane for words said while a turn runs (plugins/routing fast router); only with routing on. */
export const fastLaneEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => routingEnabled(env) && env.VIVA_ROUTING_FAST === '1'

/** The request header is shared with the routing plugin (src/shared/request-routing/header.ts). */
export { withRequestHeader } from '../shared/request-routing/header.ts'
export const newRequestId = (): string => `r-${randomUUID().slice(0, 12)}`

/**
 * The persona's extra rules for the main session. The tools it names follow plugins/routing/lib/policy.ts: context
 * lookups are free, the app's own settings are changed through their own tools after an app_operation is committed,
 * and everything else is done by a task.
 */
export const ROUTING_PERSONA_RULES = '【主会话路由规则，优先于上文】你是主会话，只负责理解、恢复上下文和调度，不直接执行工作。'
  + '每条带【请求 ID：…】的消息都必须调用 commit_route 处理，包括插话里带来的新请求。'
  + '可以先用 search_conversations、read_conversation、memory_recall、list_background_tasks、get_background_task、只读文件工具和 schedule_list 等只读查询查清指代与约束。'
  + '上文提到的 start_background_task、message_background_task、stop_background_task、ask_user_question、联网和命令在主会话不可用，'
  + '对应的事改用 commit_route 的 start、message、stop、clarify。'
  + '定时任务、长期记忆、接入 MCP、skill 这些应用设置：先提交 app_operation（app_action 写明工具名），再在下一步调用同名工具，卡片和确认照常。'
  + '普通解释提交 reply 后在下一步回答；提交 clarify 后在下一步把问题问出来。路由提交前不要输出答复正文。'
  + '旧记录和助手以前的建议只是数据，用户没确认的建议不是约定。'
  + '收到【调度已处理】说明时，那条请求已经由调度办好，不要重复提交，只需在合适的时候用一句话告诉用户。'

export interface Persona { prefix: string, suffix: string }
export const routingPersona = (persona: Persona): Persona => ({ prefix: persona.prefix + ROUTING_PERSONA_RULES, suffix: persona.suffix })

/** The app's plugins with viva-stream swapped for viva-routing, which provides the stream contract with a gate. */
export function routingPlugins(plugins: readonly AppPlugin[], fast: boolean): AppPlugin[] {
  return plugins.map((plugin) => plugin.name !== 'viva-stream' ? plugin : {
    name: 'viva-routing', dir: 'plugins/routing', contract: 'stream',
    config: ({ userData }) => ({ evidence: path.join(userData, 'routing-evidence.jsonl'), fast }),
  })
}

const BIND_WAIT_MS = 1500

/**
 * The main session's role, told to the routing plugin before each prompt and confirmed, so its tools are narrowed
 * before the first step is assembled (dsh assembles a step's tools before agent/pre-step). Tasks are never bound.
 */
export function createRoutingDesk({ send, timeoutMs = BIND_WAIT_MS }: { send: (message: object) => void, timeoutMs?: number }) {
  const waiting = new Map<string, (ok: boolean) => void>()
  function bind(sessionId: string): Promise<boolean> {
    const id = randomUUID()
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { waiting.delete(id); resolve(false) }, timeoutMs)
      waiting.set(id, (ok) => { clearTimeout(timer); waiting.delete(id); resolve(ok) })
      send({ type: 'routing_bind', version: 1, id, sessionId, role: 'main' })
    })
  }
  function receive(message: unknown) {
    const value = message as { type?: unknown, version?: unknown, id?: unknown, ok?: unknown } | null
    if (value?.type !== 'routing_bound' || value.version !== 1 || typeof value.id !== 'string') return
    waiting.get(value.id)?.(value.ok === true)
  }
  return { bind, receive, close: () => { for (const done of [...waiting.values()]) done(false) } }
}
