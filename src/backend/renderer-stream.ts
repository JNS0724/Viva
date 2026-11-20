import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { belongsTo, contextOf, isConversationEvent, type ConversationContext } from '../shared/conversation-context.ts'
import { invalidatesConversationSnapshot, type StreamMark } from '../shared/renderer-sync.ts'

/** Publication, saved history and replay cutoffs share a synchronous boundary on this backend connection. */
export function createRendererStream(publish: (event: { type: string, [key: string]: unknown }) => void, db: DatabaseSync) {
  const streamGeneration = randomUUID()
  let eventCursor = 0, bytes = 0
  const held: Array<{ json: string, cursor: number, routing: { type: string, context: ConversationContext }, scope: string, reportId?: string, bytes: number }> = []

  // Connection-local scalar receipts outlive the bounded replay buffer, including for inactive conversations.
  // Eviction must never turn one session's lost data into another session's replay gap.
  db.exec('CREATE TEMP TABLE renderer_watermarks (kind TEXT, scope TEXT, cursor INTEGER NOT NULL, PRIMARY KEY(kind, scope)) WITHOUT ROWID')
  const read = db.prepare('SELECT cursor FROM temp.renderer_watermarks WHERE kind = ? AND scope = ?')
  const write = db.prepare('INSERT INTO temp.renderer_watermarks VALUES (?, ?, ?) ON CONFLICT(kind, scope) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)')
  const removeSave = db.prepare("DELETE FROM temp.renderer_watermarks WHERE kind = 'save' AND scope = ?")
  const watermark = (kind: 'loss' | 'save', scope: string): number => Number(read.get(kind, scope)?.cursor ?? 0)
  const key = (session: string | null, conversation: string | null) => JSON.stringify([session, conversation])
  // Streaming chunks normally evict consecutive rows for one scope; store its latest loss without repeated SQL writes.
  let lastLoss: { scope: string, cursor: number } | undefined
  function recordLoss(scope: string, cursor: number) {
    if (lastLoss?.scope === scope) lastLoss.cursor = Math.max(lastLoss.cursor, cursor)
    else {
      if (lastLoss) write.run('loss', lastLoss.scope, lastLoss.cursor)
      lastLoss = { scope, cursor }
    }
  }
  function loss(scope: string): number {
    return Math.max(watermark('loss', scope), lastLoss?.scope === scope ? lastLoss.cursor : 0)
  }

  function send(input: { type: string, [key: string]: unknown }) {
    const event: { type: string, [key: string]: unknown } = { ...input, streamGeneration, eventCursor: ++eventCursor }
    const origin = contextOf(event)
    if (origin && belongsTo(event, origin) && isConversationEvent(event)) {
      const json = JSON.stringify(event), size = Math.max(json.length * 2, Buffer.byteLength(json)) + 128
      held.push({ json, cursor: eventCursor, routing: { type: event.type, context: origin }, scope: key(origin.sessionId, origin.conversationId),
        reportId: event.type === 'report_delivered' && typeof event.reportId === 'string' ? event.reportId : undefined, bytes: size })
      bytes += size
      while (held.length > 1024 || bytes > 2 * 1024 * 1024) {
        const removed = held.shift()!
        bytes -= removed.bytes; recordLoss(removed.scope, removed.cursor)
      }
    }
    if (invalidatesConversationSnapshot(event)) {
      const reports = new Set<unknown>(Array.isArray(event.reportIds) ? event.reportIds : [])
      const sessions = new Set<unknown>(Array.isArray(event.traceSessions) ? event.traceSessions : [])
      if (Array.isArray(event.erasedOutputs)) for (const copy of event.erasedOutputs) {
        if (copy && typeof copy === 'object' && 'session' in copy) sessions.add(copy.session)
      }
      // Generated traces are session-scoped; report removals identify exact records. Feed IDs refer to another store.
      for (let index = held.length - 1; index >= 0; index--) {
        const row = held[index]!
        if (!sessions.has(row.routing.context.sessionId) && !(row.reportId !== undefined && reports.has(row.reportId))) continue
        held.splice(index, 1)
        bytes -= row.bytes; recordLoss(row.scope, eventCursor)
      }
    }
    publish(event)
  }
  function validateSave(conversationId: string, mark?: StreamMark) {
    if (!mark) return
    if (mark.streamGeneration !== streamGeneration || mark.eventCursor > eventCursor || mark.eventCursor < watermark('save', conversationId)) throw new Error('Stale conversation save boundary')
  }
  function save(conversationId: string, mark?: StreamMark) {
    validateSave(conversationId, mark)
    if (mark) write.run('save', conversationId, mark.eventCursor)
    else removeSave.run(conversationId)
  }
  function snapshot(conversationId: string, context: ConversationContext, stopped = false) {
    const cutoff = watermark('save', conversationId)
    if (cutoff < Math.max(loss(key(context.sessionId, context.conversationId)), loss(key(context.sessionId, null)))) {
      // The execution is fenced. Its saved checkpoint and restart action remain usable
      // even when this window missed more output than the replay buffer retains.
      if (stopped) return { streamGeneration, cutoverCursor: eventCursor, replay: [], stoppedReplayLost: true }
      throw new Error('Conversation stream has an unreplayable gap')
    }
    return { streamGeneration, cutoverCursor: eventCursor,
      replay: held.filter(row => row.cursor > cutoff && belongsTo(row.routing, context)).map(row => JSON.parse(row.json) as unknown) }
  }
  return { send, save, validateSave, snapshot }
}
