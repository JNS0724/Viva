import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PluginMemoryOwner, SourceReceipt, DerivedSource } from './owner-port.ts'

import { assertMemorySourceSupported } from './source.ts'

const senderOf = (message: UserMessage): string | undefined => {
  if (!['agent-message', 'subagent-settled'].includes(message.source.kind)) return undefined
  if (!('senderSessionId' in message.source) || typeof message.source.senderSessionId !== 'string' || !message.source.senderSessionId) throw new Error('Derived message sender is unavailable')
  return message.source.senderSessionId
}
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const textOf = (message: { content: readonly { type: string, text?: string }[] }) => message.content.flatMap(part => part.type === 'text' && part.text ? [part.text] : []).join('\n')
type Replay = {
  session: Session, cursor: number, turn: number, step: number, sources: Set<string>, assistant: string[],
  events: Map<number, readonly string[]>, messages: Map<string, string>, queue: Promise<void>,
}

/** Derived host input can query memory, while never becoming new evidence or daily-note input. */
export function retrievalQuestion(receipts: readonly SourceReceipt[]) {
  return receipts.filter(receipt => !receipt.controlReceipt)
    .map(receipt => receipt.retrievalQuery ?? (!receipt.handledIntent ? receipt.text : '')).filter(Boolean).join('\n').slice(0, 20_000)
}

/** DSH's feed announces in-memory commits; flush is the explicit durability boundary. */
export function createSessionIngestion(owner: Pick<PluginMemoryOwner, 'initializeSession' | 'receiveSource' | 'completeTurn' | 'registerDerived'> & { dispatch: Pick<PluginMemoryOwner['dispatch'], 'snapshot'> }, flush: (session: Session) => Promise<unknown>) {
  const states = new Map<string, Replay>()
  function state(session: Session) {
    let current = states.get(session.id)
    if (!current || current.session !== session) {
      current = { session, cursor: 0, turn: 0, step: 0, sources: new Set(), assistant: [], events: new Map(), messages: new Map(), queue: Promise.resolve() }
      states.set(session.id, current)
    }
    return current
  }
  async function original(session: Session, current: Replay, message: UserMessage, options: { at: number, turn: number, step: number, admitted: boolean, live?: boolean, eventSeq?: number, inherited?: boolean }) {
    assertMemorySourceSupported(message.source.kind)
    if (message.source.kind !== 'user') {
      const senderSessionId = senderOf(message)
      if (senderSessionId) await owner.registerDerived({ sessionId: String(session.id), messageId: message.id, sourceIds: [], senderSessionId, inherited: options.inherited })
      return undefined
    }
    const text = textOf(message)
    if (!text.trim() && !message.content.some(part => part.type === 'image' || part.type === 'file')) return undefined
    const receipt = await owner.receiveSource({ sessionId: String(session.id), messageId: message.id, text,
      ...options, timezone: timezone(), inherited: options.inherited ?? false,
      derived: session.header.origin === 'subagent' && !options.inherited && !('rpcId' in message.source && typeof message.source.rpcId === 'string') })
    current.messages.set(message.id, receipt.sourceId)
    if (options.admitted && !receipt.handledIntent) current.sources.add(receipt.sourceId)
    return receipt
  }
  function checkpoint(session: Session) {
    const events = session.snapshotEvents()
    const persisted = flush(session)
    // The serialized consumer owns rejection; do not leave a queued checkpoint unhandled.
    void persisted.catch(() => {})
    return { events, persisted }
  }
  async function replay(session: Session, current: Replay, saved: { events: readonly SessionEvent[], persisted: Promise<unknown> }) {
    await saved.persisted
    if (session.header.origin === 'subagent' && !session.header.parentSession) throw new Error('Subagent parent is unavailable')
    owner.initializeSession({ sessionId: String(session.id), cwd: session.header.cwd,
      ...(session.header.origin === 'subagent' ? { parentSessionId: session.header.parentSession } : {}) })
    const events = saved.events
    for (let index = current.cursor; index < events.length; index++) {
      const event = events[index]!
      const inherited = index < session.inheritedEventCount
      if (event.type === 'turn/start') { current.turn = event.data.turn; current.step = 0; current.sources.clear(); current.assistant = [] }
      if (event.type === 'step/start') { current.turn = event.data.turn; current.step = event.data.step }
      if (event.type === 'agent/inbox/spliced') {
        for (const message of event.data.inserted) await original(session, current, message, { at: event.time, turn: current.turn, step: current.step,
          admitted: false, live: false, eventSeq: event.seq, inherited })
      }
      if (event.type === 'user/message') {
        const receipt = await original(session, current, event.data, { at: event.time, turn: current.turn, step: current.step,
          admitted: true, live: false, eventSeq: event.seq, inherited })
        if (receipt) current.events.set(event.seq, [receipt.sourceId])
        else {
          const dependencies = [...new Set([...(event.sourceEventSeqs ?? []).flatMap(seq => current.events.get(seq) ?? []), ...owner.dispatch.snapshot(String(session.id)).sources])]
          await owner.registerDerived({ sessionId: String(session.id), messageId: event.data.id,
            sourceIds: dependencies, eventSeq: event.seq, inherited })
          current.events.set(event.seq, dependencies)
        }
      }
      if (event.type === 'assistant/message') {
        const dependencies = owner.dispatch.snapshot(String(session.id)).sources
        await owner.registerDerived({ sessionId: String(session.id), messageId: event.data.message.id,
          sourceIds: dependencies, eventSeq: event.seq, inherited })
        current.events.set(event.seq, dependencies)
        if (!event.data.interrupted) current.assistant.push(textOf(event.data.message))
      }
      if (event.type === 'turn/end' && !inherited) {
        await owner.completeTurn({ sessionId: String(session.id), turn: event.data.turn, eventSeq: event.seq,
          sourceIds: [...current.sources], assistant: current.assistant.join('\n'), completed: event.data.reason.kind === 'completed',
          at: event.time, timezone: timezone() })
      }
      current.cursor = index + 1
    }
  }
  function serialize(session: Session, action: (current: Replay) => Promise<void>) {
    const current = state(session)
    // A failed durable registration blocks this session until the owner is recovered/restarted.
    // Advancing past it would let model/tool execution bypass an unregistered original.
    current.queue = current.queue.then(() => action(current))
    return current.queue
  }
  return {
    derived(session: Session, input: Omit<DerivedSource, 'sessionId'>) {
      const saved = checkpoint(session)
      return serialize(session, async current => {
        await replay(session, current, saved)
        await owner.registerDerived({ ...input, sessionId: String(session.id) })
      })
    },
    async drain() { await Promise.allSettled([...states.values()].map(current => current.queue)) },
    synchronize(session: Session) {
      const saved = checkpoint(session)
      return serialize(session, current => replay(session, current, saved))
    },
    async receive(session: Session, messages: readonly UserMessage[], turn: number, step: number, admitted: boolean) {
      const saved = checkpoint(session)
      const receipts: SourceReceipt[] = []
      await serialize(session, async current => {
        await replay(session, current, saved)
        for (const message of messages) {
          const receipt = await original(session, current, message, { at: Date.now(), turn, step, admitted, live: true })
          if (receipt) receipts.push(receipt)
        }
      })
      return receipts
    },
    async titleDependencies(session: Session, seqs: readonly number[]) {
      await this.synchronize(session)
      const current = state(session)
      const sourceIds = [...new Set(seqs.flatMap(seq => current.events.get(seq) ?? []))]
      if (seqs.some(seq => !current.events.has(seq))) throw new Error('Session title refers to unknown memory sources')
      await owner.registerDerived({ sessionId: String(session.id), messageId: `title:${session.id}:${seqs.join(',')}`, sourceIds })
    },
  }
}
