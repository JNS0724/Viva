/**
 * viva-trace: records what each turn did and the exact request of every model call into trace.db.
 * Live summaries use the app's IPC channel; full requests stay in the local store until the detail view asks for them.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ModelCallStatus, ModelCallSummary, ModelRequest } from '../../src/shared/trace.ts'
import { stepsFrom } from './lib/steps.ts'
import { openTraceDb } from './lib/store.ts'

export const name = 'viva-trace'
export const inject = ['agents']
export const Config = z.object({ file: z.string() })

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)

function turnEvents(agent: Agent, turn: number) {
  const events: Array<NonNullable<ReturnType<Agent['session']['eventAt']>>> = []
  for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type === 'turn/start' && event.data.turn === turn) break
    if (event) events.push(event)
  }
  return events.reverse()
}

function requestOf(session: Session): ModelRequest {
  const header = session.requestHeader()
  const route = session.requestContext()
  const config = header?.config ?? { provider: route?.provider ?? '', model: route?.model ?? '' }
  return {
    provider: String(config.provider ?? route?.provider ?? ''),
    model: String(config.model ?? route?.model ?? ''),
    config: { ...config },
    messages: session.deriveMessages(),
    tools: header?.tools ?? [],
  }
}

export function apply(ctx: Context, config: { file: string }, port: NodeJS.Process = process) {
  if (!config?.file) throw new Error(`${name}: config.file (the trace.db path) is required`)
  const db = openTraceDb({ file: config.file })
  ctx.effect(() => () => db.close(), 'trace.db')
  const publish = (call: ModelCallSummary) => {
    if (typeof port.send === 'function') port.send({ type: 'trace_model_call', version: 1, sessionId: call.sessionId, call })
  }

  function startCall(agent: Agent, frame: Extract<AssistantStreamFrame, { type: 'start' }>) {
    const session = agent.session
    const sessionId = String(session.id)
    const previous = db.callOf(sessionId, frame.turn, frame.step)?.call
    const request = requestOf(session)
    const call: ModelCallSummary = {
      sessionId, turn: frame.turn, step: frame.step, at: previous?.at ?? Date.now(), status: 'running',
      provider: request.provider, model: request.model, attempts: (previous?.attempts ?? 0) + 1,
      inputTokens: null, outputTokens: null, durationMs: null,
    }
    db.recordCall(call, request)
    publish(call)
  }

  function settleCall(session: Session, event: SessionEvent<'assistant/message' | 'assistant/attempt'>) {
    const sessionId = String(session.id)
    const previous = db.callOf(sessionId, event.data.turn, event.data.step)?.call
    if (!previous) return
    const usage = event.type === 'assistant/message' ? event.data.usage : undefined
    const inputTokens = usage ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : null
    const call: ModelCallSummary = {
      ...previous,
      status: event.type === 'assistant/message' ? 'completed' : 'failed',
      inputTokens, outputTokens: usage?.outputTokens ?? null,
      durationMs: Math.max(0, event.time - previous.at),
    }
    db.recordCall(call)
    publish(call)
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    try {
      if (frame.type === 'start') startCall(agent, frame)
    } catch (err) {
      log(`could not record model request: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') settleCall(session, event)
    } catch (err) {
      log(`could not settle model request: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  ctx.on('agent/error', ({ agent, turn, step }) => {
    try {
      const previous = db.callOf(String(agent.session.id), turn, step)?.call
      if (!previous || previous.status !== 'running') return
      const call: ModelCallSummary = { ...previous, status: 'failed' as ModelCallStatus, durationMs: Math.max(0, Date.now() - previous.at) }
      db.recordCall(call)
      publish(call)
    } catch (err) {
      log(`could not fail model request: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      const steps = stepsFrom(turnEvents(agent, turn))
      if (steps.length) db.recordSteps(String(agent.session.id), steps)
    } catch (err) {
      log(`could not record turn ${turn}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
