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
import { createUserMessage, freezeMessage, MessageId, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSteerChannel, REASONS } from './lib/channel.ts'
import { createReportDesk, REPORT_SOURCE, reportMessageId, type ReportAgent, type ReportMessage } from './lib/reports.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A background task's result the app steered in (lib/reports.ts), named by its report. */
    'viva-report': { kind: 'viva-report', reportId: string } & ContextFormed
  }
}

export const name = 'viva-steer'
export const inject = ['agents', 'sessions']
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: nothing to steer from')
    return
  }
  /** Only a running turn takes steering; an idle agent would start a turn of its own, outside the app's prompt. */
  function steer(sessionId: string, text: string) {
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!agent) return REASONS.missing
    if (agent.status !== 'running') return REASONS.idle
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
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
      steer: (reportId, text) => agent.steer(freezeMessage({
        id: MessageId(reportMessageId(reportId)),
        role: 'user' as const,
        content: [{ type: 'text' as const, text }],
        source: { kind: REPORT_SOURCE, reportId, form: 'notice' as const, summary: '后台任务的结果' },
      })),
    }
  }
  const reports = createReportDesk({ agentOf: reportAgent, send: (message) => { port.send?.(message) }, log })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') void reports.written(String(session.id), event.data as ReportMessage)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => reports.taken(String(agent.id), message as ReportMessage))
  ctx.on('agent/inbox/discarded', ({ agent, message }) => reports.discarded(String(agent.id), message as ReportMessage))
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') reports.idle(String(agent.id)) })

  const channel = createSteerChannel({ send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) }, steer, log, reports)
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.effect(() => () => channel.close(), 'steer channel')
}
