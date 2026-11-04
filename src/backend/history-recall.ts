import type { openHistoryDb } from './history-db.ts'

/**
 * What the assistant can look up in the timeline (the viva-history plugin, history-channel.ts): messages by their
 * words, within a time range, each with the topic it is in; and the messages around one of them, read from where
 * it is kept (history-db.ts locate, history-reader.ts), so an answer can rest on what was said, not on a snippet.
 */
type HistoryDb = ReturnType<typeof openHistoryDb>
/** How many messages on either side of the one asked for are read at most. */
export const MAX_AROUND = 10
const DEFAULT_AROUND = 4

export type RecallRange = { since?: number, until?: number }
export type RecallMessage = { messageId: number, segmentId: string, seq: number, role: string, text: string, at: number, target: boolean }
export type Recalled =
  | { status: 'found' | 'missing', title: string, messages: RecallMessage[] }
  | { status: 'deleted' }

export function historyRecall(db: HistoryDb) {
  const titleOf = (segmentId: string) => {
    const reader = db.readerOf(segmentId)
    return reader?.topicId ? db.reviewTopic(reader.topicId)?.title ?? '' : ''
  }

  /** Search hits, newest first, each with the title of its topic. */
  function search(query: string, range: RecallRange = {}) {
    const titles = new Map<string, string>()
    return db.searchMessages(query, range).map((hit) => {
      if (!titles.has(hit.segmentId)) titles.set(hit.segmentId, titleOf(hit.segmentId))
      return { ...hit, title: titles.get(hit.segmentId) ?? '' }
    })
  }

  /**
   * The messages around one (a link from a search): `around` on either side, in its topic or its task. Not there any
   * more: the ones near where it was ('missing'); its record deleted: 'deleted'.
   */
  function read(ref: { segmentId: string, seq: number, messageId?: number }, around = DEFAULT_AROUND): Recalled {
    const located = db.locate(ref)
    if (located.status === 'deleted' || located.seq === null) return { status: 'deleted' }
    const reader = db.readerOf(located.segmentId)
    if (!reader) return { status: 'deleted' }
    const side = Math.min(Math.max(1, Math.trunc(around) || DEFAULT_AROUND), MAX_AROUND)
    const part = db.read(reader.key, { around: { segmentId: located.segmentId, seq: located.seq }, count: side * 2 + 1 })
    if (!part) return { status: 'deleted' }
    const title = part.topic?.title ?? titleOf(located.segmentId)
    const messages = part.messages.map((message) => ({
      messageId: message.id, segmentId: message.segmentId, seq: message.seq, role: message.role, text: message.text, at: message.at,
      target: located.status === 'found' && message.segmentId === located.segmentId && message.seq === located.seq,
    }))
    return { status: located.status, title, messages }
  }

  return { search, read }
}
