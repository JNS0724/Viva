import type {} from '@deepseek-ai/dsh-compaction'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { compactionInputs } from './compaction-inputs.ts'
import { planNativeEventCopy, type NativeEventCopy, type NativeEventJournal } from './publish-native-event-copies.ts'

type Summary = SessionEvent<'compaction/summary'>
type Checkpoint = SessionEvent<'user/message'>
type Done = SessionEvent<'compaction/end'>
export type NativeCompactionCopy = Summary | Checkpoint | Done

export function projectNativeCompaction(event: NativeCompactionCopy): NativeCompactionCopy {
  if (event.type === 'user/message') return { ...event, data: { ...event.data, content: [] } }
  if (event.type === 'compaction/end') return { ...event, data: { ...event.data, error: 'Compaction output was withdrawn.' } }
  return { ...event, data: { ...event.data, summary: [], ...(event.data.rawOutput === undefined ? {} : { rawOutput: [] }) } }
}

/** Stock compaction cites every selected non-system input. Its checkpoint can
 * become a later summary's input, so follow the original positions in order. */
export function nativeCompactionCopies(events: readonly SessionEvent[], seeds: ReadonlySet<number>) {
  const copies = new Map<number, NativeCompactionCopy>()
  if (!seeds.size) return copies
  const affected = new Set(seeds)
  const summaries = new Map<string, Summary>()
  const failed = new Set<string>()
  for (const event of events) {
    if (event.type === 'compaction/summary' && event.data.shadowedSeqs.some(seq => affected.has(seq))) {
      copies.set(event.seq, event)
      summaries.set(event.data.compactionId, event)
      continue
    }
    if (event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint') {
      const summary = summaries.get(event.data.source.compactionId)
      if (!summary) continue
      const replacement = event.surfaceOp
      const { start, end } = summary.data.shadowedRange
      if (summary.seq + 1 !== event.seq || typeof replacement !== 'object' || replacement.op !== 'replace'
        || replacement.startSeq !== start || replacement.endSeq !== end || !event.sourceEventSeqs?.includes(summary.seq)
        || summary.data.sourceCommandId !== event.data.source.sourceCommandId
        || !summary.data.shadowedSeqs.every(seq => event.sourceEventSeqs?.includes(seq))) {
        throw new Error('A native compaction checkpoint does not match its recorded inputs')
      }
      copies.set(event.seq, event)
      affected.add(event.seq)
    } else if (event.type === 'compaction/end' && event.data.error !== undefined) {
      if (summaries.has(event.data.compactionId) || failed.has(event.data.compactionId)) copies.set(event.seq, event)
    } else {
      const prior = compactionInputs(events, event)
      if (prior?.selected.some(seq => affected.has(seq))) failed.add(prior.id)
    }
  }
  return copies
}

export function asNativeCompactionCopy(event: SessionEvent): NativeCompactionCopy | undefined {
  if (event.type === 'compaction/summary' || event.type === 'compaction/end' && event.data.error !== undefined
    || event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint') return event
  return
}

/** Add every dependent compaction to the session's exact publication set. */
export function addNativeCompactionCopies(events: readonly SessionEvent[], occurrences: Map<number, NativeEventCopy>,
  operationId: string, journal: NativeEventJournal, receipts: ReturnType<NativeEventJournal['read']>) {
  for (const event of nativeCompactionCopies(events, new Set(occurrences.keys())).values()) {
    const copy = planNativeEventCopy({ event, attempt: operationId, journal, receipts, project: () => projectNativeCompaction(event) })
    if (!copy) throw new Error('A derived native compaction could not be verified')
    occurrences.set(event.seq, copy)
  }
}
