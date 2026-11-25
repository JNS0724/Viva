/**
 * viva-steer: what the user says while the agent works reaches the turn that is running, at its next step,
 * instead of waiting for it to end. dsh's agents take such steering (`agent.steer`), but its ACP front end
 * runs one prompt at a time and refuses a second; so the app hands the words to this plugin over the IPC
 * channel it opened when it started dsh (lib/channel.ts), and the plugin gives them to the session's agent.
 * Loaded by the app's dsh profile (src/backend/dsh-profile.ts).
 *
 * It also carries background tasks' results into the main conversation, at most once and confirmed read
 * (lib/reports.ts): it watches the session's history, the inbox and the agent's status for them.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import { createSteerChannel, REASONS } from './lib/channel.ts'
import { createReportDesk, REPORT_SOURCE, reportMessageId, type ReportAgent, type ReportMessage } from './lib/reports.ts'
import {
  liftProvenanceDraft,
  type SteerMessageSource,
  type VivaProvenanceHeader,
} from '../../src/shared/request-routing/provenance.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A background task's result the app steered in (lib/reports.ts), named by its report. */
    'viva-report': { kind: 'viva-report', reportId: string, token: string } & ContextFormed
    'viva-main-human-steer': Extract<SteerMessageSource, { kind: 'viva-main-human-steer' }>
    'viva-task-human-steer': Extract<SteerMessageSource, { kind: 'viva-task-human-steer' }>
    'viva-task-router-message': Extract<SteerMessageSource, { kind: 'viva-task-router-message' }>
    'viva-user-provenance': { kind: 'user', vivaProvenance: VivaProvenanceHeader }
    'viva-report-batch': { kind: 'viva-report-batch', vivaProvenance: VivaProvenanceHeader }
    'viva-unattended': { kind: 'viva-unattended', vivaProvenance: VivaProvenanceHeader }
    'viva-task-brief': { kind: 'viva-task-brief', vivaProvenance: VivaProvenanceHeader }
  }
}

/**
 * Unwrap a leading Viva transport provenance header (`【Viva 元数据：...】\n`) out of `UserMessage.content`
 * into `UserMessage.source`, preserving original `message.id` and returning `freezeMessage(...)`.
 * Strictly idempotent via `'vivaProvenance' in message.source` and `source.kind === 'user'` guard.
 */
export function liftProvenance(message: UserMessage): UserMessage {
  const lifted = liftProvenanceDraft(message.content, message.source as Readonly<Record<string, unknown>>)
  if (!lifted) return message
  return freezeMessage({
    ...message,
    content: lifted.content,
    source: lifted.source as UserMessage['source'],
  })
}

export const name = 'viva-steer'
export const inject = ['agents', 'sessions', 'sessionPersistence']
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)

/**
 * Whether the current open turn (events since the latest `turn/start`) contains a human
 * `source.kind === 'user'` message. Used to prevent `dsh-web-deepseek-api` from walking past a
 * non-human turn (`viva-task-brief`, `viva-report-batch`, `viva-unattended`) and leaking an
 * unrelated earlier human message as `ori_question`.
 */
function currentTurnHasUserPrompt(session: { snapshotEvents(): readonly { type: string, data?: unknown }[] }): boolean {
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'turn/start') return false
    if (event.type === 'user/message') {
      const data = event.data as { source?: { kind?: unknown } } | undefined
      if (data?.source?.kind === 'user') return true
    }
  }
  return false
}

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: nothing to steer from')
    return
  }

  // Unwrap Viva transport provenance headers before commit and LLM send (docs/memory-runtime-decoupling.md §5.4).
  // Deliberately registered WITHOUT `{ prepend: true }` to respect Cordis waterfall onion ordering,
  // and ONLY when launched by the Viva host (`typeof port.send === 'function'`).
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || decision.messages.length === 0) return decision
    let changed = false
    const messages = decision.messages.map(msg => {
      const lifted = liftProvenance(msg)
      if (lifted !== msg) changed = true
      return lifted
    })
    return changed ? { ...decision, messages } : decision
  })

  // Guard `web_search` on non-human turns (`viva-task-brief`, `viva-report-batch`, `viva-unattended`):
  // keep `session.requestContext()` intact for DeepSeek billing while hiding prior-turn human prompts
  // from `dsh-web-deepseek-api`'s `latestUserQuestion` scan so unrelated earlier messages are never
  // leaked as `ori_question`.
  ctx.inject(['tools'], scoped => {
    scoped.on('tools/execute', (execution, next) => {
      if (execution.name !== 'web_search') return next()
      const initiator = ctx.agents.currentInitiator()
      if (!initiator || currentTurnHasUserPrompt(initiator.session)) return next()
      const maskedSession = new Proxy(initiator.session, {
        get(target, prop) {
          if (prop === 'deriveMessages') return () => []
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const maskedAgent = new Proxy(initiator, {
        get(target, prop) {
          if (prop === 'session') return maskedSession
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return ctx.agents.withInitiator(maskedAgent, () => next())
    })
  })
  /** Only a running turn takes steering; an idle agent would start a turn of its own, outside the app's prompt. */
  function steer(sessionId: string, text: string, source?: SteerMessageSource) {
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!agent) return REASONS.missing
    if (agent.status !== 'running') return REASONS.idle
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: source ?? { kind: 'user' } }))
    return null
  }
  /** The main conversation's agent, as lib/reports.ts reads it. */
  function reportAgent(sessionId: string): ReportAgent | null {
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!agent) return null
    return {
      status: agent.status,
      inbox: agent.inbox,
      // A synchronous read of the live session, as plugins/fork does: a resumed session holds its whole stored log.
      history: () => agent.session.snapshotEvents().filter((event) => event.type === 'user/message').map((event) => event.data as ReportMessage),
      flush: () => ctx.sessions.flush(agent.session),
      steer: (reportId, token, text) => agent.steer(freezeMessage({
        id: MessageId(reportMessageId(reportId)),
        role: 'user' as const,
        content: [{ type: 'text' as const, text }],
        source: { kind: REPORT_SOURCE, reportId, token, form: 'notice' as const, summary: '后台任务的结果' },
      })),
    }
  }
  /** A session no agent holds now, as stored: its user messages; null when it is not stored at all. */
  async function stored(sessionId: string): Promise<ReportMessage[] | null> {
    let handle
    try {
      handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read')
    } catch (err) {
      if (err instanceof Error && err.name === 'SessionPersistenceNotFoundError') return null
      throw err
    }
    try {
      const messages: ReportMessage[] = []
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, 512)
        if (!events.length) return messages
        for (const event of events) if (event.type === 'user/message') messages.push(event.data as ReportMessage)
        offset += events.length
      }
    } finally {
      await handle.close()
    }
  }
  const reports = createReportDesk({ agentOf: reportAgent, stored, send: (message) => { port.send?.(message) }, log })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') void reports.written(String(session.id), event.data as ReportMessage)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => reports.taken(String(agent.id), message as ReportMessage))
  ctx.on('agent/inbox/discarded', ({ agent, message }) => reports.discarded(String(agent.id), message as ReportMessage))
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') reports.idle(String(agent.id))
    else if (status === 'running') port.send?.({ type: 'steer_turn_running', sessionId: String(agent.id) })
  })

  const channel = createSteerChannel({ send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) }, steer, log, reports)
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.effect(() => () => channel.close(), 'steer channel')
}
