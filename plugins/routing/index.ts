/**
 * viva-routing (docs/agent-routing-design.md): the main agent routes every request of the conversation; the work goes
 * to tasks. The app binds the main session before each prompt and puts each request under its header
 * (src/backend/acp-bridge.ts); this plugin narrows that session to the main agent's tools and persona, keeps the
 * turn's ledger (lib/ledger.ts), passes each commit_route to the app, which decides it (lib/host.ts), guards every
 * call (lib/policy.ts), shows text only once a request may be answered (lib/assistant-stream.ts, the stream contract)
 * and hands words said mid-answer to a task at once when that is plain (lib/fast-lane.ts). Tasks are never bound.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import * as persona from '@deepseek-ai/dsh-persona'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { requestsIn, withoutHeaders } from '../../src/shared/request-routing/header.ts'
import { createTasksChannel } from '../tasks/lib/channel.ts'
import { installAssistantStream } from './lib/assistant-stream.ts'
import { COMMIT_DESCRIPTION, COMMIT_PARAMETERS, MAX_NOTICE_CHARS } from './lib/commit.ts'
import { deferCode, FAST_SYSTEM, fastInput, fastNotice, fastPlan, fastTasks, parseFastDecision, type FastHandover, type FastTurn } from './lib/fast-lane.ts'
import type { FastOutcome } from '../../src/shared/request-routing/channel.ts'
import { atStep, claimFast, decide, decisionProblem, EMPTY_LEDGER, hasOpenWork, mayShow, register, repairs, settleFast, statusOfPlan, type Ledger, type RequestStatus } from './lib/ledger.ts'
import { admit, MAIN_SCOPE, ROUTE_TOOL, type Grant } from './lib/policy.ts'
import { createHostChannel } from './lib/host.ts'

export const name = 'viva-routing'
export const inject = ['agents', 'tools', 'llm']
/** The main agent's persona (src/backend/app-plugins.ts ROUTING_PERSONA): it shadows the profile's, which tasks keep. */
export const Config = z.object({ prefix: z.string().required(), suffix: z.string().default('') })

const MAX_REPAIRS = 2
const FAST_WAIT_MS = 20_000
const FAST_MAX_TOKENS = 1500
const TASK_LIST_WAIT_MS = 5_000

const textOf = (content: unknown) => (Array.isArray(content) ? content as Array<{ type?: string, text?: string }> : []).filter(part => part.type === 'text').map(part => part.text ?? '').join('')
/** Settles when the signal aborts. */
const once = (signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
/**
 * A note to the main agent (a reminder, the fast lane's notice): a user message that says it comes from this plugin,
 * so nothing reads it as the user's words (the memory plugin's extractor, the history). dsh's types list only its own
 * source kinds; this one is cast here, in one place.
 */
const userNote = (text: string) => createUserMessage({ source: { kind: name } as unknown as MessageSource, content: [{ type: 'text', text }] })
const NEXT = {
  failed: '有动作没有办成（见 receipts），请在下一步如实告诉用户哪件事没办成、原因和可以怎么做。',
  answering: '请在下一步回答这个请求。',
  asking: '请在下一步把问题问出来，然后结束。',
  acting: '请在下一步调用 app_action 里写的工具（每个只能一次），然后用一句话告诉用户结果。',
  continuing: '已交接，界面会显示任务卡片；继续把仍在进行的回答说完，在结尾用一句话提一下这件事已经交给后台，只说一次。',
  handed: '已交接，界面已显示你的 notice 和任务卡片；结束本轮，不要等待任务结果。',
  tell: '已交接；请在下一步用一句话告诉用户交给了哪个任务、去做什么，然后结束，不要等待任务结果。',
  unanswered: '提交已发出，但应用没有确认结果，可能已经办了：不要再为它提交 commit_route；请在下一步告诉用户这件事已提交、结果待确认，可以稍后在后台任务里查看。',
} as const

export function apply(ctx: Context, config: { prefix: string, suffix?: string }, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') return

  // ── State: which sessions are main, the ledger of each one's turn, the grants its app_actions gave, fast work, and
  // how many turns each has ended (what the fast lane started in one tells only that one).
  const mains = new Set<string>()
  const narrowed = new WeakSet<Agent>()
  const ledgers = new Map<string, Ledger>()
  const grants = new Map<string, readonly Grant[]>()
  const fastWork = new Map<string, Set<Promise<void>>>()
  const turnsEnded = new Map<string, number>()
  const turnOf = (id: string) => turnsEnded.get(id) ?? 0
  const ledgerOf = (id: string) => ledgers.get(id) ?? EMPTY_LEDGER
  const update = (id: string, change: (ledger: Ledger) => Ledger) => { const next = change(ledgerOf(id)); ledgers.set(id, next); return next }

  // ── Role: a main session gets the main agent's tools and persona before its first step is assembled: of its scope
  // the global tools there are (a plugin that did not load has none), and commit_route, its own, which tasks never see.
  function narrow(agent: Agent) {
    if (!mains.has(String(agent.session.id)) || narrowed.has(agent)) return
    narrowed.add(agent)
    agent.ctx.tools.restrict({ allow: MAIN_SCOPE.filter(tool => tool !== ROUTE_TOOL && ctx.tools.get(tool)) })
    agent.ctx.tools.register(routeTool())
    agent.ctx.plugin(persona, { prefix: config.prefix, suffix: config.suffix ?? '' })
  }
  ctx.on('agent/created', ({ agent }) => { narrow(agent); return undefined })
  const host = createHostChannel(port, { onBind: (sessionId) => {
    mains.add(sessionId)
    const agent = ctx.agents.get(SessionId(sessionId))
    if (agent) narrow(agent)
  } })
  const tasks = createTasksChannel({ send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) }, TASK_LIST_WAIT_MS)
  const onSteer = (raw: unknown) => {
    const message = raw as { type?: string, sessionId?: unknown, text?: unknown } | null
    if (message?.type === 'steer' && typeof message.sessionId === 'string' && typeof message.text === 'string') fastLane(message.sessionId, message.text)
  }
  port.on('message', onSteer)
  port.channel?.unref?.()
  ctx.effect(() => () => { host.close(); tasks.close(); port.off('message', onSteer) }, 'routing channel')

  // ── Ledger: requests come in with the user's messages; it follows the steps and ends with the turn.
  ctx.on('session/event', (session, event) => {
    const id = String(session.id)
    if (!mains.has(id) || event.type !== 'user/message') return
    for (const request of requestsIn(textOf((event.data as { content?: unknown }).content))) update(id, ledger => register(ledger, request.id))
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const id = String(payload.agent.session.id)
    if (mains.has(id)) update(id, ledger => atStep(ledger, payload.step))
    return next()
  })
  // The app fails what a turn leaves undecided (request-runtime.ts endTurn); leave unused by the turn goes with it.
  ctx.on('agent/status', ({ agent, status }) => {
    const id = String(agent.session.id)
    if (status !== 'idle' || !mains.has(id)) return
    ledgers.delete(id)
    grants.delete(id)
    turnsEnded.set(id, turnOf(id) + 1)
  })

  // ── Tools: the policy decides every call of the main agent before dsh asks the user to approve it (a call outside
  // the scope still reaches approval by its name); an app change uses up the grant that allowed it.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const id = String(exec.agent?.session.id ?? '')
    if (!mains.has(id)) return next()
    const decision = admit(grants.get(id) ?? [], exec.name)
    grants.set(id, decision.grants)
    return decision.allowed ? next() : { kind: 'deny', reason: decision.reason ?? '' }
  }, { prepend: true })

  /** commit_route, registered on each main agent: the plan goes to the app, which decides it (lib/host.ts). */
  const routeTool = () => defineTool({
    name: ROUTE_TOOL, description: COMMIT_DESCRIPTION, parameters: COMMIT_PARAMETERS,
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error('missing agent')
      const id = String(exec.agent.session.id), requestId = String(args.requestId)
      const problem = decisionProblem(ledgerOf(id), requestId)
      if (problem) throw new Error(problem)
      const plan = { goals: args.goals, actions: args.actions }
      const decided = await host.decide(id, requestId, plan, exec.signal)
      // Sent and not answered: the host may have taken it, so it is not routed again; the agent says it is unconfirmed.
      if (decided.accepted === 'unanswered') {
        update(id, l => decide(l, requestId, 'answering'))
        return { text: JSON.stringify({ accepted: 'unknown', requestId, reason: decided.reason, next: NEXT.unanswered }) }
      }
      if (!decided.accepted) throw new Error(decided.reason)
      const kinds = decided.receipts.map(receipt => receipt.kind)
      const operations = (args.actions as Array<{ kind?: string, operation?: Grant }>).filter(action => action.kind === 'app_action' && action.operation).map(action => action.operation as Grant)
      grants.set(id, [...(grants.get(id) ?? []), ...operations])
      const failed = decided.receipts.some(receipt => !receipt.ok)
      const planned = statusOfPlan(kinds, failed)
      // A handover that ends the turn is said by its notice, shown as the turn's answer (without one, the agent says it
      // next). One made while the turn has more to say is mentioned at the end of that answer instead, said once.
      const notice = typeof args.notice === 'string' ? args.notice.trim().slice(0, MAX_NOTICE_CHARS) : ''
      const ends = planned === 'handed' && !hasOpenWork(decide(ledgerOf(id), requestId, planned))
      const told = ends && notice !== '' && stream.announce(id, notice)
      const status = ends && !told ? 'answering' : planned
      const ledger = update(id, l => decide(l, requestId, status))
      if (!hasOpenWork(ledger)) exec.concludeTurn()
      const next = failed ? NEXT.failed : status === 'answering' && planned === 'handed' ? NEXT.tell
        : status === 'answering' || status === 'asking' || status === 'acting' ? NEXT[status] : hasOpenWork(ledger) ? NEXT.continuing : NEXT.handed
      return { text: JSON.stringify({ accepted: true, requestId, receipts: decided.receipts, next }) }
    },
  })

  // ── End of a turn: nothing undecided is passed over while reminders are left; the fast lane is waited for.
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const id = String(agent.session.id)
    if (!mains.has(id)) return
    const pendingFast = fastWork.get(id)
    // Each is bounded on its own (its deadline to decide, then the host's to answer a plan sent), so the turn waits for
    // all of them: one that outlived its turn would come back to an idle agent, its outcome told to nobody. A stopped
    // turn waits for nothing and is reminded of nothing: the host has ended its requests (acp-bridge.ts cancel).
    if (pendingFast?.size && !signal.aborted) await Promise.race([Promise.allSettled([...pendingFast]), once(signal)])
    if (signal.aborted) return
    const plan = repairs(ledgerOf(id), MAX_REPAIRS)
    ledgers.set(id, plan.ledger)
    if (plan.retry.length) agent.steer(userNote(`【路由补交】以下请求还没有提交 commit_route：${plan.retry.join('、')}。先逐个提交有效路由再结束；不得直接用正文代替。`))
  })

  // ── Output: a main session's text shows only when its ledger lets it speak.
  const stream = installAssistantStream(ctx, port, (sessionId, step) => !mains.has(sessionId) || mayShow(ledgerOf(sessionId), step))

  // ── Fast lane: words said mid-answer, handed to a task at once when that is plain, else left to the main agent.
  function fastLane(sessionId: string, text: string) {
    const request = requestsIn(text)[0]
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!mains.has(sessionId) || !request || !agent) return
    const began = Date.now()
    const report = (outcome: FastOutcome, reason: string | null) => host.reportFast(sessionId, request.id, outcome, reason, Date.now() - began)
    const claimed = claimFast(ledgerOf(sessionId), request.id)
    if (!claimed) { report('late', null); return }
    ledgers.set(sessionId, claimed)
    const work = handOver(agent, sessionId, request.id, request.words)
      .then(({ decided, reason }) => { update(sessionId, l => settleFast(l, request.id, decided)); report(decided ? 'handed' : 'deferred', reason) })
      .catch((error: unknown) => {
        console.error('[routing] the fast lane failed; the main agent routes the request:', error instanceof Error ? error.message : String(error))
        update(sessionId, l => settleFast(l, request.id, null))
        report('failed', null)
      })
    const set = fastWork.get(sessionId) ?? new Set<Promise<void>>()
    fastWork.set(sessionId, set)
    set.add(work)
    void work.finally(() => set.delete(work))
  }

  /** The status the host's acceptance gave the request, or null when it is left to the main agent; with why, as a code. */
  async function handOver(agent: Agent, sessionId: string, requestId: string, words: string): Promise<{ decided: RequestStatus | null, reason: string | null }> {
    // Its notice goes only to the turn it was said in, still running: a turn stopped and another begun is not told.
    const turn = turnOf(sessionId)
    const stillOn = () => turnOf(sessionId) === turn && agent.status === 'running'
    const signal = AbortSignal.timeout(FAST_WAIT_MS)
    const listed = fastTasks(await tasks.request({ op: 'list', limit: 30 }, sessionId, signal))
    const recent: FastTurn[] = agent.session.snapshotEvents().filter(event => event.type === 'user/message' || event.type === 'assistant/message').map(event => {
      const data = event.data as { content?: unknown, message?: { content?: unknown } }
      return { role: event.type === 'user/message' ? 'user' as const : 'assistant' as const, text: withoutHeaders(textOf(data.message?.content ?? data.content)) }
    }).filter(turn => turn.text.trim())
    const decision = parseFastDecision(await complete(ctx, agent, fastInput({ recent, tasks: listed, words }), signal), listed)
    if (decision.decision === 'defer') return { decided: null, reason: deferCode(decision) }
    // The deadline is for deciding: a plan sent is the host's, and its answer is waited for as for the agent's own commit.
    const decided = await host.decide(sessionId, requestId, fastPlan(words, decision))
    if (decided.accepted === 'unanswered') {
      if (stillOn()) agent.steer(userNote(fastNotice(requestId, decision as FastHandover, null)))
      return { decided: 'answering', reason: 'unanswered' }
    }
    if (!decided.accepted) return { decided: null, reason: 'refused' }
    // Accepted, the request is decided at the host whatever its receipts say: a task action not done (no free slot,
    // say) is the agent's to tell, as after its own commit, not to route again.
    const failed = decided.receipts.some(receipt => !receipt.ok)
    if (stillOn()) agent.steer(userNote(fastNotice(requestId, decision as FastHandover, decided.receipts)))
    return { decided: statusOfPlan(decided.receipts.map(receipt => receipt.kind), failed), reason: failed ? 'not done' : null }
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
