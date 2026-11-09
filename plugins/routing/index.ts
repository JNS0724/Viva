/**
 * viva-routing (PROTOTYPE, docs/agent-routing-design.md §17): with VIVA_ROUTING=1 the app loads this in place of
 * viva-stream. The app binds the main session before each prompt (src/backend/routing-prototype.ts) and marks each
 * request. The contracts the app shares with this plugin live in src/shared/request-routing (the request header,
 * the routing protocol, the request ledger); what is dsh's alone lives here: the layered tools (lib/policy.ts), the
 * handovers to the app's TaskRuntime (lib/task-actions.ts), the gated stream (lib/stream.ts) and the fast lane for
 * words said mid-answer (lib/fast-lane.ts). Tasks are never bound. This file only wires dsh's events to those
 * modules; when configured, what happened goes to an evidence file for the live check.
 */
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { atStep, claimFast, decide, decisionProblem, EMPTY_LEDGER, failUndecided, hasOpenWork, mayShow, register, repairs, settleFast, statusOfPlan, type Ledger } from '../../src/shared/request-routing/ledger.ts'
import { admit, MAIN_SCOPE, ROUTE_TOOL, type Grant } from './lib/policy.ts'
import { COMMIT_DESCRIPTION, COMMIT_PARAMETERS, parsePlan, type Action } from '../../src/shared/request-routing/protocol.ts'
import { requestsIn, withoutHeaders } from '../../src/shared/request-routing/header.ts'
import { createTaskActions, type Receipt } from './lib/task-actions.ts'
import { installGatedStream } from './lib/stream.ts'
import { FAST_SYSTEM, fastInput, fastNotice, parseFastDecision, type FastTurn } from './lib/fast-lane.ts'

export const name = 'viva-routing'
export const inject = ['agents', 'tools', 'llm']
export const Config = z.object({ evidence: z.string(), fast: z.boolean().default(false) })

const MAX_REPAIRS = 2
const FAST_WAIT_MS = 20_000
const FAST_MAX_TOKENS = 1500

const textOf = (content: unknown) => (Array.isArray(content) ? content as Array<{ type?: string, text?: string }> : []).filter(part => part.type === 'text').map(part => part.text ?? '').join('')
const userNote = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** @param config evidence: where to append what happened, for the live check; without it nothing is written */
export function apply(ctx: Context, config: { evidence?: string, fast?: boolean }, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') return
  const evidence = config.evidence
  const record = (sessionId: string, type: string, data: Record<string, unknown> = {}) => {
    if (!evidence) return
    try { fs.appendFileSync(evidence, JSON.stringify({ type, at: Date.now(), sessionId, ...data }) + '\n') } catch { /* evidence is best effort */ }
  }

  // ── State: which sessions are main, their ledgers, the grants their app_actions gave, fast-lane work under way.
  const mains = new Set<string>()
  const narrowed = new WeakSet<Agent>()
  const ledgers = new Map<string, Ledger>()
  const grants = new Map<string, readonly Grant[]>()
  const fastWork = new Map<string, Set<Promise<void>>>()
  const ledgerOf = (id: string) => ledgers.get(id) ?? EMPTY_LEDGER
  const update = (id: string, change: (ledger: Ledger) => Ledger) => { const next = change(ledgerOf(id)); ledgers.set(id, next); return next }
  const actions = createTaskActions(port)
  ctx.effect(() => () => actions.close(), 'routing task actions')

  // ── Role binding: confirmed to the app before each main prompt, so the first step is assembled already narrowed.
  function narrow(agent: Agent) {
    const id = String(agent.session.id)
    if (!mains.has(id) || narrowed.has(agent)) return
    narrowed.add(agent)
    agent.ctx.tools.restrict({ allow: [...MAIN_SCOPE] })
    record(id, 'main_bound')
  }
  ctx.on('agent/created', ({ agent }) => { narrow(agent); return undefined })
  const onMessage = (raw: unknown) => {
    const message = raw as { type?: string, version?: number, id?: string, sessionId?: string, text?: string } | null
    if (message?.type === 'routing_bind' && message.version === 1 && typeof message.sessionId === 'string') {
      mains.add(message.sessionId)
      const agent = ctx.agents.get(SessionId(message.sessionId))
      if (agent) narrow(agent)
      if (port.connected) port.send!({ type: 'routing_bound', version: 1, id: message.id, ok: true }, () => {})
    }
    if (config.fast && message?.type === 'steer' && typeof message.sessionId === 'string' && typeof message.text === 'string') fastLane(message.sessionId, message.text)
  }
  port.on('message', onMessage)
  ctx.effect(() => () => { port.off('message', onMessage) }, 'routing bind channel')

  // ── Ledger: requests come in with the user's messages; the step and turn follow the agent.
  ctx.on('session/event', (session, event) => {
    const id = String(session.id)
    if (!mains.has(id) || event.type !== 'user/message') return
    const text = textOf((event.data as { content?: unknown }).content)
    for (const request of requestsIn(text)) {
      const before = ledgerOf(id)
      const after = update(id, ledger => register(ledger, request.id, text.includes('【插话】')))
      if (after !== before) record(id, 'request_registered', { requestId: request.id, step: after.step, interjection: text.includes('【插话】') })
    }
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const id = String(payload.agent.session.id)
    if (mains.has(id)) update(id, ledger => atStep(ledger, payload.turn, payload.step))
    return next()
  })

  // ── Tools: the policy decides every call of the main agent; an app change uses up the grant that allowed it.
  ctx.tools.guard(exec => {
    if (!exec.agent) return undefined
    const id = String(exec.agent.session.id)
    if (!mains.has(id)) return exec.name === ROUTE_TOOL ? 'only the main conversation routes requests' : undefined
    const decision = admit(grants.get(id) ?? [], exec.name)
    grants.set(id, decision.grants)
    record(id, decision.allowed ? 'tool_call' : 'guard_denied', { tool: exec.name, ...(decision.allowed ? {} : { reason: decision.reason }) })
    return decision.allowed ? undefined : decision.reason
  })

  async function perform(action: Action, requestId: string, sessionId: string, signal?: AbortSignal): Promise<Receipt> {
    if (action.kind === 'start') return actions.start(action.brief, sessionId, signal)
    if (action.kind === 'message') return actions.message(action.taskId, action.text, sessionId, signal)
    if (action.kind === 'stop') return actions.stop(action.taskId, sessionId, signal)
    if (action.kind === 'app_action') {
      grants.set(sessionId, [...(grants.get(sessionId) ?? []), { requestId, operation: action.operation }])
      return { ok: true, granted: action.operation }
    }
    return { ok: true }
  }

  ctx.tools.register(defineTool({
    name: ROUTE_TOOL, description: COMMIT_DESCRIPTION, parameters: COMMIT_PARAMETERS,
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => {
      const agent = exec.agent
      if (!agent) throw new Error('missing agent')
      const id = String(agent.session.id), requestId = String(args.requestId)
      const reject = (reason: string): never => { record(id, 'route_rejected', { requestId, reason }); throw new Error(reason) }
      const problem = decisionProblem(ledgerOf(id), requestId)
      if (problem) reject(problem)
      const parsed = parsePlan({ goals: args.goals, actions: args.actions })
      if ('problem' in parsed) return reject(parsed.problem)
      const receipts: Array<{ kind: string, receipt: Receipt }> = []
      for (const action of parsed.plan.actions) receipts.push({ kind: action.kind, receipt: await perform(action, requestId, id, exec.signal) })
      // A handover that did not happen (the five places full, a task gone) is said to the user, not passed over.
      const failed = receipts.some(r => !r.receipt.ok)
      const status = statusOfPlan(parsed.plan.actions.map(a => a.kind), failed)
      const ledger = update(id, l => decide(l, requestId, status))
      record(id, 'route_committed', { requestId, goals: parsed.plan.goals, actions: parsed.plan.actions, receipts, status, step: ledger.step })
      if (!hasOpenWork(ledger)) exec.concludeTurn()
      const next = failed ? '有动作没有办成（见 receipts），请在下一步如实告诉用户哪件事没办成、原因和可以怎么做。'
        : status === 'answering' ? '请在下一步回答这个请求。'
          : status === 'asking' ? '请在下一步把问题问出来，然后结束。'
            : status === 'acting' ? '请在下一步调用 app_action 里写的工具（每个只能一次），然后用一句话告诉用户结果。'
              : hasOpenWork(ledger) ? '已交接；继续处理仍在进行的回答。' : '已交接，界面会显示任务卡片；结束本轮，不要等待任务结果。'
      return { text: JSON.stringify({ accepted: true, requestId, receipts, next }) }
    },
  }))

  // ── End of a turn: nothing undecided is passed over; an error ending fails what it left, an unused grant is dropped.
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const id = String(agent.session.id)
    if (!mains.has(id)) return
    const pendingFast = fastWork.get(id)
    if (pendingFast?.size) await Promise.race([Promise.allSettled([...pendingFast]), new Promise(resolve => setTimeout(resolve, FAST_WAIT_MS))])
    const unused = grants.get(id) ?? []
    if (unused.length) { record(id, 'grant_unused', { operations: unused.map(g => g.operation) }); grants.set(id, []) }
    const plan = repairs(ledgerOf(id), MAX_REPAIRS)
    ledgers.set(id, plan.ledger)
    for (const requestId of plan.failed) record(id, 'route_failed', { requestId, reason: 'repairs used up' })
    if (!plan.retry.length) return
    record(id, 'repair', { requestIds: plan.retry })
    agent.steer(userNote(`【路由补交】以下请求还没有提交 commit_route：${plan.retry.join('、')}。先逐个提交有效路由再结束；不得直接用正文代替。`))
  })
  ctx.on('agent/error', ({ agent, error }) => {
    const id = String(agent.session.id)
    if (!mains.has(id)) return
    const outcome = failUndecided(ledgerOf(id))
    ledgers.set(id, outcome.ledger)
    grants.set(id, [])
    for (const requestId of outcome.failed) record(id, 'route_failed', { requestId, reason: 'turn ended in an error', error: error instanceof Error ? error.message : String(error) })
  })

  // ── Output: a main session's text shows only when its ledger lets it speak.
  installGatedStream(ctx, (sessionId, step) => {
    if (!mains.has(sessionId)) return true
    const shown = mayShow(ledgerOf(sessionId), step)
    record(sessionId, 'attempt_gate', { step, shown })
    return shown
  }, port)

  // ── Fast lane: words said mid-answer, decided at once when they plainly go to a task, else left to the agent.
  function fastLane(sessionId: string, text: string) {
    const request = requestsIn(text)[0]
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!mains.has(sessionId) || !request || !agent) return
    const claimed = claimFast(ledgerOf(sessionId), request.id)
    if (!claimed) return
    ledgers.set(sessionId, claimed)
    const began = Date.now()
    record(sessionId, 'fast_started', { requestId: request.id })
    const work = decideFast(agent, sessionId, request.id, request.words)
      .then(({ handed, data }) => { update(sessionId, l => settleFast(l, request.id, handed)); record(sessionId, handed ? 'fast_committed' : 'fast_deferred', { requestId: request.id, ...data, ms: Date.now() - began }) })
      .catch((error: unknown) => { update(sessionId, l => settleFast(l, request.id, false)); record(sessionId, 'fast_failed', { requestId: request.id, error: error instanceof Error ? error.message : String(error), ms: Date.now() - began }) })
    const set = fastWork.get(sessionId) ?? new Set<Promise<void>>()
    fastWork.set(sessionId, set)
    set.add(work)
    void work.finally(() => set.delete(work))
  }

  async function decideFast(agent: Agent, sessionId: string, requestId: string, words: string): Promise<{ handed: boolean, data: Record<string, unknown> }> {
    const signal = AbortSignal.timeout(FAST_WAIT_MS)
    const tasks = await actions.list(sessionId, signal)
    const recent: FastTurn[] = agent.session.snapshotEvents().filter(event => event.type === 'user/message' || event.type === 'assistant/message').map(event => {
      const data = event.data as { content?: unknown, message?: { content?: unknown } }
      return { role: event.type === 'user/message' ? 'user' as const : 'assistant' as const, text: withoutHeaders(textOf(data.message?.content ?? data.content)) }
    }).filter(turn => turn.text.trim())
    const decision = parseFastDecision(await complete(ctx, agent, fastInput({ recent, tasks, words }), signal), tasks)
    if (decision.decision === 'defer') return { handed: false, data: { reason: decision.reason } }
    const action: Action = decision.decision === 'start' ? { kind: 'start', brief: decision.brief } : decision.decision === 'message' ? { kind: 'message', taskId: decision.taskId, text: decision.text } : { kind: 'stop', taskId: decision.taskId }
    const receipt = await perform(action, requestId, sessionId, signal)
    if (!receipt.ok) return { handed: false, data: { decision, receipt } }
    if (agent.status === 'running') agent.steer(userNote(fastNotice(requestId, decision, receipt)))
    return { handed: true, data: { decision, receipt } }
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
    messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: name } as unknown as MessageSource })],
  })
  for await (const chunk of stream) assembler.push(chunk)
  return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
}
