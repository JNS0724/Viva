/** The routing decision the main agent commits (docs/agent-routing-design.md §6), v2: goals with dispositions. */
import { z } from 'zod'

export const DISPOSITIONS = ['answer', 'delegate', 'update_task', 'stop_task', 'needs_input', 'app_operation'] as const
export type Disposition = (typeof DISPOSITIONS)[number]
export type ActionKind = 'reply' | 'start' | 'message' | 'stop' | 'clarify' | 'app_action'
const ACTION_OF: Readonly<Record<Disposition, ActionKind>> = Object.freeze({ answer: 'reply', delegate: 'start', update_task: 'message', stop_task: 'stop', needs_input: 'clarify', app_operation: 'app_action' })

/**
 * The app's own capabilities the main agent may ask for: a closed set, each done through the app's existing tool
 * (its checks, cards and confirmation), never a free tool name, code or command.
 */
export const APP_OPERATIONS = ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'memory_remember', 'memory_forget',
  'viva_mcp_add', 'viva_mcp_update', 'viva_mcp_remove', 'viva_mcp_import', 'viva_skill_create'] as const
export type AppOperation = (typeof APP_OPERATIONS)[number]

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), scope: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('start'), brief: z.string().min(20).max(6000), evidenceIds: z.array(z.string().max(300)).max(20).optional() }),
  z.object({ kind: z.literal('message'), taskId: z.string().min(1).max(200), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal('stop'), taskId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('clarify'), question: z.string().min(4).max(800), options: z.array(z.string().max(200)).max(6).optional() }),
  z.object({ kind: z.literal('app_action'), operation: z.enum(APP_OPERATIONS), args: z.record(z.string(), z.unknown()) }),
])
export const goalSchema = z.object({ goal: z.string().min(1).max(500), disposition: z.enum(DISPOSITIONS) })
export const planSchema = z.object({ goals: z.array(goalSchema).min(1).max(6), actions: z.array(actionSchema).min(1).max(5) })
export type Action = z.infer<typeof actionSchema>
export type Plan = z.infer<typeof planSchema>

/** Goals and actions must agree both ways; the problem, said to the model, or null. */
export function planProblem(plan: Plan): string | null {
  const kinds = new Set<ActionKind>(plan.actions.map(action => action.kind))
  const missing = plan.goals.find(goal => !kinds.has(ACTION_OF[goal.disposition]))
  if (missing) return `目标「${missing.goal}」标为 ${missing.disposition}，但没有对应的 ${ACTION_OF[missing.disposition]} 动作`
  const wanted = new Set<ActionKind>(plan.goals.map(goal => ACTION_OF[goal.disposition]))
  const extra = [...kinds].find(kind => !wanted.has(kind))
  return extra ? `动作 ${extra} 没有对应的目标` : null
}

/** Parses what the model passed; the plan, or the problem to say back. */
export function parsePlan(raw: unknown): { plan: Plan } | { problem: string } {
  const parsed = planSchema.safeParse(raw)
  if (!parsed.success) return { problem: '路由不合法：' + parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ') }
  const problem = planProblem(parsed.data)
  return problem ? { problem } : { plan: parsed.data }
}

export const COMMIT_DESCRIPTION = [
  '当前请求的唯一处理出口，每个【请求 ID】都要提交一次。先把用户这句话里的每个目标列进 goals，并给出去向：',
  'answer=你在主会话里直接回答（解释、短问答）；delegate=交给新的独立任务完成（调研、整理资料、完整报告、写文件、命令）；',
  'update_task=补充或修改已有任务；stop_task=停止已有任务；needs_input=缺少只有用户能给的信息或必须由用户在多个对象中选择；',
  `app_operation=应用自己的设置：定时任务、长期记忆、接入 MCP 或存 skill，用 app_action 提交 operation（${APP_OPERATIONS.join('、')}）和它的参数，参数与同名工具一致。`,
  'actions 必须与 goals 一一对应：answer→reply，delegate→start，update_task→message，stop_task→stop，needs_input→clarify，app_operation→app_action。需要用户确认的设置由卡片确认，提交后不用等。',
  '需要用户回答才能继续时，必须提交 clarify 并把问题写进 question；不要用 reply 把问题写在正文里。',
  '找回旧标准、读历史只是准备步骤，不是目标；用户要求的交付仍要 delegate。start 的 brief 要自成一体：用户原话、目标、找到的约定、文件和输出要求。',
  'reply、clarify 被接受后在下一步输出回答或问题；其他动作提交后本轮结束，界面会显示任务卡片。',
].join('')

export const COMMIT_PARAMETERS = {
  requestId: { type: 'string' as const, required: true as const, description: '要处理的【请求 ID】' },
  goals: { type: 'array' as const, required: true as const, items: { type: 'object' as const, additionalProperties: false, properties: {
    goal: { type: 'string' as const, required: true as const }, disposition: { type: 'string' as const, required: true as const, enum: [...DISPOSITIONS] },
  } } },
  actions: { type: 'array' as const, required: true as const, items: { type: 'object' as const, additionalProperties: false, properties: {
    kind: { type: 'string' as const, required: true as const, enum: ['reply', 'start', 'message', 'stop', 'clarify', 'app_action'] },
    operation: { type: 'string' as const, enum: [...APP_OPERATIONS], description: 'app_action：应用操作' },
    args: { type: 'object' as const, additionalProperties: true, description: 'app_action：与同名工具相同的参数' },
    scope: { type: 'string' as const, description: 'reply：本次回答的范围' },
    brief: { type: 'string' as const, description: 'start：自成一体的完整委托' },
    taskId: { type: 'string' as const, description: 'message/stop：后台任务 ID（先用 list_background_tasks 查）' },
    text: { type: 'string' as const, description: 'message：给任务的补充或修改' },
    question: { type: 'string' as const, description: 'clarify：问用户的问题' },
    options: { type: 'array' as const, items: { type: 'string' as const } },
    evidenceIds: { type: 'array' as const, items: { type: 'string' as const }, description: '用到的历史原文链接' },
  } } },
}
