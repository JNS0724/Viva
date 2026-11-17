import { randomUUID } from 'node:crypto'
import { belongsTo, contextOf, isConversationEvent, type ContextEvent, type ConversationContext } from '../shared/conversation-context.ts'
import { invalidatesConversationSnapshot, type StreamMark } from '../shared/renderer-sync.ts'

/** Synchronous publication boundary shared by pushes, saved-history receipts and initialization snapshots. */
export function createRendererStream(publish: (event: { type: string, [key: string]: unknown }) => void) {
  const streamGeneration = randomUUID()
  let eventCursor = 0, bytes = 0, lostThrough = 0
  const held: Array<{ json: string, cursor: number, routing: ContextEvent, bytes: number }> = []
  const saved = new Map<string, number>()
  function send(input: { type: string, [key: string]: unknown }) {
    const event: { type: string, [key: string]: unknown } = { ...input, streamGeneration, eventCursor: ++eventCursor }
    if (isConversationEvent(event)) {
      const json = JSON.stringify(event), size = Math.max(json.length * 2, Buffer.byteLength(json)) + 128
      held.push({ json, cursor: eventCursor, routing: { type: event.type, context: contextOf(event) }, bytes: size }); bytes += size
      while (held.length > 1024 || bytes > 2 * 1024 * 1024) {
        const removed = held.shift()!
        bytes -= removed.bytes; lostThrough = removed.cursor
      }
    }
    // A replay cache is not a second copy from which withdrawn generated content may return.
    if (invalidatesConversationSnapshot(event)) {
      held.length = 0; bytes = 0; lostThrough = eventCursor
    }
    publish(event)
  }
  function validateSave(conversationId: string, mark?: StreamMark) {
    if (!mark) return
    if (mark.streamGeneration !== streamGeneration || mark.eventCursor > eventCursor || mark.eventCursor < (saved.get(conversationId) ?? 0)) throw new Error('Stale conversation save boundary')
  }
  function save(conversationId: string, mark?: StreamMark) {
    validateSave(conversationId, mark)
    if (!mark) { saved.delete(conversationId); return }
    saved.delete(conversationId); saved.set(conversationId, mark.eventCursor)
    if (saved.size > 128) saved.delete(saved.keys().next().value!)
  }
  function snapshot(conversationId: string, context: ConversationContext) {
    const cutoff = saved.get(conversationId) ?? 0
    if (cutoff < lostThrough) throw new Error('Conversation stream has an unreplayable gap')
    return { streamGeneration, cutoverCursor: eventCursor,
      replay: held.filter(row => row.cursor > cutoff && belongsTo(row.routing, context)).map(row => JSON.parse(row.json) as unknown) }
  }
  return { send, save, validateSave, snapshot }
}
