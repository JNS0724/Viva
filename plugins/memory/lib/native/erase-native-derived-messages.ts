import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import { memoryOriginalContentDigest, memoryRecoveryMessageHash } from '../context-recovery.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { nativeEventDigest } from './event-digest.ts'
import { addNativeCompactionCopies, asNativeCompactionCopy, projectNativeCompaction } from './project-native-compactions.ts'
import { publishNativeEventCopies, type NativeEventCopy, type NativeOutputTrace } from './publish-native-event-copies.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>
type Operation = ReturnType<Maintenance['derivedMessageOperations']>[number]

function messagesIn(event: SessionEvent): readonly UserMessage[] {
  if (event.type === 'user/message') return [event.data]
  return event.type === 'agent/inbox/spliced' ? event.data.inserted : []
}

function redact(event: SessionEvent, selected: ReadonlySet<string>): SessionEvent | undefined {
  const empty = (message: UserMessage): UserMessage => selected.has(message.id)
    ? { ...message, content: [], source: 'summary' in message.source ? { ...message.source, summary: '' } : message.source } : message
  if (event.type === 'user/message') return { ...event, data: empty(event.data) }
  if (event.type === 'agent/inbox/spliced') return { ...event, data: { ...event.data, inserted: event.data.inserted.map(empty) } }
}

export async function eraseNativeDerivedMessages({ root, storageRoot, operation, isCold, trace }: {
  root: string, storageRoot: string, operation: Operation, isCold(): boolean, trace: NativeOutputTrace,
}) {
  const { operationId, journal, verify } = operation
  const targets = new Map(operation.targets().map(target => [target.message, target]))
  if (!targets.size && !journal.pendingSessions().length) return
  const copies = new Map<SessionId, Map<number, NativeEventCopy>>()
  const blocked = new Set<string>()
  // Each event is published as a unit because a single inbox event can carry
  // several derived messages as well as independently retained ones.
  const selections = new Map<string, Set<string>>()
  const catalog = new Context(), mounted = await catalog.plugin(jsonl, { root })
  try {
    await visitNativeSessionCatalog(root, catalog.sessionPersistence, ({ sessionId, events }) => {
      const replacements = new Map<number, NativeEventCopy>()
      const receipts = journal.read(sessionId)
      for (const event of events) {
        const candidates = messagesIn(event).flatMap(message => {
          const target = targets.get(message.id)
          return target ? [{ message, target }] : []
        })
        if (!candidates.length) continue
        const digest = nativeEventDigest(event)
        const previous = receipts.flatMap(receipt => receipt.replacements.flatMap(replacement =>
          replacement.attempt === operationId && replacement.seq === event.seq && replacement.after === digest
            ? [{ replacement, needsRewrite: false, tracePublished: receipt.published }] : []))[0]
        if (previous) replacements.set(event.seq, previous)
        const selected = new Set<string>()
        for (const { message, target } of candidates) {
          if (message.source.kind !== target.source) { blocked.add(message.id); continue }
          if (previous && !message.content.length) continue
          if (message.content.some(block => block.type !== 'text')
            || 'summary' in message.source && !target.envelope
            || !verify(target, memoryOriginalContentDigest(message), memoryRecoveryMessageHash(message))) {
            blocked.add(message.id)
            continue
          }
          if (message.content.length || 'summary' in message.source && message.source.summary) selected.add(message.id)
        }
        if (!selected.size) continue
        const projected = redact(event, selected)!
        const after = nativeEventDigest(projected)
        replacements.set(event.seq, { replacement: { attempt: operationId, seq: event.seq, before: digest, after },
          needsRewrite: true, tracePublished: false })
        selections.set(digest, selected)
      }
      addNativeCompactionCopies(events, replacements, operationId, journal, receipts)
      if (replacements.size) copies.set(sessionId, replacements)
    })
  } finally { await mounted.dispose() }
  await publishNativeEventCopies({ root, storageRoot, operationId, journal, copies, isCold, trace,
    project(event) {
      const compaction = asNativeCompactionCopy(event)
      if (compaction) return projectNativeCompaction(compaction)
      const selected = selections.get(nativeEventDigest(event))
      return selected ? redact(event, selected) : undefined
    },
  })
  journal.complete([])
  operation.complete([...targets.keys()].filter(message => !blocked.has(message)))
}
