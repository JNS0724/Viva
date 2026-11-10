/**
 * The routing decision (docs/agent-routing-design.md §8.1): the goals of one request, each with where it goes, and
 * the actions that carry them out. The host accepts a decision only through this schema. Flat on purpose: nested
 * free-form arguments made the model emit invalid JSON, so an app_action names only its tool.
 */
import { z } from 'zod'
import { MAX_MESSAGE_CHARS } from '../text-limits.ts'

/** The app's own settings the main agent may change, each through its own tool, once an app_action allows it. */
export const APP_OPERATIONS = Object.freeze([
  'schedule_create', 'schedule_update', 'schedule_delete',
  'memory_remember', 'memory_forget',
  'viva_mcp_add', 'viva_mcp_update', 'viva_mcp_remove', 'viva_mcp_import',
  'viva_skill_create', 'viva_skill_install', 'viva_skill_remove',
] as const)
export type AppOperation = (typeof APP_OPERATIONS)[number]

export const DISPOSITIONS = ['answer', 'delegate', 'update_task', 'stop_task', 'needs_input', 'app_operation'] as const
export type Disposition = (typeof DISPOSITIONS)[number]
const ACTION_OF = { answer: 'reply', delegate: 'start', update_task: 'message', stop_task: 'stop', needs_input: 'clarify', app_operation: 'app_action' } as const satisfies Record<Disposition, string>

const MAX_SCOPE_CHARS = 500
const MAX_BRIEF_CHARS = MAX_MESSAGE_CHARS
const MAX_TASK_ID_CHARS = 200
const text = (max: number) => z.string().trim().min(1).max(max)
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), scope: text(MAX_SCOPE_CHARS) }),
  z.object({ kind: z.literal('start'), brief: text(MAX_BRIEF_CHARS) }),
  z.object({ kind: z.literal('message'), taskId: text(MAX_TASK_ID_CHARS), text: text(MAX_BRIEF_CHARS) }),
  z.object({ kind: z.literal('stop'), taskId: text(MAX_TASK_ID_CHARS) }),
  z.object({ kind: z.literal('clarify'), question: text(MAX_SCOPE_CHARS) }),
  z.object({ kind: z.literal('app_action'), operation: z.enum(APP_OPERATIONS) }),
])
const planSchema = z.object({
  goals: z.array(z.object({ goal: text(MAX_SCOPE_CHARS), disposition: z.enum(DISPOSITIONS) })).min(1).max(6),
  actions: z.array(actionSchema).min(1).max(6),
})
export type Plan = z.infer<typeof planSchema>
export type Action = Plan['actions'][number]
/** Actions that change a task: the host carries them out through the task runtime, after the decision commits. */
export type TaskAction = Extract<Action, { kind: 'start' | 'message' | 'stop' }>
export const isTaskAction = (action: Action): action is TaskAction => action.kind === 'start' || action.kind === 'message' || action.kind === 'stop'

/** Goals and actions must agree both ways; the problem, said back to the model, or null. */
function planProblem(plan: Plan): string | null {
  const kinds = new Set<string>(plan.actions.map(action => action.kind))
  const missing = plan.goals.find(goal => !kinds.has(ACTION_OF[goal.disposition]))
  if (missing) return `目标「${missing.goal}」标为 ${missing.disposition}，但没有对应的 ${ACTION_OF[missing.disposition]} 动作`
  const wanted = new Set<string>(plan.goals.map(goal => ACTION_OF[goal.disposition]))
  const extra = [...kinds].find(kind => !wanted.has(kind))
  return extra ? `动作 ${extra} 没有对应的目标` : null
}

/** What the model passed, as a plan, or the problem to say back. */
export function parsePlan(raw: unknown): { plan: Plan } | { problem: string } {
  const parsed = planSchema.safeParse(raw)
  if (!parsed.success) return { problem: '路由不合法：' + parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ') }
  const problem = planProblem(parsed.data)
  return problem ? { problem } : { plan: parsed.data }
}

/** What became of one action: done (a task's id when it touched one), or why not. */
export type Receipt = { kind: Action['kind'], ok: true, taskId?: string } | { kind: Action['kind'], ok: false, error: string }
