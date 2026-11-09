/** Isolated feasibility probe; never loaded by Viva's production profile. */
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTasksChannel } from '../../../plugins/tasks/lib/channel.ts'
import { planSchema, type Control, type Evidence, type Fixture } from './contract.ts'

export const name = 'viva-routing-feasibility'
export const inject = ['agents', 'tools', 'sessions']
export const Config = z.object({ control: z.string(), evidence: z.string() })
interface State { fixture: Fixture, committed: boolean, reply: boolean, repairs: number, commitStep: number, step: number }
export function apply(ctx: Context, config: { control: string, evidence: string }) {
  const states = new Map<string, State>(), installed = new WeakSet<Agent>()
  const fixtureOf = (id: string) => { const control = JSON.parse(fs.readFileSync(config.control, 'utf8')) as Control; return control.sessions[id] ?? control.creating }
  const record = (agent: Agent, type: string, data: Record<string, unknown> = {}) => {
    const sessionId = String(agent.session.id)
    const event: Evidence = { type, at: Date.now(), sessionId, requestId: fixtureOf(sessionId)?.requestId ?? 'unbound', ...data }
    fs.appendFileSync(config.evidence, JSON.stringify(event) + '\n')
  }
  const channel = createTasksChannel({ send: message => { process.send?.(message) }, on: process.on.bind(process), off: process.off.bind(process) })
  ctx.effect(() => () => channel.close(), 'isolated route probe channel')
  const output = { schema: { type: 'object' as const, properties: { text: { type: 'string' as const, required: true as const } }, additionalProperties: false }, render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] }
  const allowed = new Set(['commit_route', 'search_history', 'read_history', 'list_probe_tasks', 'read', 'glob', 'grep', 'read_image'])
  ctx.tools.guard(exec => {
    if (!exec.agent) return undefined
    const fixture = fixtureOf(String(exec.agent.session.id))
    if (!fixture) return 'probe session is unbound'
    const ok = fixture.role === 'worker' ? exec.name === 'probe_worker_step' : allowed.has(exec.name)
    if (!ok) { record(exec.agent, 'guard_denied', { tool: exec.name }); return 'main agent may only recover context and commit routing' }
    return undefined
  })
  ctx.tools.register(defineTool({ name: 'probe_forbidden', description: '实验陷阱，不得调用。', parameters: {}, output,
    execute: async (_args, exec) => { if (exec.agent) record(exec.agent, 'FORBIDDEN_BODY'); return { text: 'unsafe body ran' } },
  }))
  ctx.tools.register(defineTool({ name: 'search_history', description: '按一至三个关键词查旧对话；返回候选原文 ID。没有结果可换关键词，之后用 read_history 读前后文。', parameters: { query: { type: 'string', required: true } }, output,
    execute: async (args, exec) => {
      const history = fixtureOf(String(exec.agent?.session.id))?.history ?? []
      const words = args.query.split(/\s+/).filter(Boolean)
      const hits = history.filter(m => words.every(w => m.text.includes(w))).slice(0, 8)
      if (exec.agent) record(exec.agent, 'search_history', { query: args.query, ids: hits.map(m => m.id) })
      return { text: JSON.stringify(hits) }
    },
  }))
  ctx.tools.register(defineTool({ name: 'read_history', description: '按消息 ID 读取旧对话前后原文，必须核对后续修改。返回 nextOffset 可继续翻页。', parameters: { messageId: { type: 'string', required: true }, offset: { type: 'number' } }, output,
    execute: async (args, exec) => {
      const history = fixtureOf(String(exec.agent?.session.id))?.history ?? []
      const target = history.findIndex(m => m.id === args.messageId)
      const from = args.offset === undefined ? Math.max(0, target - 2) : Math.max(0, Math.trunc(args.offset))
      const messages = target < 0 ? [] : history.slice(from, from + 12)
      if (exec.agent) record(exec.agent, 'read_history', { messageId: args.messageId, from, ids: messages.map(m => m.id) })
      return { text: JSON.stringify({ messages, nextOffset: from + messages.length < history.length ? from + messages.length : null }) }
    },
  }))
  ctx.tools.register(defineTool({ name: 'list_probe_tasks', description: '读取当前真实任务快照，id 可用于后续路由；不靠任务标题猜 ID。', parameters: {}, output,
    execute: async (_args, exec) => ({ text: JSON.stringify(fixtureOf(String(exec.agent?.session.id))?.tasks ?? []) }),
  }))
  ctx.tools.register(defineTool({ name: 'commit_route', description: '当前请求的唯一处理出口。reply 后继续流式回答；start/message/stop/clarify 交接后本轮结束。actions 支持多项。只有完成上下文恢复后提交，不要用助手建议替代用户确认。', parameters: {
    requestId: { type: 'string', required: true },
    actions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, taskId: { type: 'string' }, text: { type: 'string' }, brief: { type: 'string' },
      evidenceIds: { type: 'array', items: { type: 'string' } },
    } } },
  }, output, execute: async (args, exec) => {
    const agent = exec.agent
    if (!agent) throw new Error('missing agent')
    const state = states.get(String(agent.session.id))
    if (!state || args.requestId !== state.fixture.requestId) throw new Error('request identity mismatch')
    const actions = planSchema.parse(args.actions)
    if (state.committed) throw new Error('decision already committed')
    const receipts: unknown[] = []
    record(agent, 'route_plan', { actions, step: state.step })
    for (const action of actions) if (action.kind === 'start') {
      if (!action.brief?.trim()) throw new Error('start requires brief')
      const receipt = await channel.request({ op: 'start', brief: action.brief }, String(agent.session.id), exec.signal, 60_000)
      receipts.push(JSON.parse(receipt))
    }
    state.committed = true; state.reply = actions.some(a => a.kind === 'reply'); state.commitStep = state.step
    record(agent, 'route_committed', { actions, receipts, step: state.step })
    if (!state.reply) exec.concludeTurn()
    return { text: JSON.stringify({ accepted: true, requestId: args.requestId, receipts, next: state.reply ? '请继续回答用户，不必再次提交路由。' : '交接完成，结束本轮，不要等待任务结果。' }) }
  } }))
  ctx.tools.register(defineTool({ name: 'probe_worker_step', description: '只执行隔离实验的安全步骤，等待通常 2500 毫秒（并发用例为 12000 毫秒）后返回固定标记，不联网、不运行命令、不写用户文件。', parameters: {}, output,
    execute: async (_args, exec) => {
      if (exec.agent) record(exec.agent, 'worker_started')
      await new Promise<void>(resolve => setTimeout(resolve, fixtureOf(String(exec.agent?.session.id))?.holdMs ?? 2500))
      if (exec.agent) record(exec.agent, 'worker_finished')
      return { text: 'WORKER_DONE：合成材料检查完成。' }
    },
  }))
  // Seed complete synthetic turns before the agent loop captures its initial turn counter.
  ctx.on('session/created', session => {
    const fixture = fixtureOf(String(session.id))
    if (!fixture?.seedHistory || session.snapshotEvents().some(event => event.type === 'assistant/message')) return
    let turn = 0
    for (const message of fixture.history) {
      if (message.role === 'user') {
        turn++
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `[历史消息 ${message.id}] ${message.text}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      } else {
        session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: `[历史消息 ${message.id}] ${message.text}` }], source: { provider: 'deepseek-official', model: 'deepseek-flash' } }) }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
    }
    fs.appendFileSync(config.evidence, JSON.stringify({ type: 'history_seeded', at: Date.now(), sessionId: String(session.id), requestId: fixture.requestId, messages: fixture.history.length, userTurns: turn }) + '\n')
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, step } = payload, id = String(agent.session.id), fixture = fixtureOf(id)
    if (!fixture) throw new Error('probe session must bind before prompt')
    let state = states.get(id)
    if (!state || state.fixture.requestId !== fixture.requestId) {
      state = { fixture, committed: false, reply: false, repairs: 0, commitStep: -1, step }; states.set(id, state)

    }
    state.step = step
    if (!installed.has(agent)) {
      agent.ctx.tools.restrict({ allow: fixture.role === 'worker' ? ['probe_worker_step'] : [...allowed] })
      installed.add(agent)
      if (fixture.role === 'main' && fixture.exerciseGuards) {
        agent.ctx.tools.register(defineTool({ name: 'probe_scoped_escape', description: '实验 scope 内工具，用于验证执行 guard。', parameters: {}, output,
          execute: async () => { record(agent, 'SCOPED_BODY'); return { text: 'scope bypassed' } },
        }))
        for (const tool of ['probe_forbidden', 'probe_scoped_escape']) {
          const result = await agent.ctx.tools.execute({ callId: ToolCallId('probe-' + tool), name: tool, arguments: {}, agent, signal: payload.signal })
          record(agent, 'direct_guard_probe', { tool, denied: result.isError })
        }
      }
      record(agent, 'tools_bound', { role: fixture.role, tools: agent.ctx.tools.schemas(scopeOf(agent.ctx)).map(t => t.name) })
    }
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const state = states.get(String(agent.session.id))
    if (!state || state.fixture.role !== 'main' || state.committed) return
    if (state.repairs >= 2) { record(agent, 'route_failed'); return }
    state.repairs++
    record(agent, 'repair', { count: state.repairs })
    agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `【路由补交】请求 ${state.fixture.requestId} 尚未提交 commit_route。先提交有效路由再结束；不得直接用正文代替。` }] }))
  })
  const attempts = new Map<string, { step: number, allowed: boolean }>()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const id = String(agent.session.id), state = states.get(id)
    if (!state) return
    if (frame.type === 'start') attempts.set(String(frame.attemptId), { step: frame.step, allowed: state.fixture.role === 'worker' || (state.reply && frame.step > state.commitStep) })
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      const attempt = attempts.get(String(frame.attemptId))
      record(agent, 'text_delta', { step: attempt?.step, allowed: attempt?.allowed ?? false, text: frame.chunk.text })
    }
    if (frame.type === 'end') attempts.delete(String(frame.attemptId))
  })
}
