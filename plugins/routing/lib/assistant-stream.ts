/**
 * The stream contract (version 1; src/backend/assistant-stream.ts is the app's side): live model output beside ACP,
 * the only way the app shows what the model says. Only visible blocks cross this channel; durable events settle them.
 * A gate decides, as each attempt starts, whether it may show: one that may not (a routing step of the main agent)
 * still opens and settles but carries no text, and a flush returns only what was shown. A notice (`announce`) is a line
 * the plugin shows itself, as the turn's answer: what a handover did, when the turn ends with it.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

type Block = { type: string, text?: unknown }
type StoredEvent = { seq: number, type: string, data: { turn: number, step: number, message: { content: Block[] } } }
type Active = { operation: string, key: string, attemptId: string, turn: number, step: number, open: boolean, event?: StoredEvent }
type Notice = { key: string, text: string, after: number }
type Binding = { operation: string, from: number, keys: Map<number, string>, shown: Set<number>, notices: Notice[] }
type Message = { type?: string, version?: number, operation?: string, sessionId?: string }
/** Whether the attempt of this session at this step may show its text, decided once when it starts. */
export type Gate = (sessionId: string, step: number) => boolean

const visible = (block: Block) => Boolean(block) && (block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string'
const shownBlocks = (content: readonly Block[]) => content.filter(visible).map(block => ({ type: block.type, text: block.text as string }))

export interface AssistantStream {
  /** Shows `text` in the session's running operation as an answer of its own; false when nothing is bound to show it in. */
  announce: (sessionId: string, text: string) => boolean
}

export function installAssistantStream(ctx: Context, port: NodeJS.Process, gate: Gate): AssistantStream {
  if (typeof port.send !== 'function') return { announce: () => false }
  const send = (message: object) => { if (port.connected) port.send!(message, () => {}) }
  const bindings = new Map<string, Binding>()
  const generations = new WeakMap<Agent, number>()
  const active = new WeakMap<object, Active>()
  let generation = 0
  const wasShown = (binding: Binding, seq: number) => binding.shown.has(seq)

  function flushed(operation: string | undefined) {
    const bound = [...bindings].find(([, binding]) => binding.operation === operation)
    const binding = bound?.[1]
    const agent = bound && ctx.agents?.get(SessionId(bound[0]))
    if (!agent || !binding) return { messages: [], finalReply: false }
    const answers = agent.session.snapshotEvents().filter(event => event.seq >= binding.from && event.type === 'assistant/message')
    const messages = [
      ...answers.map(event => ({
        key: binding.keys.get(event.seq) ?? `${operation}:committed:${event.seq}`,
        blocks: wasShown(binding, event.seq) ? shownBlocks((event.data as StoredEvent['data']).message.content) : [],
      })),
      ...binding.notices.map(notice => ({ key: notice.key, blocks: [{ type: 'text', text: notice.text }] })),
    ]
    const last = answers.at(-1)
    const notice = binding.notices.at(-1)
    // A notice given after the last answer is the turn's last word.
    if (notice && notice.after >= (last?.seq ?? -1)) return { messages, finalReply: true }
    const content = (last?.data as StoredEvent['data'] | undefined)?.message.content ?? []
    const finalReply = Boolean(last && wasShown(binding, last.seq) && content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim())
      && !content.some(block => block.type === 'tool-call'))
    return { messages, finalReply }
  }

  const receive = (message: Message) => {
    if (message?.type === 'assistant_stream_flush' && message.version === 1) {
      send({ type: 'assistant_stream_flushed', version: 1, operation: message.operation, ...flushed(message.operation) })
      return
    }
    if (message?.type !== 'assistant_stream_bind' || message.version !== 1 || typeof message.sessionId !== 'string' || typeof message.operation !== 'string') return
    const agent = ctx.agents?.get(SessionId(message.sessionId))
    bindings.set(message.sessionId, { operation: message.operation, from: agent?.session.seq ?? 0, keys: new Map(), shown: new Set(), notices: [] })
    send({ type: 'assistant_stream_bound', version: 1, operation: message.operation })
  }
  port.on('message', receive)
  port.channel?.unref?.()
  ctx.effect(() => () => { port.off('message', receive); bindings.clear() }, 'stream channel')
  // A committed answer is shown if its attempt was; one committed without an attempt seen, if the gate lets its step
  // show now, while the turn is on (by the flush the turn is over).
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const sessionId = String(session.id)
    const data = event.data as { turn?: number, step?: number }
    const attempt = active.get(session)
    const ofAttempt = attempt && data.turn === attempt.turn && data.step === attempt.step ? attempt : null
    if (ofAttempt) ofAttempt.event = event as unknown as StoredEvent
    const binding = bindings.get(sessionId)
    if (event.type !== 'assistant/message' || !binding) return
    if (!ofAttempt) {
      if (gate(sessionId, data.step ?? 0)) binding.shown.add(event.seq)
      return
    }
    if (binding.operation !== ofAttempt.operation) return
    binding.keys.set(event.seq, ofAttempt.key)
    if (ofAttempt.open) binding.shown.add(event.seq)
  })
  ctx.on('agent/disposed', ({ agent }) => { bindings.delete(String(agent.session.id)); active.delete(agent.session) })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const session = agent.session
    const sessionId = String(session.id)
    if (frame.type === 'start') {
      const operation = bindings.get(sessionId)?.operation
      if (!operation) return
      if (!generations.has(agent)) generations.set(agent, ++generation)
      const key = `${operation}:${generations.get(agent)}:${frame.attemptId}`
      active.set(session, { operation, key, attemptId: String(frame.attemptId), turn: frame.turn, step: frame.step, open: gate(sessionId, frame.step) })
    }
    const attempt = active.get(session)
    if (!attempt || attempt.attemptId !== String(frame.attemptId)) return
    const base = { type: 'assistant_stream', version: 1, sessionId, operation: attempt.operation, key: attempt.key }
    if (frame.type === 'start') send({ ...base, kind: 'start' })
    if (frame.type === 'chunk' && attempt.open) {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        send({ ...base, kind: 'delta', index: chunk.index, blockType: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text })
      } else if (chunk.type === 'block-end' && visible(chunk.block as Block)) {
        send({ ...base, kind: 'block', index: chunk.index, blockType: chunk.block.type, text: (chunk.block as { text: string }).text })
      }
    }
    if (frame.type === 'end') {
      const event = attempt.event
      const committed = attempt.open && frame.outcome.kind === 'committed' && event?.seq === frame.outcome.seq && event.type === frame.outcome.eventType
      send({ ...base, kind: 'settle', blocks: committed && event?.type === 'assistant/message' ? shownBlocks(event.data.message.content) : [] })
      active.delete(session)
    }
  })
  send({ type: 'assistant_stream_ready', version: 1 })

  function announce(sessionId: string, text: string): boolean {
    const binding = bindings.get(sessionId)
    const agent = ctx.agents?.get(SessionId(sessionId))
    if (!binding || !agent || !text.trim()) return false
    const notice = { key: `${binding.operation}:notice:${binding.notices.length + 1}`, text: text.trim(), after: agent.session.seq }
    binding.notices = [...binding.notices, notice]
    const base = { type: 'assistant_stream', version: 1, sessionId, operation: binding.operation, key: notice.key }
    send({ ...base, kind: 'start' })
    send({ ...base, kind: 'settle', blocks: [{ type: 'text', text: notice.text }] })
    return true
  }
  return { announce }
}
