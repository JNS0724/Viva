/** Live model output beside ACP. Only visible blocks cross this channel; durable events settle them. */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const name = 'viva-stream'
export const inject = ['agents']
export const Config = z.object({})

const visible = (block: any) => block && (block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string'

export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') return
  const send = (message: object) => { if (port.connected) port.send!(message, () => {}) }
  const bindings = new Map<string, string>()
  const generations = new WeakMap<Agent, number>()
  const active = new WeakMap<object, { operation: string, key: string, attemptId: string, turn: number, step: number, event?: any }>()
  let generation = 0
  const receive = (message: any) => {
    if (message?.type === 'assistant_stream_flush' && message.version === 1) {
      send({ type: 'assistant_stream_flushed', version: 1, operation: message.operation })
      return
    }
    if (message?.type !== 'assistant_stream_bind' || message.version !== 1 || typeof message.sessionId !== 'string' || typeof message.operation !== 'string') return
    bindings.set(message.sessionId, message.operation)
    send({ type: 'assistant_stream_bound', version: 1, operation: message.operation })
  }
  port.on('message', receive)
  port.channel?.unref?.()
  ctx.effect(() => () => { port.off('message', receive); bindings.clear() }, 'stream channel')
  ctx.on('session/event', (session, event) => {
    const attempt = active.get(session)
    if (attempt && (event.type === 'assistant/message' || event.type === 'assistant/attempt')
      && event.data.turn === attempt.turn && event.data.step === attempt.step) attempt.event = event
  })
  ctx.on('agent/disposed', ({ agent }) => { bindings.delete(String(agent.session.id)); active.delete(agent.session) })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const session = agent.session
    const sessionId = String(session.id)
    if (frame.type === 'start') {
      const operation = bindings.get(sessionId)
      if (!operation) return
      if (!generations.has(agent)) generations.set(agent, ++generation)
      const key = `${operation}:${generations.get(agent)}:${frame.attemptId}`
      active.set(session, { operation, key, attemptId: String(frame.attemptId), turn: frame.turn, step: frame.step })
    }
    const attempt = active.get(session)
    if (!attempt || attempt.attemptId !== String(frame.attemptId)) return
    const base = { type: 'assistant_stream', version: 1, sessionId, operation: attempt.operation, key: attempt.key }
    if (frame.type === 'start') send({ ...base, kind: 'start' })
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        send({ ...base, kind: 'delta', index: chunk.index, blockType: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text })
      } else if (chunk.type === 'block-end' && visible(chunk.block)) {
        send({ ...base, kind: 'block', index: chunk.index, blockType: chunk.block.type, text: (chunk.block as { text: string }).text })
      }
    }
    if (frame.type === 'end') {
      const event = attempt.event
      const committed = frame.outcome.kind === 'committed' && event?.seq === frame.outcome.seq && event.type === frame.outcome.eventType
      const blocks = committed && event.type === 'assistant/message' ? event.data.message.content.filter(visible).map((block: any) => ({ type: block.type, text: block.text })) : []
      send({ ...base, kind: 'settle', blocks })
      active.delete(session)
    }
  })
  send({ type: 'assistant_stream_ready', version: 1 })
}
