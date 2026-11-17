import type { DatabaseSync } from 'node:sqlite'
import { mergeTextSpans, type TextSpan } from '../contracts/text-spans.ts'
import type { MemoryHostErasureRange } from '../contracts/service.ts'

/** Authenticated wire locations in an adapter-owned session. Offsets address the
 * joined native text, while the digest binds all original message blocks. */
type OriginalReplica = {
  sessionId: string
  messageId: string
  sourceId: string
  sourceHash: string
  wireHash: string
  contentHash: string
  sourceSpans: TextSpan[]
  wireCuts: TextSpan[]
}

function mapSourceCuts(sourceSpans: readonly TextSpan[], range: MemoryHostErasureRange): TextSpan[] {
  const cuts = mergeTextSpans(range.spans)
  const wireCuts: TextSpan[] = []
  let sourceOffset = 0, cutIndex = 0
  for (const span of sourceSpans) {
    const sourceEnd = sourceOffset + span.end - span.start
    for (; cutIndex < cuts.length; cutIndex++) {
      const cut = cuts[cutIndex]!
      if (cut.start >= sourceEnd) break
      const start = Math.max(cut.start, sourceOffset), end = Math.min(cut.end, sourceEnd)
      if (start < end) wireCuts.push({ start: span.start + start - sourceOffset, end: span.start + end - sourceOffset })
      if (cut.end > sourceEnd) break
    }
    sourceOffset = sourceEnd
  }
  if (sourceOffset !== range.length) throw new Error('Native original does not match the canonical source length')
  return wireCuts
}

export function createOwnerNativeOriginals(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_message_wires (
    message TEXT PRIMARY KEY, source_hash TEXT, spans TEXT NOT NULL
  )`)
  const insert = db.prepare('INSERT INTO owner_message_wires(message,source_hash,spans) VALUES (?,?,?)')
  // A removed or unadmitted occurrence can still exist in the native audit log.
  // Include it even when it never contributed to a model dispatch readset.
  const replicas = db.prepare(`
    SELECT occurrence.session AS sessionId, message.id AS messageId, message.source AS sourceId,
      wire.source_hash AS sourceHash, message.hash AS wireHash, content.digest AS contentHash, wire.spans
    FROM owner_occurrences occurrence
    JOIN owner_messages message ON message.id=occurrence.message AND message.source=occurrence.source
    JOIN owner_message_content content ON content.message=message.id
    JOIN owner_message_wires wire ON wire.message=message.id
    WHERE occurrence.source=? AND message.kind='original' AND wire.source_hash IS NOT NULL
    ORDER BY occurrence.session,message.id
  `)
  return {
    record(messageId: string, sourceHash: string | null, spans: readonly TextSpan[]) {
      insert.run(messageId, sourceHash, JSON.stringify(spans))
    },
    replicas(ranges: readonly MemoryHostErasureRange[]): OriginalReplica[] {
      type StoredReplica = Omit<OriginalReplica, 'sourceSpans' | 'wireCuts'> & { spans: string }
      return ranges.flatMap(range => (replicas.all(range.sourceId) as StoredReplica[]).map(({ spans, ...row }) => {
        const sourceSpans = JSON.parse(spans) as TextSpan[]
        return { ...row, sourceSpans, wireCuts: mapSourceCuts(sourceSpans, range) }
      }))
    },
  }
}
