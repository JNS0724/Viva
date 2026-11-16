import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PluginMemoryOwner, SourceReceipt, DerivedSource } from './owner-port.ts'
import type { MemoryContextRecoveryOwner, MemoryContextRecoveryTicket } from '../../../src/memory/contracts/context-recovery.ts'
import { memoryMessageText, memoryOriginalContentDigest, memoryRecoveryCandidates, memoryRecoveryMessageHash, memorySessionSurfaceHash, planMemoryContextRecovery } from './context-recovery.ts'
import type { MemoryDeliveryProof } from './delivery-provenance.ts'

import { assertMemorySourceSupported } from './source.ts'

const senderOf = (message: UserMessage): string | undefined => {
  if (!['agent-message', 'subagent-settled'].includes(message.source.kind)) return undefined
  if (!('senderSessionId' in message.source) || typeof message.source.senderSessionId !== 'string' || !message.source.senderSessionId) throw new Error('Derived message sender is unavailable')
  return message.source.senderSessionId
}
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
type Replay = {
  session: Session, cursor: number, turn: number, step: number, sources: Set<string>, assistant: string[],
  events: Map<number, readonly string[]>, messages: Map<string, string>, queue: Promise<void>,
  generation: number,
  failed: boolean,
}

/** Derived host input can query memory, while never becoming new evidence or daily-note input. */
export function retrievalQuestion(receipts: readonly SourceReceipt[]) {
  return receipts.filter(receipt => !receipt.controlReceipt)
    .map(receipt => receipt.retrievalQuery ?? (!receipt.handledIntent ? receipt.text : '')).filter(Boolean).join('\n').slice(0, 20_000)
}

/** DSH's feed announces in-memory commits; flush is the explicit durability boundary. */
export function createSessionIngestion(owner: Pick<PluginMemoryOwner, 'initializeSession' | 'receiveSource' | 'completeTurn' | 'registerDerived' | 'noteInheritedNativeCut'> & Partial<MemoryContextRecoveryOwner> & { dispatch: Pick<PluginMemoryOwner['dispatch'], 'snapshot'> }, flush: (session: Session) => Promise<unknown>,
  deliveryProof?: (session: Session, message: UserMessage) => Promise<MemoryDeliveryProof | undefined>) {
  const states = new Map<string, Replay>()
  function state(session: Session) {
    let current = states.get(session.id)
    if (!current || current.session !== session) {
      current = { session, cursor: 0, turn: 0, step: 0, sources: new Set(), assistant: [], events: new Map(), messages: new Map(), queue: Promise.resolve(), generation: owner.contextGeneration?.(String(session.id)) ?? 0, failed: false }
      states.set(session.id, current)
    }
    return current
  }
  async function original(session: Session, current: Replay, message: UserMessage, options: { at: number, turn: number, step: number, admitted: boolean, live?: boolean, eventSeq?: number, inherited?: boolean, contextGeneration?: number }) {
    assertMemorySourceSupported(message.source.kind)
    if (message.source.kind !== 'user') {
      const senderSessionId = senderOf(message)
      if (senderSessionId) {
        const proof = await deliveryProof?.(session, message)
        const contentDigest = memoryOriginalContentDigest(message)
        if (proof && proof.contentDigest !== contentDigest) throw new Error('Derived delivery content differs from its causal receipt')
        await owner.registerDerived({ sessionId: String(session.id), messageId: message.id, nativeUserSource: message.source.kind, nativeMessageDigest: memoryRecoveryMessageHash(message), sourceIds: [], senderSessionId, inherited: options.inherited,
          contextGeneration: options.contextGeneration ?? current.generation, senderContextGeneration: 0, ...proof, contentDigest,
          ...(proof ? { verifiedDelivery: true as const } : {}) })
      }
      return undefined
    }
    const text = memoryMessageText(message)
    const contentDigest = memoryOriginalContentDigest(message)
    const identity = { sessionId: String(session.id), messageId: message.id, text, contentDigest, nativeMessageDigest: memoryRecoveryMessageHash(message), inherited: options.inherited ?? false }
    if (!text.trim() && !message.content.some(part => part.type === 'image' || part.type === 'file')) {
      owner.noteInheritedNativeCut?.(identity)
      return undefined
    }
    const receipt = await owner.receiveSource({ ...identity,
      contextGeneration: current.generation, ...options, timezone: timezone(), inherited: identity.inherited,
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
    return { events, persisted, generation: owner.contextGeneration?.(String(session.id)) ?? 0 }
  }
  function recoveryEvent(events: readonly SessionEvent[], ticket: MemoryContextRecoveryTicket) {
    const event = events.find(item => item.type === 'user/message' && item.data.id === ticket.replacementMessageId)
    if (!event) return undefined
    if (event.type !== 'user/message' || event.data.source.kind !== 'viva-memory-recovery'
      || event.data.source.ticketId !== ticket.ticketId || memoryRecoveryMessageHash(event.data) !== ticket.replacementHash
      || JSON.stringify(event.data.source.originalMessageIds) !== JSON.stringify(ticket.retainedMessageIds)) {
      throw new Error('Context recovery checkpoint does not match its trusted receipt')
    }
    // The native session has already validated each operation. Reconstruct only its positional
    // membership here; message projection plugins cannot change these nodes. A matching message
    // hash alone is insufficient if a restored log appended it without replacing the old history.
    const nodes: number[] = []
    for (const previous of events) {
      if (previous.seq >= event.seq) break
      if (!('surfaceOp' in previous) || !previous.surfaceOp) continue
      if (previous.surfaceOp === 'append') nodes.push(previous.seq)
      else {
        const start = nodes.indexOf(previous.surfaceOp.startSeq), end = nodes.indexOf(previous.surfaceOp.endSeq)
        if (start < 0 || end < start) throw new Error('Invalid context recovery surface history')
        nodes.splice(start, end - start + 1, previous.seq)
      }
    }
    if (nodes.length && events[nodes[0]!]!.type === 'system/message') nodes.shift()
    if (nodes.length ? event.surfaceOp === 'append' || event.surfaceOp.startSeq !== nodes[0] || event.surfaceOp.endSeq !== nodes.at(-1)
      : event.surfaceOp !== 'append') throw new Error('Context recovery checkpoint did not replace the complete model history')
    return event
  }
  async function restoreCheckpoint(session: Session, current: Replay, events: readonly SessionEvent[]) {
    const ticket = owner.contextRecovery?.(String(session.id))
    if (!ticket) return
    if (ticket.state !== 'committed') throw new Error('Session context recovery requires a persisted replacement')
    const marker = recoveryEvent(events, ticket)
    if (!marker) throw new Error('Committed context recovery checkpoint is missing from the durable session')
    if (current.cursor > marker.seq) return
    const retained = new Set(ticket.retainedMessageIds)
    current.events.clear(); current.messages.clear(); current.sources.clear(); current.assistant = []
    // Old generated events remain audit history. Only separately authenticated human originals
    // rebuild source chronology; neither prior assistant text nor old turn completions are replayed.
    for (const event of events) {
      if (event.seq >= marker.seq) break
      if (event.type === 'turn/start') { current.turn = event.data.turn; current.step = 0; current.sources.clear() }
      if (event.type === 'step/start') { current.turn = event.data.turn; current.step = event.data.step }
      if (event.type !== 'user/message' || event.surfaceOp !== 'append' || !retained.has(event.data.id)) continue
      const receipt = await original(session, current, event.data, { at: event.time, turn: current.turn, step: current.step,
        admitted: true, live: false, eventSeq: event.seq, inherited: event.seq < session.inheritedEventCount })
      if (receipt) current.events.set(event.seq, [receipt.sourceId])
    }
    current.events.set(marker.seq, ticket.retainedMessageIds.flatMap(id => current.messages.get(id) ?? []))
    current.cursor = marker.seq + 1
  }
  async function replay(session: Session, current: Replay, saved: { events: readonly SessionEvent[], persisted: Promise<unknown>, generation: number }) {
    if (await saved.persisted !== true) throw new Error('Session has no durable persistence acknowledgment')
    if (saved.generation !== (owner.contextGeneration?.(String(session.id)) ?? 0)) {
      if (saved.events.length <= current.cursor) return
      throw new Error('Queued session intake belongs to a retired context generation')
    }
    current.generation = saved.generation
    if (session.header.origin === 'subagent' && !session.header.parentSession) throw new Error('Subagent parent is unavailable')
    owner.initializeSession({ sessionId: String(session.id), cwd: session.header.cwd,
      ...(session.header.origin === 'subagent' ? { parentSessionId: session.header.parentSession } : {}) })
    const events = saved.events
    await restoreCheckpoint(session, current, events)
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
        if (event.data.source.kind === 'viva-memory-recovery') throw new Error('Unverified context recovery message')
        const receipt = await original(session, current, event.data, { at: event.time, turn: current.turn, step: current.step,
          admitted: true, live: false, eventSeq: event.seq, inherited })
        if (receipt) current.events.set(event.seq, [receipt.sourceId])
        else {
          const dependencies = [...new Set([...(event.sourceEventSeqs ?? []).flatMap(seq => current.events.get(seq) ?? []), ...owner.dispatch.snapshot(String(session.id)).sources])]
          await owner.registerDerived({ sessionId: String(session.id), messageId: event.data.id, nativeUserSource: event.data.source.kind, nativeMessageDigest: memoryRecoveryMessageHash(event.data),
            sourceIds: dependencies, eventSeq: event.seq, inherited, contextGeneration: current.generation, contentDigest: memoryOriginalContentDigest(event.data) })
          current.events.set(event.seq, dependencies)
        }
      }
      if (event.type === 'assistant/message') {
        const dependencies = owner.dispatch.snapshot(String(session.id)).sources
        await owner.registerDerived({ sessionId: String(session.id), messageId: event.data.message.id,
          sourceIds: dependencies, eventSeq: event.seq, inherited, contextGeneration: current.generation, contentDigest: memoryOriginalContentDigest(event.data.message) })
        current.events.set(event.seq, dependencies)
        if (!event.data.interrupted) current.assistant.push(memoryMessageText(event.data.message))
      }
      if (event.type === 'turn/end' && !inherited) {
        await owner.completeTurn({ sessionId: String(session.id), turn: event.data.turn, eventSeq: event.seq,
          sourceIds: [...current.sources], assistant: current.assistant.join('\n'), completed: event.data.reason.kind === 'completed',
          at: event.time, timezone: timezone(), contextGeneration: current.generation })
      }
      current.cursor = index + 1
    }
  }
  function serialize(session: Session, action: (current: Replay) => Promise<void>) {
    const current = state(session)
    // A failed durable registration blocks this session until the owner is recovered/restarted.
    // Advancing past it would let model/tool execution bypass an unregistered original.
    current.queue = current.queue.then(() => action(current)).catch(error => { current.failed = true; throw error })
    return current.queue
  }
  return {
    /** Run only before request construction, never inside a retry or an already-built LLM call. */
    recoverContext(session: Session, stillSafe: () => boolean = () => true) {
      const current = state(session)
      const run = async () => {
        if (!current.failed && !owner.needsContextRecovery?.(String(session.id))) return
        if (!stillSafe()) throw new Error('Session is not at a safe context recovery boundary')
        if (!owner.prepareContextRecovery || !owner.bindContextRecovery || !owner.commitContextRecovery || !owner.contextRecovery) {
          throw new Error('Session context recovery is unavailable')
        }
        if (await flush(session) !== true) throw new Error('Session has no durable persistence acknowledgment')
        // Reauthorize on every attempt. A replacement already landed before a failed owner CAS
        // can safely become the base of a new ticket; it must never authorize old source versions.
        owner.initializeSession({ sessionId: String(session.id), cwd: session.header.cwd,
          ...(session.header.origin === 'subagent' ? { parentSessionId: session.header.parentSession } : {}) })
        let ticket = await owner.prepareContextRecovery({ sessionId: String(session.id), baseSurfaceHash: memorySessionSurfaceHash(session),
          ...(session.header.parentSession ? { nativeParentSessionId: String(session.header.parentSession) } : {}),
          candidates: memoryRecoveryCandidates(session).map(({ text, ...item }) => ({ ...item, content: text })) })
        let marker = recoveryEvent(session.snapshotEvents(), ticket)
        if (!marker) {
          if (memorySessionSurfaceHash(session) !== ticket.baseSurfaceHash) throw new Error('Session surface changed during context recovery')
          const plan = planMemoryContextRecovery(session, ticket.ticketId, ticket.retainedMessageIds, ticket.replacementMessageId)
          ticket = owner.bindContextRecovery({ ticketId: ticket.ticketId, replacementMessageId: String(plan.message.id), replacementHash: plan.replacementHash })
          if (!stillSafe() || memorySessionSurfaceHash(session) !== ticket.baseSurfaceHash) throw new Error('Session surface changed before context replacement')
          session.append([plan.input])
          marker = recoveryEvent(session.snapshotEvents(), ticket)
        }
        if (!marker || !ticket.replacementMessageId || !ticket.replacementHash) throw new Error('Context replacement was not committed')
        const replaced = memorySessionSurfaceHash(session)
        const persistedEvents = session.snapshotEvents()
        if (await flush(session) !== true) throw new Error('Session has no durable persistence acknowledgment')
        if (memorySessionSurfaceHash(session) !== replaced) throw new Error('Session surface changed before durable recovery acknowledgment')
        await owner.commitContextRecovery({ ticketId: ticket.ticketId, baseSurfaceHash: ticket.baseSurfaceHash,
          replacementMessageId: ticket.replacementMessageId, replacementHash: ticket.replacementHash, persisted: true },
        () => stillSafe() && memorySessionSurfaceHash(session) === replaced)
        current.cursor = 0
        await replay(session, current, { events: persistedEvents, persisted: Promise.resolve(true), generation: ticket.generation })
        current.failed = false
      }
      // Recovery independently reauthenticates the durable surface and every retained source. It is
      // the only path allowed to replace a failed replay queue; ordinary intake never skips failures.
      current.queue = current.queue.catch(() => { current.failed = true }).then(run).catch(error => { current.failed = true; throw error })
      return current.queue
    },
    derived(session: Session, input: Omit<DerivedSource, 'sessionId'>) {
      const saved = checkpoint(session)
      return serialize(session, async current => {
        await replay(session, current, saved)
        await owner.registerDerived({ contextGeneration: saved.generation, ...input, sessionId: String(session.id) })
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
          const receipt = await original(session, current, message, { at: Date.now(), turn, step, admitted, live: true, contextGeneration: saved.generation })
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
      await owner.registerDerived({ sessionId: String(session.id), messageId: `title:${session.id}:${seqs.join(',')}`, sourceIds, contextGeneration: current.generation })
    },
  }
}
