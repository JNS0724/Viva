import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { memoryHostErasureRange, type MemoryHostErasureRange } from '../memory/contracts/service.ts'
import { maskTextSpans } from '../memory/contracts/text-spans.ts'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** A question reply can display its selected options before the canonical custom answer. */
function applyRange(text: string, cut: MemoryHostErasureRange): string | null {
  const offset = text.length - cut.length
  if (offset < 0 || offset > 0 && text[offset - 1] !== '、') return null
  const canonical = text.slice(offset), hash = digest(canonical)
  if (hash === cut.afterHash) return text
  if (hash !== cut.hash) return null
  const projected = maskTextSpans(canonical, cut.spans)
  if (digest(projected) !== cut.afterHash) throw new Error('Memory history erasure proof conflicts')
  return text.slice(0, offset) + projected
}

export function createHistoryMemoryRanges(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_erased_source_ranges (
    source TEXT NOT NULL, revision INTEGER NOT NULL, cut TEXT NOT NULL, PRIMARY KEY(source,revision)
  ); CREATE TABLE IF NOT EXISTS memory_erased_history_replicas (
    conversation TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(conversation,source)
  )`)
  const latest = db.prepare('SELECT coalesce(max(rowid),0) revision FROM memory_erased_source_ranges')
  const revision = () => Number(latest.get()?.revision ?? 0)
  const read = db.prepare('SELECT cut FROM memory_erased_source_ranges WHERE source=? ORDER BY revision')
  const insert = db.prepare('INSERT INTO memory_erased_source_ranges VALUES (?,?,?)')
  const bind = db.prepare('INSERT OR IGNORE INTO memory_erased_history_replicas VALUES (?,?)')
  const replicas = db.prepare('SELECT source FROM memory_erased_history_replicas WHERE conversation=?')
  const bindSaved = db.prepare(`INSERT OR IGNORE INTO memory_erased_history_replicas
    SELECT ?,source_id FROM messages WHERE conversation_id=? AND source_id IN (SELECT source FROM memory_erased_source_ranges)`)
  const messages = db.prepare('SELECT id,conversation_id,text,receipt FROM messages WHERE source_id=?')
  const rewrite = db.prepare('UPDATE messages SET text=?,receipt=NULL WHERE id=?')
  const whollyErased = db.prepare('SELECT 1 FROM memory_erased_sources WHERE id=?')
  const cutsOf = (source: string) => read.all(source).map(row => memoryHostErasureRange.parse(JSON.parse(String(row.cut))))

  function project(text: string, cuts: readonly MemoryHostErasureRange[]) {
    let current = text, matched = false
    for (const cut of cuts) {
      const next = applyRange(current, cut)
      if (next === null && matched) return null
      if (next !== null) { current = next; matched = true }
    }
    return matched ? current : null
  }

  /** Incoming renderer snapshots may predate several cuts. Replay every cut after the verified input version. */
  function forSave(source: string, text: string, fallback?: string) {
    const cuts = cutsOf(source)
    if (!cuts.length) return undefined
    const projected = project(text, cuts)
    if (projected !== null) return projected
    // A replacement that cannot be placed in the cut chain cannot replace a known safe replica.
    return (fallback === undefined ? null : project(fallback, cuts)) ?? ''
  }

  /** Called inside the same transaction as the associated title and FTS updates. */
  function erase(ranges: readonly MemoryHostErasureRange[]) {
    const conversations = new Set<string>()
    let changed = false
    for (const range of ranges) {
      const cut = memoryHostErasureRange.parse(range)
      const cuts = cutsOf(cut.sourceId), current = cuts.at(-1)
      const previous = cuts.find(value => value.revision === cut.revision)
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(cut)) throw new Error('Memory history erasure identity conflicts')
        continue
      }
      if (current && (cut.revision <= current.revision || cut.hash !== current.afterHash)) {
        throw new Error('Memory history erasure is out of order')
      }
      if (!whollyErased.get(cut.sourceId)) for (const row of messages.all(cut.sourceId)) {
        const text = project(String(row.text), [...cuts, cut])
        if (text === null) throw new Error('Memory history replica has no matching erasure proof')
        if (text !== row.text || row.receipt !== null) rewrite.run(text, row.id)
        bind.run(row.conversation_id, cut.sourceId)
        conversations.add(String(row.conversation_id))
      }
      insert.run(cut.sourceId, cut.revision, JSON.stringify(cut))
      changed = true
    }
    return { changed, conversations }
  }

  return {
    forSave, erase,
    any: () => revision() > 0,
    revision,
    replicaSources: (conversation: string) => replicas.all(conversation).map(row => String(row.source)),
    bindSaved: (conversation: string) => bindSaved.run(conversation, conversation),
    recognizes: (source: string, text: string) => project(text, cutsOf(source)) !== null,
  }
}
