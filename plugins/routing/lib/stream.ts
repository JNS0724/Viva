/**
 * The stream contract (version 1, as plugins/stream), with a gate: an attempt the main agent may not show yet still
 * opens and settles, but carries no text. Dropping it whole would leave the app's ACP fallback to show the text
 * (src/backend/assistant-stream.ts complete(): no key started, fallback emitted), which the probe saw happen.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

type Block = { type: string, text?: unknown }
type StoredEvent = { seq: number, type: string, data: { turn: number, step: number, message: { content: Block[] } } }
type Active = { operation: string, key: string, attemptId: string, turn: number, step: number, open: boolean, event?: StoredEvent }
type Message = { type?: string, version?: number, operation?: string, sessionId?: string }

const visible = (block: Block) => Boolean(block) && (block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string'

/** @param mayShow whether this attempt of this session may show its text, decided once when it starts */
export function installGatedStream(ctx: Context, mayShow: (sessionId: string, step: number) => boolean, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') return
  const send = (message: object) => { if (port.connected) port.send!(message, () => {}) }
  const bindings = new Map<string, { operation: string, from: number, keys: Map<number, string>, shown: Set<number> }>()
  const generations = new WeakMap<Agent, number>()
  const active = new WeakMap<object, Active>()
  let generation = 0
  const receive = (message: Message) => {
    if (message?.type === 'assistant_stream_flush' && message.version === 1) {
      const bound = [...bindings].find(([, binding]) => binding.operation === message.operation)
      const binding = bound?.[1]
      const agent = bound && ctx.agents?.get(SessionId(bound[0]))
      const answers = agent && binding ? agent.session.snapshotEvents().filter(event => event.seq >= binding.from && event.type === 'assistant/message') : []
      const messages = answers.map(event => {
        const data = event.data as StoredEvent['data']
        return { key: binding!.keys.get(event.seq) ?? `${message.operation}:committed:${event.seq}`,
          blocks: binding!.shown.has(event.seq) ? data.message.content.filter(visible).map(block => ({ type: block.type, text: block.text })) : [] }
      })
      const last = answers.at(-1)
      const content = (last?.data as StoredEvent['data'] | undefined)?.message.content ?? []
      send({ type: 'assistant_stream_flushed', version: 1, operation: message.operation, messages,
        finalReply: Boolean(last && binding?.shown.has(last.seq) && content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim())
          && !content.some(block => block.type === 'tool-call')) })
      return
    }
    if (message?.type !== 'assistant_stream_bind' || message.version !== 1 || typeof message.sessionId !== 'string' || typeof message.operation !== 'string') return
    const agent = ctx.agents?.get(SessionId(message.sessionId))
    bindings.set(message.sessionId, { operation: message.operation, from: agent?.session.seq ?? 0, keys: new Map(), shown: new Set() })
    send({ type: 'assistant_stream_bound', version: 1, operation: message.operation })
  }
  port.on('message', receive)
  port.channel?.unref?.()
  ctx.effect(() => () => { port.off('message', receive); bindings.clear() }, 'routing stream channel')
  ctx.on('session/event', (session, event) => {
    const attempt = active.get(session)
    const data = event.data as { turn?: number, step?: number }
    if (attempt && (event.type === 'assistant/message' || event.type === 'assistant/attempt') && data.turn === attempt.turn && data.step === attempt.step) {
      attempt.event = event as unknown as StoredEvent
      const binding = bindings.get(String(session.id))
      if (event.type === 'assistant/message' && binding?.operation === attempt.operation) {
        binding.keys.set(event.seq, attempt.key)
        if (attempt.open) binding.shown.add(event.seq)
      }
    }
  })
  ctx.on('agent/disposed', ({ agent }) => { bindings.delete(String(agent.session.id)); active.delete(agent.session) })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const session = agent.session
    const sessionId = String(session.id)
    if (frame.type === 'start') {
      const operation = bindings.get(sessionId)?.operation
      if (!operation) return
      if (!generations.has(agent)) generations.set(agent, ++generation)
      active.set(session, { operation, key: `${operation}:${generations.get(agent)}:${frame.attemptId}`, attemptId: String(frame.attemptId), turn: frame.turn, step: frame.step, open: mayShow(sessionId, frame.step) })
    }
    const attempt = active.get(session)
    if (!attempt || attempt.attemptId !== String(frame.attemptId)) return
    const base = { type: 'assistant_stream', version: 1, sessionId, operation: attempt.operation, key: attempt.key }
    if (frame.type === 'start') send({ ...base, kind: 'start' })
    if (frame.type === 'chunk' && attempt.open) {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') send({ ...base, kind: 'delta', index: chunk.index, blockType: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text })
      else if (chunk.type === 'block-end' && visible(chunk.block as Block)) send({ ...base, kind: 'block', index: chunk.index, blockType: chunk.block.type, text: (chunk.block as { text: string }).text })
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
