/**
 * Supplementary routing probe (v2). Differences from test/fixtures/routing-feasibility:
 * - role binding happens once at session/created; unknown sessions are refused (no `creating` fallback);
 * - a per-request ledger: every user message carrying 【请求 ID：X】 (prompt or steered interjection) must be routed;
 * - protocol v1 (the PR's) or v2 (goal dispositions + host consistency check + distinct clarify), or none (baseline);
 * - stream modes: off (stock viva-stream loaded separately), naive (drop unauthorized attempts), gated (empty settle);
 * - guard records every denied call with its arguments.
 */
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTasksChannel } from '../../../../plugins/tasks/lib/channel.ts'

export const name = 'viva-routing-supplement'
export const inject = ['agents', 'tools', 'sessions']
export const Config = z.object({ control: z.string(), evidence: z.string(), protocol: z.string(), stream: z.string() })

type Protocol = 'v1' | 'v2' | 'none'
type StreamMode = 'off' | 'naive' | 'gated'
interface Binding { role: 'main' | 'worker', label: string, holdMs?: number, seed?: Array<{ role: 'user' | 'assistant', text: string }> }
interface Control { creating?: Binding }
type RequestStatus = 'pending' | 'reply' | 'handed' | 'clarify' | 'failed'
interface RequestEntry { id: string, status: RequestStatus, registeredStep: number, commitStep: number, repairs: number }
interface SessionState { step: number, requests: Map<string, RequestEntry> }

export const REQUEST_MARK = /【请求 ID：([A-Za-z0-9-]+)】/g
export const MAIN_ALLOWED = ['commit_route', 'search_conversations', 'read_conversation', 'memory_recall', 'list_background_tasks', 'get_background_task', 'read', 'glob', 'grep', 'read_image']
/** Baseline arm: side-effecting tools are denied (and recorded) so the probe never touches the network or files. */
const BASELINE_DENY = /^(bash|write|edit|multi_edit|apply_patch|web_search|web_fetch|ask_user_question|subagent|subagent_fork|schedule_|memory_remember|memory_forget|viva_|job_|plugin)/

const v1Action = zod.object({
  kind: zod.enum(['reply', 'start', 'message', 'stop', 'clarify']),
  taskId: zod.string().optional(), text: zod.string().optional(), brief: zod.string().optional(), evidenceIds: zod.array(zod.string()).optional(),
})
const v2Action = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('reply'), scope: zod.string().min(1).max(500) }),
  zod.object({ kind: zod.literal('start'), brief: zod.string().min(20).max(6000), evidenceIds: zod.array(zod.string()).max(20).optional() }),
  zod.object({ kind: zod.literal('message'), taskId: zod.string().min(1), text: zod.string().min(1).max(4000) }),
  zod.object({ kind: zod.literal('stop'), taskId: zod.string().min(1) }),
  zod.object({ kind: zod.literal('clarify'), question: zod.string().min(4).max(800), options: zod.array(zod.string().max(200)).max(6).optional() }),
])
const DISPOSITIONS = ['answer', 'delegate', 'update_task', 'stop_task', 'needs_input'] as const
const v2Goal = zod.object({ goal: zod.string().min(1).max(500), disposition: zod.enum(DISPOSITIONS) })
const NEEDS: Record<(typeof DISPOSITIONS)[number], string> = { answer: 'reply', delegate: 'start', update_task: 'message', stop_task: 'stop', needs_input: 'clarify' }

/** v2 host check: goals and actions must agree both ways. Returns the problem, or null. */
export function v2Problem(goals: zod.infer<typeof v2Goal>[], actions: zod.infer<typeof v2Action>[]): string | null {
  const kinds = new Set<string>(actions.map(a => a.kind))
  for (const goal of goals) if (!kinds.has(NEEDS[goal.disposition])) return `目标「${goal.goal}」标为 ${goal.disposition}，但没有对应的 ${NEEDS[goal.disposition]} 动作`
  const wanted = new Set(goals.map(g => NEEDS[g.disposition]))
  for (const kind of kinds) if (!wanted.has(kind)) return `动作 ${kind} 没有对应的目标`
  return null
}

const V1_DESCRIPTION = '当前请求的唯一处理出口。reply 后继续流式回答；start/message/stop/clarify 交接后本轮结束。actions 支持多项。只有完成上下文恢复后提交，不要用助手建议替代用户确认。'
const V2_DESCRIPTION = [
  '当前请求的唯一处理出口，每个【请求 ID】都要提交一次。先把用户这句话里的每个目标列进 goals，并给出去向：',
  'answer=你在主会话里直接回答（解释、短问答）；delegate=交给新的独立任务完成（调研、完整报告、写文件、命令）；',
  'update_task=补充或修改已有任务；stop_task=停止已有任务；needs_input=缺少只有用户能给的信息或必须由用户在多个对象中选择。',
  'actions 必须与 goals 一一对应：answer→reply，delegate→start，update_task→message，stop_task→stop，needs_input→clarify。',
  '需要用户回答才能继续时，必须提交 clarify 并把问题写进 question；不要用 reply 把问题写在正文里，reply 不会让系统等待用户的回答。',
  '找回旧标准、读历史只是准备步骤，不是目标；用户要求的交付仍要 delegate。reply 被接受后在下一步输出回答；其他动作提交后本轮结束。',
].join('')

export function apply(ctx: Context, config: { control: string, evidence: string, protocol: string, stream: string }) {
  const protocol = config.protocol as Protocol
  const streamMode = config.stream as StreamMode
  const bindings = new Map<string, Binding>()
  const states = new Map<string, SessionState>()
  const installed = new WeakSet<Agent>()
  const readControl = (): Control => JSON.parse(fs.readFileSync(config.control, 'utf8')) as Control
  const write = (sessionId: string, type: string, data: Record<string, unknown> = {}) => {
    const binding = bindings.get(sessionId)
    fs.appendFileSync(config.evidence, JSON.stringify({ type, at: Date.now(), sessionId, label: binding?.label ?? 'unbound', role: binding?.role ?? null, ...data }) + '\n')
  }
  const stateOf = (sessionId: string): SessionState => {
    const existing = states.get(sessionId)
    if (existing) return existing
    const created: SessionState = { step: 0, requests: new Map() }
    states.set(sessionId, created)
    return created
  }
  const isMain = (sessionId: string) => bindings.get(sessionId)?.role === 'main' && protocol !== 'none'
  const channel = createTasksChannel({ send: message => { process.send?.(message) }, on: process.on.bind(process), off: process.off.bind(process) })
  ctx.effect(() => () => channel.close(), 'routing v2 channel')
  const output = { schema: { type: 'object' as const, properties: { text: { type: 'string' as const, required: true as const } }, additionalProperties: false }, render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] }

  ctx.on('session/created', session => {
    const id = String(session.id)
    if (bindings.has(id)) return
    const creating = readControl().creating
    if (!creating) { fs.appendFileSync(config.evidence, JSON.stringify({ type: 'session_unbound', at: Date.now(), sessionId: id }) + '\n'); return }
    bindings.set(id, { ...creating, seed: undefined })
    write(id, 'session_bound', { role: creating.role })
    if (!creating.seed?.length || session.snapshotEvents().some(event => event.type === 'assistant/message')) return
    // Complete synthetic turns, appended before the agent loop captures its turn counter (as the PR's probe does).
    let turn = 0
    for (const message of creating.seed) {
      if (message.role === 'user') {
        turn++
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      } else {
        session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: message.text }], source: { provider: 'deepseek-official', model: 'deepseek-flash' } }) }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
    }
    write(id, 'history_seeded', { messages: creating.seed.length, userTurns: turn })
  })

  ctx.on('session/event', (session, event) => {
    const id = String(session.id)
    if (event.type.includes('compact')) write(id, 'compaction_event', { eventType: event.type })
    if (!isMain(id) || event.type !== 'user/message') return
    const message = event.data as unknown as { content?: ReadonlyArray<{ type: string, text?: string }> }
    const text = (message.content ?? []).map(part => part.text ?? '').join('')
    const state = stateOf(id)
    for (const match of text.matchAll(REQUEST_MARK)) {
      if (state.requests.has(match[1])) continue
      state.requests.set(match[1], { id: match[1], status: 'pending', registeredStep: state.step, commitStep: -1, repairs: 0 })
      write(id, 'request_registered', { requestId: match[1], step: state.step, interjection: text.includes('【插话】') })
    }
  })

  ctx.tools.guard(exec => {
    if (!exec.agent) return undefined
    const id = String(exec.agent.session.id)
    const binding = bindings.get(id)
    const args = JSON.stringify(exec.arguments ?? null).slice(0, 600)
    const deny = (reason: string) => { write(id, 'guard_denied', { tool: exec.name, args, reason }); return reason }
    if (!binding) return deny('session is not bound to a role')
    if (binding.role === 'worker') return exec.name === 'probe_worker_step' ? undefined : deny('worker may only run the safe probe step')
    if (protocol === 'none') {
      write(id, 'tool_call', { tool: exec.name, args })
      return BASELINE_DENY.test(exec.name) ? deny('baseline probe never runs side effects') : undefined
    }
    write(id, 'tool_call', { tool: exec.name, args })
    return MAIN_ALLOWED.includes(exec.name) ? undefined : deny('main agent may only recover context and commit routing')
  })

  ctx.tools.register(defineTool({ name: 'probe_forbidden', description: '实验陷阱，不得调用。', parameters: {}, output,
    execute: async (_args, exec) => { if (exec.agent) write(String(exec.agent.session.id), 'FORBIDDEN_BODY'); return { text: 'unsafe body ran' } },
  }))
  ctx.tools.register(defineTool({ name: 'probe_worker_step', description: '只执行隔离实验的安全步骤，等待后返回固定标记，不联网、不运行命令、不写用户文件。', parameters: {}, output,
    execute: async (_args, exec) => {
      const id = String(exec.agent?.session.id ?? '')
      write(id, 'worker_started')
      await new Promise<void>(resolve => setTimeout(resolve, bindings.get(id)?.holdMs ?? 2500))
      write(id, 'worker_finished')
      return { text: 'WORKER_DONE：合成材料检查完成。' }
    },
  }))

  if (protocol !== 'none') ctx.tools.register(defineTool({
    name: 'commit_route',
    description: protocol === 'v2' ? V2_DESCRIPTION : V1_DESCRIPTION,
    parameters: protocol === 'v2' ? {
      requestId: { type: 'string', required: true, description: '要处理的【请求 ID】' },
      goals: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        goal: { type: 'string', required: true }, disposition: { type: 'string', required: true, enum: [...DISPOSITIONS] },
      } } },
      actions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true, enum: ['reply', 'start', 'message', 'stop', 'clarify'] },
        scope: { type: 'string', description: 'reply：本次回答的范围' }, brief: { type: 'string', description: 'start：自成一体的完整委托' },
        taskId: { type: 'string', description: 'message/stop：任务 ID' }, text: { type: 'string', description: 'message：给任务的补充' },
        question: { type: 'string', description: 'clarify：问用户的问题' }, options: { type: 'array', items: { type: 'string' } },
        evidenceIds: { type: 'array', items: { type: 'string' }, description: '用到的历史原文链接或 ID' },
      } } },
    } : {
      requestId: { type: 'string', required: true },
      actions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true }, taskId: { type: 'string' }, text: { type: 'string' }, brief: { type: 'string' },
        evidenceIds: { type: 'array', items: { type: 'string' } },
      } } },
    },
    output,
    execute: async (args, exec) => {
      const agent = exec.agent
      if (!agent) throw new Error('missing agent')
      const id = String(agent.session.id)
      const state = stateOf(id)
      const raw = args as { requestId?: string, goals?: unknown, actions?: unknown }
      const reject = (reason: string): never => { write(id, 'route_rejected', { requestId: raw.requestId, reason, step: state.step }); throw new Error(reason) }
      const entry = state.requests.get(String(raw.requestId)) ?? reject(`没有待处理的请求 ${raw.requestId}；只能处理系统给出的【请求 ID】`)
      if (entry.status !== 'pending') reject(`请求 ${raw.requestId} 已经提交过决策（${entry.status}），不能再改；用户的纠正会作为新请求送来`)
      let actions: Array<{ kind: string, brief?: string }>
      let goals: unknown = undefined
      if (protocol === 'v2') {
        const parsedActions = zod.array(v2Action).min(1).max(5).safeParse(raw.actions)
        if (!parsedActions.success) return reject('actions 不合法：' + parsedActions.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; '))
        const parsedGoals = zod.array(v2Goal).min(1).max(6).safeParse(raw.goals)
        if (!parsedGoals.success) return reject('goals 不合法：' + parsedGoals.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; '))
        const problem = v2Problem(parsedGoals.data, parsedActions.data)
        if (problem) reject(problem)
        actions = parsedActions.data
        goals = parsedGoals.data
      } else {
        const parsed = zod.array(v1Action).min(1).max(5).safeParse(raw.actions)
        if (!parsed.success) return reject('actions 不合法')
        actions = parsed.data
        for (const action of actions) if (action.kind === 'start' && !action.brief?.trim()) reject('start requires brief')
      }
      write(id, 'route_plan', { requestId: entry.id, goals, actions, step: state.step })
      const receipts: unknown[] = []
      for (const action of actions) if (action.kind === 'start') {
        const receipt = await channel.request({ op: 'start', brief: action.brief ?? '' }, id, exec.signal, 60_000)
        receipts.push(JSON.parse(receipt))
      }
      const status: RequestStatus = actions.some(a => a.kind === 'reply') ? 'reply' : actions.some(a => a.kind === 'clarify') ? 'clarify' : 'handed'
      state.requests.set(entry.id, { ...entry, status, commitStep: state.step })
      write(id, 'route_committed', { requestId: entry.id, goals, actions, receipts, step: state.step })
      const replyOpen = [...state.requests.values()].some(r => r.status === 'reply' || r.status === 'pending')
      if (!replyOpen) exec.concludeTurn()
      return { text: JSON.stringify({ accepted: true, requestId: entry.id, receipts, next: status === 'reply' ? '请在下一步回答这个请求。' : replyOpen ? '已交接；继续处理仍在进行的回答。' : '已交接，结束本轮，不要等待任务结果。' }) }
    },
  }))

  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, step } = payload
    const id = String(agent.session.id)
    const binding = bindings.get(id)
    if (!binding) { write(id, 'unbound_prompt_refused', { step }); throw new Error('probe session must be bound before its first prompt') }
    stateOf(id).step = step
    install(agent, 'pre-step')
    return next()
  })
  // DSH assembles a step's system prompt and tools before agent/pre-step (dsh-agent-loop preStep), so a restriction
  // made there only reaches the next step. BIND_AT=pre-step reproduces the PR probe; the default binds at creation.
  function install(agent: Agent, phase: 'created' | 'pre-step') {
    const id = String(agent.session.id)
    const binding = bindings.get(id)
    if (!binding || installed.has(agent)) return
    if (phase === 'created' && process.env.BIND_AT === 'pre-step') return
    installed.add(agent)
    if (binding.role === 'worker') agent.ctx.tools.restrict({ allow: ['probe_worker_step'] })
    else if (protocol !== 'none') agent.ctx.tools.restrict({ allow: MAIN_ALLOWED })
    write(id, 'tools_bound', { phase, tools: agent.ctx.tools.schemas(scopeOf(agent.ctx)).map(t => t.name) })
  }
  ctx.on('agent/created', ({ agent }) => { install(agent, 'created') })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const id = String(agent.session.id)
    if (!isMain(id)) return
    const state = stateOf(id)
    const pending = [...state.requests.values()].filter(r => r.status === 'pending')
    if (!pending.length) return
    const retry = pending.filter(r => r.repairs < 2)
    for (const r of pending.filter(r => r.repairs >= 2)) { state.requests.set(r.id, { ...r, status: 'failed' }); write(id, 'route_failed', { requestId: r.id }) }
    if (!retry.length) return
    for (const r of retry) state.requests.set(r.id, { ...r, repairs: r.repairs + 1 })
    write(id, 'repair', { requestIds: retry.map(r => r.id), counts: retry.map(r => r.repairs + 1) })
    agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `【路由补交】以下请求还没有提交 commit_route：${retry.map(r => r.id).join('、')}。先逐个提交有效路由再结束；不得直接用正文代替。` }] }))
  })

  // Which attempts may show text: a worker's, the baseline's, or a main step after a reply was accepted with nothing pending.
  const attempts = new Map<string, { step: number, allowed: boolean }>()
  const allowedAt = (id: string, step: number) => {
    const binding = bindings.get(id)
    if (!binding) return false
    if (binding.role === 'worker' || protocol === 'none') return true
    const requests = [...stateOf(id).requests.values()]
    return requests.some(r => r.status === 'reply' && r.commitStep < step) && !requests.some(r => r.status === 'pending')
  }
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const id = String(agent.session.id)
    if (frame.type === 'start') attempts.set(String(frame.attemptId), { step: frame.step, allowed: allowedAt(id, frame.step) })
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      const attempt = attempts.get(String(frame.attemptId))
      write(id, 'text_delta', { step: attempt?.step, allowed: attempt?.allowed ?? false, text: frame.chunk.text })
    }
  })

  if (streamMode !== 'off') installStream(ctx, streamMode, attemptId => attempts.get(attemptId)?.allowed ?? false)
}

type StoredEvent = { seq: number, type: string, data: { turn: number, step: number, message: { content: Array<{ type: string, text?: string }> } } }

/** A copy of plugins/stream with a gate. naive drops unauthorized attempts entirely; gated keeps start/settle but empties them. */
function installStream(ctx: Context, mode: 'naive' | 'gated', allowed: (attemptId: string) => boolean) {
  const port = process
  if (typeof port.send !== 'function') return
  const send = (message: object) => { if (port.connected) port.send!(message, () => {}) }
  const bindings = new Map<string, string>()
  const generations = new WeakMap<Agent, number>()
  type Active = { operation: string, key: string, attemptId: string, turn: number, step: number, open: boolean, event?: StoredEvent }
  const active = new WeakMap<object, Active>()
  let generation = 0
  const receive = (message: { type?: string, version?: number, operation?: string, sessionId?: string }) => {
    if (message?.type === 'assistant_stream_flush' && message.version === 1) { send({ type: 'assistant_stream_flushed', version: 1, operation: message.operation }); return }
    if (message?.type !== 'assistant_stream_bind' || message.version !== 1 || typeof message.sessionId !== 'string' || typeof message.operation !== 'string') return
    bindings.set(message.sessionId, message.operation)
    send({ type: 'assistant_stream_bound', version: 1, operation: message.operation })
  }
  port.on('message', receive)
  ctx.effect(() => () => { port.off('message', receive); bindings.clear() }, 'gated stream channel')
  const visible = (block: { type: string, text?: unknown }) => Boolean(block) && (block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string'
  ctx.on('session/event', (session, event) => {
    const attempt = active.get(session)
    const data = event.data as { turn?: number, step?: number }
    if (attempt && (event.type === 'assistant/message' || event.type === 'assistant/attempt') && data.turn === attempt.turn && data.step === attempt.step) attempt.event = event as unknown as StoredEvent
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const session = agent.session
    const sessionId = String(session.id)
    if (frame.type === 'start') {
      const operation = bindings.get(sessionId)
      if (!operation) return
      if (!generations.has(agent)) generations.set(agent, ++generation)
      // Runs after the probe's own assistant-stream listener (registered first), so the decision is already recorded.
      active.set(session, { operation, key: `${operation}:${generations.get(agent)}:${frame.attemptId}`, attemptId: String(frame.attemptId), turn: frame.turn, step: frame.step, open: allowed(String(frame.attemptId)) })
    }
    const attempt = active.get(session)
    if (!attempt || attempt.attemptId !== String(frame.attemptId)) return
    if (!attempt.open && mode === 'naive') { if (frame.type === 'end') active.delete(session); return }
    const base = { type: 'assistant_stream', version: 1, sessionId, operation: attempt.operation, key: attempt.key }
    if (frame.type === 'start') send({ ...base, kind: 'start' })
    if (frame.type === 'chunk' && attempt.open) {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') send({ ...base, kind: 'delta', index: chunk.index, blockType: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text })
      else if (chunk.type === 'block-end' && visible(chunk.block as { type: string, text?: unknown })) send({ ...base, kind: 'block', index: chunk.index, blockType: chunk.block.type, text: (chunk.block as { text: string }).text })
    }
    if (frame.type === 'end') {
      const event = attempt.event
      const committed = attempt.open && frame.outcome.kind === 'committed' && event?.seq === frame.outcome.seq && event.type === frame.outcome.eventType
      const blocks = committed && event?.type === 'assistant/message' ? event.data.message.content.filter(visible).map(block => ({ type: block.type, text: block.text })) : []
      send({ ...base, kind: 'settle', blocks })
      active.delete(session)
    }
  })
  send({ type: 'assistant_stream_ready', version: 1 })
}
