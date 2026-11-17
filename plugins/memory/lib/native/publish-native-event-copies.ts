import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { createNativeOutputJournal, NativeOutputPublication, NativeOutputReplacement } from '../../../../src/memory/node/native-output-journal.ts'
import { nativeEventDigest } from './event-digest.ts'
import { rewriteColdNativeSession } from './native-cold-rewrite.ts'
import { clearNativeProjections } from './projection-cache.ts'

export type NativeEventJournal = ReturnType<ReturnType<typeof createNativeOutputJournal>['forOperation']>
export type NativeEventCopy = { replacement: NativeOutputReplacement, needsRewrite: boolean, tracePublished: boolean }
export type NativeOutputTrace = {
  key(event: SessionEvent): string | undefined
  erase(sessionId: string, positions: readonly { seq: number, digest: string }[]): void
}

export function planNativeEventCopy({ event, attempt, receipts, journal, expected, project, trace, shared }: {
  event: SessionEvent, attempt: string, receipts: ReturnType<NativeEventJournal['read']>, journal: NativeEventJournal,
  expected?: string, project(): SessionEvent | undefined, trace?(): string | undefined,
  shared?: boolean,
}): NativeEventCopy | undefined {
  const digest = nativeEventDigest(event)
  for (const receipt of receipts) {
    const replacement = receipt.replacements.find(copy => copy.attempt === attempt && copy.seq === event.seq
      && (!expected || copy.before === expected) && copy.after === digest)
    if (replacement) return { replacement, needsRewrite: false, tracePublished: receipt.published }
  }
  const saved = { attempt, seq: event.seq, before: expected ?? digest, after: digest }
  const proof = journal.provenProjection({ ...saved, before: expected })
  if (proof) return { replacement: proof, needsRewrite: false, tracePublished: false }
  if (expected && digest !== expected) {
    if (shared && journal.provenTransition(saved)) return { replacement: saved, needsRewrite: false, tracePublished: false }
    return
  }
  const projection = project()
  if (!projection) return
  const after = nativeEventDigest(projection)
  return { replacement: { ...saved, after, trace: trace?.() }, needsRewrite: after !== digest, tracePublished: false }
}

export async function publishNativeEventCopies({ root, storageRoot, operationId, journal, copies, isCold, trace, project }: {
  root: string, storageRoot: string, operationId: string, journal: NativeEventJournal,
  copies: ReadonlyMap<SessionId, ReadonlyMap<number, NativeEventCopy>>, isCold(): boolean, trace: NativeOutputTrace,
  project(event: SessionEvent): SessionEvent | undefined,
}) {
  for (const session of journal.pendingSessions()) {
    const found = [...copies.keys()].find(key => key === session)
    const expected = journal.read(session).find(batch => !batch.published)?.replacements ?? []
    if (!found || expected.some(copy => {
      const actual = copies.get(found)?.get(copy.seq)?.replacement
      return !actual || actual.attempt !== copy.attempt || actual.before !== copy.before || actual.after !== copy.after
    })) {
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
          if (nativeEventDigest(event) !== copy.before) throw new Error('Native event changed before publication')
          const projection = project(event)
          if (!projection || nativeEventDigest(projection) !== copy.after) throw new Error('Native event projection differed from its plan')
          return projection
        })
      },
    })
  }
}
