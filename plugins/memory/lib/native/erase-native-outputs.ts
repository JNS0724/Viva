import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import type { NativeOutputPublication, NativeOutputReplacement } from '../../../../src/memory/node/native-output-journal.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { rewriteColdNativeSession } from './native-cold-rewrite.ts'
import { nativeOutputDigest } from './output-attempts.ts'
import { clearNativeProjections } from './projection-cache.ts'
import { inspectNativeOutputWindow, projectNativeOutput } from './project-native-outputs.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>
type Operation = ReturnType<Maintenance['outputOperations']>[number]
type Copy = { replacement: NativeOutputReplacement, needsRewrite: boolean, tracePublished: boolean }
export type NativeOutputTrace = {
  key(event: SessionEvent): string | undefined
  erase(sessionId: string, positions: readonly { seq: number, digest: string }[]): void
}

const outputEvent = (event: SessionEvent | undefined) => event?.type === 'assistant/message' || event?.type === 'assistant/attempt' ? event : undefined

/** Erase only settled outputs whose native event and attempt marker are verifiable. */
export async function eraseNativeOutputs({ root, storageRoot, operation, isCold, trace }: {
  root: string, storageRoot: string, operation: Operation, isCold(): boolean, trace: NativeOutputTrace,
}) {
  const { operationId, journal } = operation
  const targets = operation.targets()
  if (!targets.length && !journal.pendingSessions().length) return
  const copies = new Map<SessionId, Map<number, Copy>>()
  const verified = new Set<string>(), blocked = new Set<string>()
  const catalog = new Context(), mounted = await catalog.plugin(jsonl, { root })
  try {
    await visitNativeSessionCatalog(root, catalog.sessionPersistence, ({ sessionId, inheritedEventCount, events }) => {
      const occurrences = new Map<number, Copy>()
      const receipts = journal.read(sessionId)
      for (const target of targets) {
        const origin = sessionId === target.session
        const { terminal } = target.result
        if (!origin && terminal.seq >= inheritedEventCount) continue
        const stored = outputEvent(events[terminal.seq])
        const window = inspectNativeOutputWindow(events, sessionId, inheritedEventCount, target)
        if (!window.marker) {
          if (origin || stored && nativeOutputDigest(stored) === terminal.digest) blocked.add(target.id)
          continue
        }
        const event = window.ambiguous ? undefined : window.event
        if (!event || event.seq !== terminal.seq || (event.type === 'assistant/message' ? 'reply' : 'attempt') !== terminal.kind) {
          blocked.add(target.id)
          continue
        }
        const digest = nativeOutputDigest(event)
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
            const after = nativeOutputDigest(projection)
            occurrences.set(terminal.seq, { replacement: { ...saved, after, trace: trace.key(event) }, needsRewrite: after !== digest, tracePublished: false })
          }
        }
        if (origin) verified.add(target.id)
      }
      if (occurrences.size) copies.set(sessionId, occurrences)
    })
  } finally { await mounted.dispose() }

  for (const session of journal.pendingSessions()) {
    const found = [...copies.keys()].find(key => key === session)
    const expected = journal.read(session).find(batch => !batch.published)?.replacements ?? []
    if (!found || expected.some(copy => copies.get(found)?.get(copy.seq)?.replacement.attempt !== copy.attempt)) {
      throw new Error('Native output publication is missing its verified artifact')
    }
  }
  await clearNativeProjections(storageRoot, [...copies].flatMap(([session, events]) =>
    [...events.values()].some(copy => !copy.tracePublished) ? [session] : []))
  for (const [session, copiesAtSeq] of copies) {
    const pending = journal.read(session).find(batch => !batch.published)
    if (pending) await publish(session, pending.replacements, pending.intent)
    const alreadyPublished = new Set(pending?.replacements.map(copy => copy.seq))
    const remaining = [...copiesAtSeq.values()].filter(copy => !alreadyPublished.has(copy.replacement.seq) && !copy.tracePublished)
    const rewrite = remaining.filter(copy => copy.needsRewrite).map(copy => copy.replacement)
    const existing = remaining.filter(copy => !copy.needsRewrite).map(copy => copy.replacement)
    if (rewrite.length) await publish(session, rewrite)
    if (existing.length) {
      journal.markCopied(session)
      clearTrace(session, existing)
    }
  }
  function clearTrace(session: SessionId, replacements: readonly NativeOutputReplacement[]) {
    const positions = replacements.flatMap(copy => copy.trace ? [{ seq: copy.seq, digest: copy.trace }] : [])
    if (positions.length) trace.erase(session, positions)
  }
  async function publish(session: SessionId, replacements: readonly NativeOutputReplacement[], saved?: NativeOutputPublication['intent']) {
    const bySeq = new Map(replacements.map(copy => [copy.seq, copy]))
    await rewriteColdNativeSession({ root, sessionId: session, operationId, compression: 'zstd',
      retired: isCold,
      journal: {
        pending: () => saved,
        prepare: intent => journal.prepare(session, { intent, replacements: [...replacements] }),
        finish: intent => {
          clearTrace(session, replacements)
          journal.finish(session, intent)
        },
      },
      transform(events) {
        return events.map(event => {
          const copy = bySeq.get(event.seq)
          if (!copy) return event
          const output = outputEvent(event)
          if (!output || nativeOutputDigest(output) !== copy.before) throw new Error('Native output changed before publication')
          const projection = projectNativeOutput(output)
          if (!projection || nativeOutputDigest(projection) !== copy.after) throw new Error('Native output projection differed from its plan')
          return projection
        })
      },
    })
  }
  journal.complete([...verified].filter(id => !blocked.has(id)))
}
