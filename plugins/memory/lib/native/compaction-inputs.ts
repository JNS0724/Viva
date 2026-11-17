import type {} from '@deepseek-ai/dsh-compaction'
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

const COMPACTION_INPUT = 'plugin:viva-memory/compaction-input'
const ordinal = z.int().nonnegative()
const inputShape = z.strictObject({ start: ordinal, id: z.string().min(1), selected: z.array(ordinal).min(1) })
type Inputs = z.infer<typeof inputShape>
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap { [COMPACTION_INPUT]: Inputs }
}

/** An input mark also covers compaction failures that have no summary. */
export function recordCompactionInputs(session: Session, selected: readonly SessionSeq[]) {
  const events = session.snapshotEvents()
  const start = events.findLast(event => event.type === 'compaction/start' || event.type === 'compaction/end' || event.type === 'session/end-seed')
  if (start?.type !== 'compaction/start' || !selected.length
    || selected.some(seq => seq < 0 || seq >= start.seq || !session.surface.nodes.includes(seq))) return
  appendPluginRecord(session, COMPACTION_INPUT, { start: start.seq, id: start.data.compactionId, selected: [...selected] })
}

export function compactionInputs(events: readonly SessionEvent[], event: SessionEvent): Inputs | undefined {
  const mark = pluginRecordOf(event)
  if (mark?.type !== COMPACTION_INPUT) return
  const parsed = inputShape.safeParse(mark.data)
  if (!parsed.success) return
  const { start, id, selected } = parsed.data
  const anchor = events[start]
  if (anchor?.type !== 'compaction/start' || anchor.data.compactionId !== id || anchor.seq >= mark.seq
    || selected.some(seq => seq >= anchor.seq)) return
  return parsed.data
}

/** The stock compaction request preserves the IDs and full derived bodies of
 * its surface inputs and appends one unidentified instruction message. */
export function recordCompactionRequest(session: Session, messages: readonly RequestMessage[]) {
  const supplied = messages.filter(message => 'id' in message)
  const selected = session.surface.nodes.filter(seq => {
    const event = session.eventAt(seq)
    if (!event) return false
    const projected = session.deriveEventMessage(event)
    return projected !== null && supplied.some(message => isDeepStrictEqual(projected, message))
  })
  if (selected.length !== supplied.length) throw new Error('Native compaction request has an unverified input message')
  recordCompactionInputs(session, selected)
}
