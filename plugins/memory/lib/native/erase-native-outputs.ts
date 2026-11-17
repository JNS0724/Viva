import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { nativeEventDigest } from './event-digest.ts'
import { addNativeCompactionCopies, asNativeCompactionCopy, projectNativeCompaction } from './project-native-compactions.ts'
import { inspectNativeOutputWindow, projectNativeOutput, projectNativeRetry } from './project-native-outputs.ts'
import { inspectNativeToolCompanions, projectToolCompanion } from './native-output-tool-group.ts'
import { planNativeEventCopy, publishNativeEventCopies, type NativeEventCopy, type NativeOutputTrace } from './publish-native-event-copies.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>
type Operation = ReturnType<Maintenance['outputOperations']>[number]
const outputEvent = (event: SessionEvent | undefined) => event?.type === 'assistant/message' || event?.type === 'assistant/attempt' ? event : undefined

/** Erase only settled outputs whose native event and attempt marker are verifiable. */
export async function eraseNativeOutputs({ root, storageRoot, operation, isCold, trace }: {
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
        const { terminal } = target.result
        if (!origin && terminal.seq >= inheritedEventCount) continue
        const stored = outputEvent(events[terminal.seq])
        const window = inspectNativeOutputWindow(events, sessionId, inheritedEventCount, target)
        if (!window.marker) {
          if (origin || stored && nativeEventDigest(stored) === terminal.digest) blocked.add(target.id)
          continue
        }
        if (!window.ambiguous && !window.event) {
          // A fork can persist an inherited endpoint before its parent flushes it.
          if (origin) verified.add(target.id)
          continue
        }
        const event = window.ambiguous ? undefined : window.event
        if (!event || event.seq !== terminal.seq || (event.type === 'assistant/message' ? 'reply' : 'attempt') !== terminal.kind) {
          blocked.add(target.id)
          continue
        }
        const primary = planNativeEventCopy({ event, attempt: target.id, receipts, journal,
          expected: terminal.digest, project: () => projectNativeOutput(event), trace: () => trace.key(event) })
        if (!primary) { blocked.add(target.id); continue }
        const matched = new Map<number, NativeEventCopy>([[terminal.seq, primary]])
        for (const retry of window.retries ?? []) {
          const copy = planNativeEventCopy({ event: retry, attempt: target.id, receipts, journal,
            project: () => projectNativeRetry(retry), trace: () => trace.key(retry) })
          if (copy) matched.set(retry.seq, copy)
        }
        if (matched.size !== 1 + (window.retries?.length ?? 0)) { blocked.add(target.id); continue }
        if (event.type === 'assistant/message') {
          const group = inspectNativeToolCompanions(events, event)
          if (!group) { blocked.add(target.id); continue }
          for (const companion of group.values()) {
            const copy = planNativeEventCopy({ event: companion, attempt: target.id, receipts, journal,
              project: () => projectToolCompanion(companion), trace: () => trace.key(companion),
            })
            if (copy) matched.set(companion.seq, copy)
          }
          if (matched.size !== 1 + (window.retries?.length ?? 0) + group.size) { blocked.add(target.id); continue }
        }
        for (const [seq, copy] of matched) {
          if (occurrences.has(seq)) throw new Error('Native outputs have competing event identities')
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
      const output = outputEvent(event)
      if (output) return projectNativeOutput(output)
      if (event.type === 'llm/retry') return projectNativeRetry(event)
      if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'tool/ptc-dispatch-start'
        || event.type === 'tool/ptc-dispatch') return projectToolCompanion(event)
      const compaction = asNativeCompactionCopy(event)
      return compaction ? projectNativeCompaction(compaction) : undefined
    },
  })
  journal.complete([...verified].filter(id => !blocked.has(id)))
}
