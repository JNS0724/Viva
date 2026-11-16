import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { nativeEventDigest } from './event-digest.ts'
import { inspectNativeOutputWindow, projectNativeOutput } from './project-native-outputs.ts'
import { publishNativeEventCopies, type NativeEventCopy, type NativeOutputTrace } from './publish-native-event-copies.ts'

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
        const event = window.ambiguous ? undefined : window.event
        if (!event || event.seq !== terminal.seq || (event.type === 'assistant/message' ? 'reply' : 'attempt') !== terminal.kind) {
          blocked.add(target.id)
          continue
        }
        const digest = nativeEventDigest(event)
        const previous = receipts.flatMap(receipt => receipt.replacements.flatMap(replacement =>
          replacement.attempt === target.id && replacement.seq === terminal.seq
          && replacement.before === terminal.digest && replacement.after === digest
            ? [{ replacement, needsRewrite: false, tracePublished: receipt.published }] : []))[0]
        if (previous) {
          occurrences.set(terminal.seq, previous)
        } else {
          const saved = { attempt: target.id, seq: terminal.seq, before: terminal.digest, after: digest }
          const verifiedCopy = digest !== terminal.digest ? journal.provenProjection(saved) : undefined
          if (verifiedCopy) {
            occurrences.set(terminal.seq, { replacement: verifiedCopy, needsRewrite: false, tracePublished: false })
          } else {
            const projection = digest === terminal.digest ? projectNativeOutput(event) : undefined
            if (!projection) { blocked.add(target.id); continue }
            const after = nativeEventDigest(projection)
            occurrences.set(terminal.seq, { replacement: { ...saved, after, trace: trace.key(event) }, needsRewrite: after !== digest, tracePublished: false })
          }
        }
        if (origin) verified.add(target.id)
      }
      if (occurrences.size) copies.set(sessionId, occurrences)
    })
  } finally { await mounted.dispose() }

  await publishNativeEventCopies({ root, storageRoot, operationId, journal, copies, isCold, trace,
    project: event => {
      const output = outputEvent(event)
      return output ? projectNativeOutput(output) : undefined
    },
  })
  journal.complete([...verified].filter(id => !blocked.has(id)))
}
