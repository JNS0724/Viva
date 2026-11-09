/**
 * viva-routing (PROTOTYPE, docs/agent-routing-design.md): with VIVA_ROUTING=1 the app loads this in place of
 * viva-stream. The main session (bound by the app before each prompt, src/backend/routing-prototype.ts) sees only
 * the tools for recovering context plus `commit_route`; every request it is given, under a 【请求 ID】 header, must
 * be routed: answered, handed to a task through the app's TaskRuntime (the viva-tasks channel), or asked about.
 * Its text shows only once a reply or question is accepted (lib/stream.ts). Words said while it answers can take
 * the fast lane (lib/fast-lane.ts) straight to a task. Tasks are never bound and keep the app's usual tools.
 * What happened goes to an evidence file for the live check.
 */
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, ToolCallId, type MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTasksChannel } from '../tasks/lib/channel.ts'
import { COMMIT_DESCRIPTION, COMMIT_PARAMETERS, parsePlan, type Action, type AppOperation } from './lib/protocol.ts'
import { installGatedStream } from './lib/stream.ts'
import { FAST_SYSTEM, fastInput, fastNotice, parseFastDecision, type FastTask, type FastTurn } from './lib/fast-lane.ts'

export const name = 'viva-routing'
export const inject = ['agents', 'tools', 'llm']
export const Config = z.object({ evidence: z.string(), fast: z.boolean().default(false) })

export const MAIN_TOOLS: readonly string[] = Object.freeze(['commit_route', 'search_conversations', 'read_conversation', 'memory_recall', 'list_background_tasks', 'get_background_task', 'read', 'glob', 'grep', 'read_image'])
const REQUEST_MARK = /【请求 ID：([A-Za-z0-9-]{1,64})】\n用户原话：/g
const ACTION_WAIT_MS = 60_000
const FAST_WAIT_MS = 20_000
const MAX_REPAIRS = 2
const FAST_MAX_TOKENS = 1500
/** App operations that wait on the user's yes (an approval card, a key window): done without holding the turn. */
const CONFIRMED: ReadonlySet<AppOperation> = new Set(['viva_mcp_add', 'viva_mcp_update', 'viva_mcp_remove', 'viva_mcp_import', 'viva_skill_create'])
const APP_ACTION_WAIT_MS = 10 * 60_000

type Status = 'pending' | 'fast' | 'reply' | 'clarify' | 'handed' | 'failed'
interface Entry { readonly id: string, readonly status: Status, readonly commitStep: number, readonly repairs: number }
interface SessionState { step: number, requests: Map<string, Entry>, fast: Map<string, Promise<void>> }

const ownSource = (source: { kind: string }) => source as unknown as MessageSource
const textOf = (content: unknown) => (Array.isArray(content) ? content as Array<{ type?: string, text?: string }> : []).filter(part => part.type === 'text').map(part => part.text ?? '').join('')

export function apply(ctx: Context, config: { evidence: string, fast?: boolean }, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') return
  const mains = new Set<string>()
  const installed = new WeakSet<Agent>()
  const states = new Map<string, SessionState>()
  const record = (sessionId: string, type: string, data: Record<string, unknown> = {}) => {
    try { fs.appendFileSync(config.evidence, JSON.stringify({ type, at: Date.now(), sessionId, ...data }) + '\n') } catch { /* evidence is best effort */ }
  }
  const stateOf = (id: string): SessionState => {
    const found = states.get(id)
    if (found) return found
    const made: SessionState = { step: 0, requests: new Map(), fast: new Map() }
    states.set(id, made)
    return made
  }
  const setEntry = (id: string, entry: Entry) => { stateOf(id).requests.set(entry.id, entry) }
  const send = (message: object) => { if (port.connected) port.send!(message, () => {}) }
  const channel = createTasksChannel({ send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) })
  ctx.effect(() => () => channel.close(), 'routing tasks channel')
  const taskJson = async (request: object, sessionId: string, signal?: AbortSignal): Promise<unknown> => {
    try { return { ok: true, ...JSON.parse(await channel.request(request, sessionId, signal, ACTION_WAIT_MS)) } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  function narrow(agent: Agent) {
    const id = String(agent.session.id)
    if (!mains.has(id) || installed.has(agent)) return
    installed.add(agent)
    agent.ctx.tools.restrict({ allow: [...MAIN_TOOLS] })
    record(id, 'main_bound')
  }
  ctx.on('agent/created', ({ agent }) => { narrow(agent); return undefined })

  const onMessage = (raw: unknown) => {
    const message = raw as { type?: string, version?: number, id?: string, sessionId?: string, text?: string } | null
    if (message?.type === 'routing_bind' && message.version === 1 && typeof message.sessionId === 'string') {
      mains.add(message.sessionId)
      const agent = ctx.agents.get(SessionId(message.sessionId))
      if (agent) narrow(agent)
      send({ type: 'routing_bound', version: 1, id: message.id, ok: true })
    }
    if (config.fast && message?.type === 'steer' && typeof message.sessionId === 'string' && typeof message.text === 'string') fastLane(message.sessionId, message.text)
  }
  port.on('message', onMessage)
  ctx.effect(() => () => { port.off('message', onMessage) }, 'routing bind channel')

  ctx.on('session/event', (session, event) => {
    const id = String(session.id)
    if (!mains.has(id) || event.type !== 'user/message') return
    const text = textOf((event.data as { content?: unknown }).content)
    const state = stateOf(id)
    for (const match of text.matchAll(REQUEST_MARK)) {
      if (state.requests.has(match[1])) continue
      setEntry(id, { id: match[1], status: 'pending', commitStep: -1, repairs: 0 })
      record(id, 'request_registered', { requestId: match[1], step: state.step, interjection: text.includes('【插话】') })
    }
  })

  ctx.tools.guard(exec => {
    if (!exec.agent) return undefined
    const id = String(exec.agent.session.id)
    if (!mains.has(id)) return exec.name === 'commit_route' ? 'only the main conversation routes requests' : undefined
    record(id, 'tool_call', { tool: exec.name })
    if (MAIN_TOOLS.includes(exec.name)) return undefined
    record(id, 'guard_denied', { tool: exec.name, args: JSON.stringify(exec.arguments ?? null).slice(0, 400) })
    return 'the main conversation only recovers context and routes; commit_route hands work to a task'
  })

  /**
   * An app operation through the app's own tool, its checks, cards and results staying the app's. One done at once
   * (a schedule proposal, a memory) runs from the global registry, since the main agent's own scope no longer holds
   * it. One that waits on the user's yes cannot outlive the turn (dsh cancels a turn's pending approvals when it ends),
   * so it goes to an executor task of its own, whose wait the user answers on its card while the conversation goes on.
   */
  async function appAction(operation: AppOperation, args: Record<string, unknown>, agent: Agent, signal?: AbortSignal): Promise<unknown> {
    const sessionId = String(agent.session.id)
    if (CONFIRMED.has(operation)) {
      const brief = `你是 Viva 的应用操作执行者，只做这一件事：调用一次 ${operation} 工具，参数严格使用下面的 JSON，不要改动、不要补充别的参数，也不要做其他事。`
        + `需要用户确认或填写密钥时等用户在卡片上处理。完成后用一句话报告结果。\n参数：${JSON.stringify(args)}`
      const receipt = await taskJson({ op: 'start', brief }, sessionId, signal)
      record(sessionId, 'app_action_executor', { operation, receipt })
      return { ...(receipt as object), executor: true, note: '已交给一个只做这件事的任务，用户在它的卡片上确认；不用等，结束本轮。' }
    }
    // A restricted scope reads a global tool as absent, so the main agent's scope cannot run it (UNKNOWN_TOOL). The
    // global view's definition is run directly instead. PROTOTYPE GAP: this skips dsh's argument check, guards and
    // observers; the real design needs dsh to run an authorized out-of-scope call, or a scope that holds the tool
    // without showing it to the model.
    const definition = ctx.tools.get(operation)
    const began = Date.now()
    const finish = (ok: boolean, text: string) => { record(sessionId, 'app_action_done', { operation, ok, text: text.slice(0, 600), ms: Date.now() - began }); return { ok, text: text.slice(0, 600) } }
    if (!definition) return finish(false, `the app has no ${operation}`)
    const callId = ToolCallId(`route-${operation}-${Date.now().toString(36)}`)
    const run = { callId, rootCallId: callId, name: operation, arguments: args, agent, signal: signal ?? AbortSignal.timeout(APP_ACTION_WAIT_MS), deferContext: () => {}, concludeTurn: () => {} }
    try {
      const value = await definition.execute(args, run as unknown as Parameters<typeof definition.execute>[1]) as { text?: unknown } | null
      return finish(true, typeof value?.text === 'string' ? value.text : JSON.stringify(value))
    } catch (error) {
      return finish(false, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * The main agent cannot see the app tools' parameters (they are out of its scope), so an app_action is checked
   * against the tool before the plan is accepted, and a wrong one is sent back with the parameters to use.
   */
  function appArgsProblem(operation: AppOperation, args: Record<string, unknown>): string | null {
    // The registry keeps the compiled JSON schema: { type: 'object', properties, required }.
    const schema = (ctx.tools.get(operation)?.parameters ?? null) as { properties?: Record<string, unknown>, required?: readonly string[] } | null
    if (!schema) return `应用里没有 ${operation}`
    const properties = schema.properties ?? {}
    const missing = (schema.required ?? []).filter((key) => args[key] === undefined)
    const unknown = Object.keys(args).filter((key) => !(key in properties))
    const parameters = schema
    if (!missing.length && !unknown.length) return null
    return `app_action ${operation} 的参数不对${missing.length ? `，缺少 ${missing.join('、')}` : ''}${unknown.length ? `，没有这些参数：${unknown.join('、')}` : ''}。`
      + `按下面的参数重新提交 commit_route：${JSON.stringify(parameters).slice(0, 1800)}`
  }

  async function perform(action: Action, sessionId: string, signal?: AbortSignal, agent?: Agent): Promise<unknown> {
    if (action.kind === 'app_action') return agent ? appAction(action.operation, action.args, agent, signal) : { ok: false, error: 'no agent' }
    if (action.kind === 'start') return taskJson({ op: 'start', brief: action.brief }, sessionId, signal)
    if (action.kind === 'message') return taskJson({ op: 'message', taskId: action.taskId, text: action.text }, sessionId, signal)
    if (action.kind === 'stop') return taskJson({ op: 'stop', taskId: action.taskId }, sessionId, signal)
    return { ok: true }
  }
  const stillOpen = (state: SessionState) => [...state.requests.values()].some(r => r.status === 'reply' || r.status === 'clarify' || r.status === 'pending' || r.status === 'fast')

  ctx.tools.register(defineTool({
    name: 'commit_route', description: COMMIT_DESCRIPTION, parameters: COMMIT_PARAMETERS,
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (!agent) throw new Error('missing agent')
      const id = String(agent.session.id)
      const state = stateOf(id)
      const reject = (reason: string): never => { record(id, 'route_rejected', { requestId: args.requestId, reason, step: state.step }); throw new Error(reason) }
      const entry = state.requests.get(String(args.requestId)) ?? reject(`没有待处理的请求 ${args.requestId}；只能处理系统给出的【请求 ID】`)
      if (entry.status === 'fast') reject(`请求 ${entry.id} 正由调度处理，不要重复提交`)
      if (entry.status !== 'pending') reject(`请求 ${entry.id} 已经提交过决策（${entry.status}），不能再改；用户的纠正会作为新请求送来`)
      const parsed = parsePlan({ goals: args.goals, actions: args.actions })
      if ('problem' in parsed) return reject(parsed.problem)
      for (const action of parsed.plan.actions) {
        const problem = action.kind === 'app_action' ? appArgsProblem(action.operation, action.args) : null
        if (problem) reject(problem)
      }
      const receipts = []
      for (const action of parsed.plan.actions) receipts.push({ kind: action.kind, receipt: await perform(action, id, exec.signal, agent) })
      const kinds = parsed.plan.actions.map(a => a.kind)
      // A handover that did not happen (the five places full, a task gone) is said to the user, not passed over.
      const failed = receipts.some(r => (r.receipt as { ok?: boolean } | null)?.ok === false)
      const status: Status = kinds.includes('reply') || failed ? 'reply' : kinds.includes('clarify') ? 'clarify' : 'handed'
      setEntry(id, { ...entry, status, commitStep: state.step })
      record(id, 'route_committed', { requestId: entry.id, goals: parsed.plan.goals, actions: parsed.plan.actions, receipts, failed, step: state.step })
      if (!stillOpen(state)) exec.concludeTurn()
      const next = failed ? '有动作没有办成（见 receipts），请在下一步如实告诉用户哪件事没办成、原因和可以怎么做。' : status === 'reply' ? '请在下一步回答这个请求。' : status === 'clarify' ? '请在下一步把问题问出来，然后结束。' : stillOpen(state) ? '已交接；继续处理仍在进行的回答。' : '已交接，界面会显示任务卡片；结束本轮，不要等待任务结果。'
      return { text: JSON.stringify({ accepted: true, requestId: entry.id, receipts, next }) }
    },
  }))

  ctx.on('agent/pre-step', async (payload, next) => {
    const id = String(payload.agent.session.id)
    if (mains.has(id)) stateOf(id).step = payload.step
    return next()
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const id = String(agent.session.id)
    if (!mains.has(id)) return
    const state = stateOf(id)
    if (state.fast.size) await Promise.race([Promise.allSettled([...state.fast.values()]), new Promise(resolve => setTimeout(resolve, FAST_WAIT_MS))])
    const pending = [...state.requests.values()].filter(r => r.status === 'pending')
    if (!pending.length) return
    for (const r of pending.filter(r => r.repairs >= MAX_REPAIRS)) { setEntry(id, { ...r, status: 'failed' }); record(id, 'route_failed', { requestId: r.id }) }
    const retry = pending.filter(r => r.repairs < MAX_REPAIRS)
    if (!retry.length) return
    for (const r of retry) setEntry(id, { ...r, repairs: r.repairs + 1 })
    record(id, 'repair', { requestIds: retry.map(r => r.id) })
    agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `【路由补交】以下请求还没有提交 commit_route：${retry.map(r => r.id).join('、')}。先逐个提交有效路由再结束；不得直接用正文代替。` }] }))
  })

  ctx.on('agent/error', ({ agent, error }) => {
    const id = String(agent.session.id)
    if (!mains.has(id)) return
    const pending = [...stateOf(id).requests.values()].filter(r => r.status === 'pending').map(r => r.id)
    record(id, 'turn_error', { pending, error: error instanceof Error ? error.message : String(error) })
  })

  installGatedStream(ctx, (sessionId, step) => {
    if (!mains.has(sessionId)) return true
    const requests = [...stateOf(sessionId).requests.values()]
    const shown = requests.some(r => (r.status === 'reply' || r.status === 'clarify') && r.commitStep < step) && !requests.some(r => r.status === 'pending')
    record(sessionId, 'attempt_gate', { step, shown })
    return shown
  }, port)

  /** Words said mid-answer: decided at once when they plainly go to a task, else left to the main agent. */
  function fastLane(sessionId: string, text: string) {
    if (!mains.has(sessionId)) return
    const match = [...text.matchAll(REQUEST_MARK)][0]
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!match || !agent) return
    const requestId = match[1], words = text.slice((match.index ?? 0) + match[0].length)
    const state = stateOf(sessionId)
    if (state.requests.has(requestId)) return
    setEntry(sessionId, { id: requestId, status: 'fast', commitStep: -1, repairs: 0 })
    const began = Date.now()
    record(sessionId, 'fast_started', { requestId })
    const work = (async () => {
      const signal = AbortSignal.timeout(FAST_WAIT_MS)
      const listed = await taskJson({ op: 'list', limit: 30 }, sessionId, signal) as { tasks?: Array<Record<string, unknown>> }
      const tasks: FastTask[] = (listed.tasks ?? []).map(task => ({ taskId: String(task.taskId), title: String(task.title ?? ''), goal: String(task.request ?? task.goal ?? '').slice(0, 300), status: String(task.status ?? '') }))
      const recent: FastTurn[] = agent.session.snapshotEvents().filter(event => event.type === 'user/message' || event.type === 'assistant/message').map(event => {
        const data = event.data as { content?: unknown, message?: { content?: unknown } }
        return { role: event.type === 'user/message' ? 'user' as const : 'assistant' as const, text: textOf(data.message?.content ?? data.content).replace(REQUEST_MARK, '') }
      }).filter(turn => turn.text.trim())
      const answer = await complete(ctx, agent, fastInput({ recent, tasks, words }), signal)
      const decision = parseFastDecision(answer, tasks)
      if (decision.decision === 'defer') {
        setEntry(sessionId, { id: requestId, status: 'pending', commitStep: -1, repairs: 0 })
        record(sessionId, 'fast_deferred', { requestId, reason: decision.reason, ms: Date.now() - began })
        return
      }
      const action: Action = decision.decision === 'start' ? { kind: 'start', brief: decision.brief } : decision.decision === 'message' ? { kind: 'message', taskId: decision.taskId, text: decision.text } : { kind: 'stop', taskId: decision.taskId }
      const receipt = await perform(action, sessionId, signal)
      setEntry(sessionId, { id: requestId, status: 'handed', commitStep: state.step, repairs: 0 })
      record(sessionId, 'fast_committed', { requestId, decision, receipt, ms: Date.now() - began })
      if (agent.status === 'running') agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: fastNotice(requestId, decision, receipt) }] }))
    })().catch((error: unknown) => {
      setEntry(sessionId, { id: requestId, status: 'pending', commitStep: -1, repairs: 0 })
      record(sessionId, 'fast_failed', { requestId, error: error instanceof Error ? error.message : String(error), ms: Date.now() - began })
    }).finally(() => { state.fast.delete(requestId) })
    state.fast.set(requestId, work)
  }
}

/** One text-only call on the main agent's own route, without thinking, as the memory plugin's background pass does. */
async function complete(ctx: Context, agent: Agent, input: string, signal: AbortSignal): Promise<string> {
  const { provider, model } = agent.options
  if (!provider || !model) throw new Error('the agent has no model route to reuse')
  const assembler = new BlockAssembler()
  const stream = ctx.llm.stream({
    provider, model, system: FAST_SYSTEM, maxTokens: FAST_MAX_TOKENS, signal, sessionId: agent.session.id,
    reasoningEffort: 'off' as unknown as NonNullable<Parameters<Context['llm']['stream']>[0]['reasoningEffort']>,
    purpose: 'routing-fast-lane' as unknown as NonNullable<Parameters<Context['llm']['stream']>[0]['purpose']>,
    messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: ownSource({ kind: name }) })],
  })
  for await (const chunk of stream) assembler.push(chunk)
  return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
}
