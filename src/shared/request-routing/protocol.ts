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
  'viva_source_preview', 'viva_source_add', 'viva_source_remove',
] as const)
export type AppOperation = (typeof APP_OPERATIONS)[number]

export const DISPOSITIONS = ['answer', 'delegate', 'update_task', 'stop_task', 'needs_input', 'app_operation'] as const
export type Disposition = (typeof DISPOSITIONS)[number]
const ACTION_OF = { answer: 'reply', delegate: 'start', update_task: 'message', stop_task: 'stop', needs_input: 'clarify', app_operation: 'app_action' } as const satisfies Record<Disposition, string>

const MAX_SCOPE_CHARS = 500
const MAX_BRIEF_CHARS = MAX_MESSAGE_CHARS
const MAX_TASK_ID_CHARS = 200
/** A task's name, its card's title; a longer one is cut, not refused. */
export const MAX_TITLE_CHARS = 40
const text = (max: number) => z.string().trim().min(1).max(max)
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), scope: text(MAX_SCOPE_CHARS) }),
  z.object({ kind: z.literal('start'), title: z.string().trim().transform(title => title.slice(0, MAX_TITLE_CHARS) || undefined).optional(), brief: text(MAX_BRIEF_CHARS) }),
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
  if (missing) {
    const kind = ACTION_OF[missing.disposition]
    return `目标「${missing.goal}」标为 ${missing.disposition}，但没有对应的 ${kind} 动作：补一个单独的 ${kind}（${FIELDS_OF[kind].needs.join('、')}）再提交`
  }
  const wanted = new Set<string>(plan.goals.map(goal => ACTION_OF[goal.disposition]))
  const extra = [...kinds].find(kind => !wanted.has(kind))
  return extra ? `动作 ${extra} 没有对应的目标` : null
}

/** The fields that name each kind of action: those it needs, and those it may have besides. */
const FIELDS_OF: Readonly<Record<Action['kind'], { needs: readonly string[], may: readonly string[] }>> = {
  reply: { needs: ['scope'], may: [] },
  start: { needs: ['brief'], may: ['title'] },
  message: { needs: ['taskId', 'text'], may: [] },
  stop: { needs: ['taskId'], may: [] },
  clarify: { needs: ['question'], may: [] },
  app_action: { needs: ['operation'], may: [] },
}
const NAMING_FIELDS = new Set(Object.values(FIELDS_OF).flatMap(({ needs, may }) => [...needs, ...may]))

/**
 * An action the model wrote without its kind, taken for the one kind its fields name (a brief and nothing else of
 * another kind's is a start): leaving it out is no reason to write a long brief again. Fields naming no kind, or more
 * than one, stay as they are, for the schema to refuse; a kind given is never second-guessed.
 */
function withKind(action: unknown): unknown {
  if (!action || typeof action !== 'object' || Array.isArray(action) || (action as { kind?: unknown }).kind !== undefined) return action
  const present = Object.entries(action).filter(([key, value]) => NAMING_FIELDS.has(key) && value !== undefined && value !== null && value !== '').map(([key]) => key)
  const kinds = (Object.keys(FIELDS_OF) as Array<Action['kind']>).filter(kind => {
    const { needs, may } = FIELDS_OF[kind]
    return needs.every(field => present.includes(field)) && present.every(field => needs.includes(field) || may.includes(field))
  })
  return kinds.length === 1 ? { ...action, kind: kinds[0] } : action
}

type Loose = Record<string, unknown>
const isLoose = (value: unknown): value is Loose => !!value && typeof value === 'object' && !Array.isArray(value)
const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isKind = (value: unknown): value is Action['kind'] => typeof value === 'string' && Object.hasOwn(FIELDS_OF, value)
const isDisposition = (value: unknown): value is Disposition => typeof value === 'string' && Object.hasOwn(ACTION_OF, value)
const ROUTE_OF = Object.fromEntries(Object.entries(ACTION_OF).map(([route, kind]) => [kind, route])) as Record<Action['kind'], Disposition>
/** The fields whose words say what an action is about, in the order taken as its goal. */
const ABOUT_FIELDS = ['title', 'scope', 'question', 'text', 'operation'] as const

/** Goals for actions written with none: each action is its own goal. */
const goalsOf = (actions: readonly unknown[]): Loose[] => actions.filter(isLoose).filter(action => isKind(action.kind))
  .map(action => ({ goal: (ABOUT_FIELDS.map(field => action[field]).find(filled) ?? String(action.kind)).trim().slice(0, MAX_SCOPE_CHARS), disposition: ROUTE_OF[action.kind as Action['kind']] }))

/**
 * The fields of a missing kind, written onto an action of another kind (a start carrying a message's task and text),
 * taken off it as an action of their own. Only when the fields that are not the carrier's own are exactly that kind's:
 * a task and a text are a message and never a stop, whatever order the goals come in, so a task the user wanted told
 * something is not stopped. Null when no action carries them so.
 */
function splitOff(actions: readonly unknown[], kind: Action['kind']): unknown[] | null {
  const { needs, may } = FIELDS_OF[kind]
  const stray = (action: Loose & { kind: Action['kind'] }) => [...NAMING_FIELDS]
    .filter(field => filled(action[field]) && !FIELDS_OF[action.kind].needs.includes(field) && !FIELDS_OF[action.kind].may.includes(field))
  const at = actions.findIndex(action => {
    if (!isLoose(action) || !isKind(action.kind) || action.kind === kind) return false
    const extra = stray(action as Loose & { kind: Action['kind'] })
    return needs.every(field => extra.includes(field)) && extra.every(field => needs.includes(field) || may.includes(field))
  })
  if (at < 0) return null
  const carrier = actions[at] as Loose
  const moved = [...needs, ...may].filter(field => carrier[field] !== undefined)
  const kept = Object.fromEntries(Object.entries(carrier).filter(([field]) => !moved.includes(field)))
  const own = Object.fromEntries(moved.map(field => [field, carrier[field]]))
  return [...actions.slice(0, at), kept, { kind, ...own }, ...actions.slice(at + 1)]
}

/**
 * The slips the host mends without guessing, so a plan whose meaning is plain is not sent back to be written again
 * (docs/agent-routing-design.md §7.2): goals left out are the actions' own; an answer with no reply gets one for its
 * goal; any other goal with no action of its kind takes that kind's fields off another action; a reply with no goal is
 * listed as an answer. A task action is never made up: a delegate, update or stop with nothing to carry it out is
 * refused as before.
 */
function mend(given: Loose & { actions: unknown[] }): Loose {
  let actions: unknown[] = given.actions.map(withKind)
  const goals = given.goals === undefined ? goalsOf(actions) : given.goals
  if (!Array.isArray(goals)) return { ...given, actions }
  for (const goal of goals) {
    if (!isLoose(goal) || !isDisposition(goal.disposition)) continue
    const kind = ACTION_OF[goal.disposition]
    if (actions.some(action => isLoose(action) && action.kind === kind)) continue
    // A reply is the answer goal's own: a scope found on another action names that action's subject more often than
    // what is to be answered, and is dropped with the rest of its stray fields.
    if (kind === 'reply') {
      if (filled(goal.goal)) actions = [...actions, { kind: 'reply', scope: goal.goal }]
      continue
    }
    const split = splitOff(actions, kind)
    if (split) actions = split
  }
  const answered = goals.some(goal => isLoose(goal) && goal.disposition === 'answer')
  const replies = actions.filter(isLoose).filter(action => action.kind === 'reply' && filled(action.scope))
  const listed = answered || !replies.length ? goals : [...goals, { goal: replies[0].scope, disposition: 'answer' }]
  return { ...given, goals: listed, actions }
}

/** What the model passed, as a plan, or the problem to say back. */
export function parsePlan(raw: unknown): { plan: Plan } | { problem: string } {
  const parsed = planSchema.safeParse(isLoose(raw) && Array.isArray(raw.actions) ? mend({ ...raw, actions: raw.actions }) : raw)
  if (!parsed.success) return { problem: '路由不合法：' + parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ') }
  const problem = planProblem(parsed.data)
  return problem ? { problem } : { plan: parsed.data }
}

/** What became of one action: done (a task's id when it touched one), or why not. */
export type Receipt = { kind: Action['kind'], ok: true, taskId?: string } | { kind: Action['kind'], ok: false, error: string }
