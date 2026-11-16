import { isDeepStrictEqual } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance, NativeOriginalCandidate } from '../../../../src/memory/node/native-original-maintenance.ts'
import { memoryMessageText, memoryOriginalContentDigest, memoryRecoveryContent, memoryRecoveryMessageHash } from '../context-recovery.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { nativeEventDigest } from './event-digest.ts'
import { projectNativeOriginals } from './project-native-originals.ts'
import { publishNativeEventCopies, type NativeEventCopy, type NativeOutputTrace } from './publish-native-event-copies.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>
type Operation = ReturnType<Maintenance['recoveryMessageOperations']>[number]
type Marker = SessionEvent<'user/message'>
type Ticket = ReturnType<Operation['targets']>[number]

function projectMarker(event: Marker, events: readonly SessionEvent[], target: Ticket, session: string, operation: Operation): Marker | undefined {
  const message = event.data
  if (message.source.kind !== 'viva-memory-recovery' || message.source.ticketId !== target.ticket
    || !isDeepStrictEqual(message.source.originalMessageIds, target.originals)) return
  const selected: UserMessage[] = []
  let offset = 1
  for (const id of target.originals) {
    const original = events.find(candidate => candidate.seq < event.seq && candidate.type === 'user/message'
      && candidate.surfaceOp === 'append' && candidate.data.id === id && candidate.data.source.kind === 'user')
    if (original?.type !== 'user/message') return
    const content = message.content.slice(offset + 1, offset + 1 + original.data.content.length)
    if (content.length !== original.data.content.length) return
    selected.push({ ...original.data, content })
    offset += content.length + 1
  }
  if (!isDeepStrictEqual(message.content, memoryRecoveryContent(selected))) return
  const projected = selected.map(original => {
    if (!operation.contains(String(original.id))) return original
    const candidate: NativeOriginalCandidate = { sessionId: session, messageId: String(original.id),
      wireText: memoryMessageText(original), contentDigest: memoryOriginalContentDigest(original) }
    if (operation.satisfies(candidate)) return original
    const proof = operation.authorize(candidate)
    if (!proof) throw new Error('Recovery message has no authenticated original range')
    if (proof.kind === 'applied') return original
    const input = { ...event, data: original }
    return projectNativeOriginals([input], () => proof.wireCuts).events[0]!.data as UserMessage
  })
  return { ...event, data: { ...message, content: memoryRecoveryContent(projected) } }
}

/** A recovery checkpoint is a proved copy of particular original messages. */
export async function eraseNativeRecoveryMessages({ root, storageRoot, operation, isCold, trace }: {
  root: string, storageRoot: string, operation: Operation, isCold(): boolean, trace: NativeOutputTrace,
}) {
  const { operationId, journal } = operation
  const targets = new Map(operation.targets().map(target => [target.message, target]))
  if (!targets.size && !journal.pendingSessions().length) return
  const blocked = new Set<string>()
  const copies = new Map<SessionId, Map<number, NativeEventCopy>>()
  const projections = new Map<string, Marker>()
  const catalog = new Context(), mounted = await catalog.plugin(jsonl, { root })
  try {
    await visitNativeSessionCatalog(root, catalog.sessionPersistence, ({ sessionId, events }) => {
      const replacements = new Map<number, NativeEventCopy>(), receipts = journal.read(sessionId)
      for (const event of events) {
        if (event.type !== 'user/message') continue
        const target = targets.get(String(event.data.id))
        if (!target) continue
        const digest = nativeEventDigest(event)
        const previous = receipts.flatMap(receipt => receipt.replacements.flatMap(replacement =>
          replacement.attempt === target.ticket && replacement.seq === event.seq && replacement.after === digest
            ? [{ replacement, needsRewrite: false, tracePublished: receipt.published }] : []))[0]
        if (previous) { replacements.set(event.seq, previous); continue }
        if (memoryRecoveryMessageHash(event.data) !== target.hash
          && !journal.provenProjection({ attempt: target.ticket, seq: event.seq, after: digest })) {
          blocked.add(target.ticket)
          continue
        }
        const projected = projectMarker(event, events, target, sessionId, operation)
        if (!projected) { blocked.add(target.ticket); continue }
        const after = nativeEventDigest(projected)
        replacements.set(event.seq, { replacement: { attempt: target.ticket, seq: event.seq, before: digest, after },
          needsRewrite: after !== digest, tracePublished: false })
        projections.set(digest, projected)
      }
      if (replacements.size) copies.set(sessionId, replacements)
    })
  } finally { await mounted.dispose() }
  await publishNativeEventCopies({ root, storageRoot, operationId, journal, copies, isCold, trace,
    project: event => projections.get(nativeEventDigest(event)),
  })
  journal.complete([])
  operation.complete([...targets.values()].filter(target => !blocked.has(target.ticket)).map(target => target.ticket))
}
