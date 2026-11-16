import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { nativeEventDigest } from './event-digest.ts'
import { addNativeCompactionCopies, asNativeCompactionCopy, projectNativeCompaction } from './project-native-compactions.ts'
import { nativeToolResultCopies, projectNativeToolResult } from './project-native-tools.ts'
import { planNativeEventCopy, publishNativeEventCopies, type NativeEventCopy, type NativeOutputTrace } from './publish-native-event-copies.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>
type Operation = ReturnType<Maintenance['toolResultOperations']>[number]

const toolResult = (event: SessionEvent | undefined) => event?.type === 'tool/result' ? event : undefined

/** A tool result can reach a native log without a later model request. */
export async function eraseNativeToolResults({ root, storageRoot, operation, isCold, trace }: {
  root: string, storageRoot: string, operation: Operation, isCold(): boolean, trace: NativeOutputTrace,
}) {
  const { operationId, journal } = operation
  const targets = operation.targets()
  if (!targets.length && !journal.pendingSessions().length) return
  const copies = new Map<SessionId, Map<number, NativeEventCopy>>()
  const verified = new Set<string>(), blocked = new Set<string>()
  const catalog = new Context(), mounted = await catalog.plugin(jsonl, { root })
  try {
    await visitNativeSessionCatalog(root, catalog.sessionPersistence, ({ sessionId, inheritedEventCount, events }) => {
      const occurrences = new Map<number, NativeEventCopy>()
      const receipts = journal.read(sessionId)
      for (const target of targets) {
        const origin = sessionId === target.session
        if (!origin && target.result.seq >= inheritedEventCount) continue
        const call = events[target.seq], result = toolResult(events[target.result.seq])
        const sameCall = call?.type === 'tool/call' && (nativeEventDigest(call) === target.digest
          || journal.provenTransition({ seq: target.seq, before: target.digest, after: nativeEventDigest(call) }))
        if (origin && sameCall && target.result.seq >= events.length) {
          // A child's flushed inherited result can precede the parent's write.
          const otherResult = events.some(event => event.type === 'tool/result' && event.surfaceOp === 'append'
            && event.data.turn === target.turn && event.data.step === target.step && event.data.message.toolCallId === target.callId)
          if (!otherResult) { verified.add(target.id); continue }
        }
        if (!sameCall || result?.surfaceOp !== 'append' || result.data.message.toolCallId !== target.callId
          || result.data.turn !== target.turn || result.data.step !== target.step
          || result.sourceEventSeqs?.length !== 1 || result.sourceEventSeqs[0] !== target.seq) {
          if (origin || sameCall) blocked.add(target.id)
          continue
        }
        const derived = nativeToolResultCopies(events, result)
        if (!derived) { blocked.add(target.id); continue }
        const matched = new Map<number, NativeEventCopy>()
        for (const event of derived.values()) {
          const copy = planNativeEventCopy({ event, attempt: target.id, receipts, journal,
            expected: event === result ? target.result.digest : undefined, project: () => projectNativeToolResult(event), shared: true })
          if (copy) matched.set(event.seq, copy)
        }
        if (matched.size !== derived.size) { blocked.add(target.id); continue }
        for (const [seq, copy] of matched) {
          if (occurrences.has(seq)) throw new Error('Native tool results have competing read identities')
          occurrences.set(seq, copy)
        }
        if (origin) verified.add(target.id)
      }
      addNativeCompactionCopies(events, occurrences, operationId, journal, receipts)
      if (occurrences.size) copies.set(sessionId, occurrences)
    })
  } finally { await mounted.dispose() }
  await publishNativeEventCopies({ root, storageRoot, operationId, journal, copies, isCold, trace,
    project: event => {
      if (event.type === 'tool/result') return projectNativeToolResult(event)
      const compaction = asNativeCompactionCopy(event)
      return compaction ? projectNativeCompaction(compaction) : undefined
    },
  })
  journal.complete([...verified].filter(id => !blocked.has(id)))
}
