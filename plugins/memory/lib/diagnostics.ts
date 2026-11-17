import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import { emitDiagnostic, withOperation } from '../../../src/diagnostics/node/context.ts'
import { safeDiagnosticReason } from '../../../src/diagnostics/contracts.ts'
import type { DiagnosticFields } from '../../../src/diagnostics/contracts.ts'

/** Public DSH observation only. No raw args, event bodies, console formatting or transport mutation. */
export function observeDshDiagnostics(ctx: Context) {
  const observe = (read: () => void) => {
    try { read() } catch { emitDiagnostic({ event: 'context.dropped', operation: 'plugin', reason: 'invalid_context' }) }
  }
  observe(() => {
    ctx.logger.exporter({ colors: false, export(message) {
      observe(() => {
        emitDiagnostic({ event: 'operation.progress', operation: 'plugin',
          ...(message.type === 'debug' ? { debug: true as const } : {}),
          identities: { methodId: message.name }, metrics: { count: message.args.length, eventCursor: message.sn },
          ...(message.type === 'error' ? { reason: 'unknown_error' as const, outcome: 'failed' as const } : {}) })
      })
    } })
    ctx.on('tools/execute', (execution, next) => {
      let fields: DiagnosticFields = {}
      observe(() => { fields = { identities: { requestId: String(execution.callId), methodId: execution.name } } })
      return withOperation('tool', () => next(), fields)
    })
    ctx.on('tools/result', (execution, result) => {
      observe(() => {
        emitDiagnostic({ event: 'operation.progress', operation: 'tool', stage: 'complete',
          identities: { requestId: String(execution.callId), methodId: execution.name, ...(result.isError && result.error.info ? { resourceId: result.error.info.code } : {}) }, metrics: { ok: !result.isError } })
      })
      return undefined
    })
    ctx.on('session/event', (session, event) => {
      observe(() => {
        emitDiagnostic({ event: 'operation.progress', operation: 'conversation', stage: 'checkpoint',
          identities: { sessionId: String(session.id), methodId: event.type }, metrics: { eventCursor: event.seq } })
      })
    })
    ctx.on('agent/status', payload => {
      observe(() => {
        const { agent, status } = payload
        emitDiagnostic({ event: 'state.changed', operation: 'conversation', stage: status === 'running' ? 'running' : 'ready', identities: { sessionId: String(agent.session.id) } })
      })
    })
    ctx.on('agent/error', payload => {
      observe(() => {
        const { agent, error } = payload
        emitDiagnostic({ event: 'operation.progress', operation: 'conversation', stage: 'failed', reason: safeDiagnosticReason(error), identities: { sessionId: String(agent.session.id) } })
      })
    })
  })
}
