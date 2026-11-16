import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryStore } from '../core/ports/store.ts'
import type { MemoryContextRecoveryTicket, PrepareMemoryContextRecovery, BindMemoryContextRecovery, CommitMemoryContextRecovery } from '../contracts/context-recovery.ts'

type Retained = { messageId: string, sourceId: string, token: string }
type Saved = MemoryContextRecoveryTicket & { epoch: number, revision: number, evidence: string, candidatesHash: string, retained: Retained[] }

/** Durable proof of a native model-context replacement. No native event or DSH type enters storage. */
export function createOwnerContextRecovery({ db, store, hash, mutate, requireReady, sourceAllowed, replace, committed }: {
  db: DatabaseSync
  store: Pick<MemoryStore, 'tx' | 'epoch' | 'revision' | 'readSource' | 'deliveredSource' | 'dispatch'>
  hash(value: unknown): string
  mutate<T>(work: () => T): Promise<T>
  requireReady(): void
  sourceAllowed(session: string, source: string): boolean
  replace(session: string, sources: readonly string[]): void
  committed(session: string): void
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_message_content(message TEXT PRIMARY KEY,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_context_generations(session TEXT PRIMARY KEY,generation INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_context_recoveries(id TEXT PRIMARY KEY,session TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_context_retired(session TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(session,message));
    CREATE TABLE IF NOT EXISTS owner_derived_occurrences(session TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(session,message));
    CREATE TABLE IF NOT EXISTS owner_context_retired_children(parent TEXT NOT NULL,child TEXT NOT NULL,PRIMARY KEY(parent,child));
  `)
  const contextGeneration = (session: string) => Number(db.prepare('SELECT generation FROM owner_context_generations WHERE session=?').get(session)?.generation ?? 0)
  function saved(id: string): Saved {
    const row = db.prepare('SELECT payload FROM owner_context_recoveries WHERE id=?').get(id)
    if (!row) throw new Error('Unknown context recovery ticket')
    return JSON.parse(String(row.payload)) as Saved
  }
  function latest(session: string): Saved | null {
    const row = db.prepare('SELECT payload FROM owner_context_recoveries WHERE session=? ORDER BY rowid DESC LIMIT 1').get(session)
    return row ? JSON.parse(String(row.payload)) as Saved : null
  }
  function ticket(item: Saved): MemoryContextRecoveryTicket {
    const { epoch: _epoch, revision: _revision, evidence: _evidence, candidatesHash: _candidatesHash, retained: _retained, ...result } = item
    return result
  }
  const persist = (item: Saved) => db.prepare('UPDATE owner_context_recoveries SET payload=? WHERE id=?').run(JSON.stringify(item), item.ticketId)
  function original(session: string, message: string) {
    const row = db.prepare(`SELECT m.source,m.hash,o.conversation,c.digest FROM owner_messages m JOIN owner_occurrences o ON o.message=m.id
      LEFT JOIN owner_message_content c ON c.message=m.id
      WHERE o.session=? AND m.id=? AND m.kind='original' AND o.admitted=1 AND o.removed=0`).get(session, message)
    if (!row || !sourceAllowed(session, String(row.source))) return null
    const source = store.readSource(String(row.source))
    // Short clarification answers depend on their question and are not independent originals.
    if (source && (source.author !== 'user' || source.withdrawn || !source.text)) return null
    const delivery = store.deliveredSource(String(row.source))
    // Attachment-only human messages have a delivery identity but no textual memory source.
    // They are recoverable only when their complete host content identity was captured at intake.
    if (!source && (!row.digest || !delivery || delivery.derived || delivery.conversation !== row.conversation)) return null
    return { sourceId: String(row.source), hash: String(row.hash), digest: typeof row.digest === 'string' ? row.digest : undefined,
      token: hash({ source, delivery, digest: row.digest ?? null }) }
  }
  function current(item: Saved) {
    return contextGeneration(item.sessionId) === item.generation - 1 && store.epoch() === item.epoch
      && store.revision() === item.revision && hash(store.dispatch.snapshot(item.sessionId)) === item.evidence
      && item.retained.every(entry => {
        const now = original(item.sessionId, entry.messageId)
        return now?.sourceId === entry.sourceId && now.token === entry.token
      })
  }
  function contextRecovery(session: string) { const value = latest(session); return value ? ticket(value) : null }
  function pending(session: string) { const item = latest(session); return Boolean(item && item.state !== 'committed') }
  function retired(session: string, message: string) {
    return Boolean(db.prepare('SELECT 1 FROM owner_context_retired WHERE session=? AND message=?').get(session, message))
  }
  function retiredDerived(message: string) {
    return Boolean(db.prepare(`SELECT 1 FROM owner_context_retired r JOIN owner_derived d ON d.message=r.message
      WHERE r.message=? AND r.session=d.origin_session`).get(message))
  }
  async function prepareContextRecovery(input: PrepareMemoryContextRecovery): Promise<MemoryContextRecoveryTicket> {
    requireReady()
    if (!input.sessionId || !input.baseSurfaceHash || new Set(input.candidates.map(c => c.messageId)).size !== input.candidates.length) throw new Error('Invalid context recovery input')
    return mutate(() => {
      requireReady()
      const prior = latest(input.sessionId)
      if (prior && prior.state !== 'committed' && prior.baseSurfaceHash === input.baseSurfaceHash && prior.candidatesHash === hash(input.candidates) && current(prior)) return ticket(prior)
      const retained = input.candidates.flatMap(candidate => {
        const source = original(input.sessionId, candidate.messageId)
        return source && !retired(input.sessionId, candidate.messageId) && source.hash === hash(candidate.content)
          && (source.digest ? Boolean(candidate.contentDigest && source.digest === hash(candidate.contentDigest)) : candidate.contentDigest === undefined)
          ? [{ messageId: candidate.messageId, sourceId: source.sourceId, token: source.token }] : []
      })
      const item: Saved = { ticketId: randomUUID(), sessionId: input.sessionId, generation: contextGeneration(input.sessionId) + 1,
        baseSurfaceHash: input.baseSurfaceHash, state: 'prepared', retainedMessageIds: retained.map(r => r.messageId), retained,
        epoch: store.epoch(), revision: store.revision(), evidence: hash(store.dispatch.snapshot(input.sessionId)), candidatesHash: hash(input.candidates) }
      db.prepare('INSERT INTO owner_context_recoveries VALUES (?,?,?,?)').run(item.ticketId, item.sessionId, item.generation, JSON.stringify(item))
      return ticket(item)
    })
  }
  function bindContextRecovery(input: BindMemoryContextRecovery): MemoryContextRecoveryTicket {
    requireReady()
    const item = saved(input.ticketId)
    if (!input.replacementMessageId || !input.replacementHash || latest(item.sessionId)?.ticketId !== item.ticketId) throw new Error('Stale context recovery ticket')
    if (item.state !== 'prepared') {
      if (item.replacementMessageId !== input.replacementMessageId || item.replacementHash !== input.replacementHash) throw new Error('Context recovery replacement conflicts')
      return ticket(item)
    }
    if (!current(item)) throw new Error('Context recovery evidence changed')
    item.state = 'bound'; item.replacementMessageId = input.replacementMessageId; item.replacementHash = input.replacementHash
    persist(item)
    return ticket(item)
  }
  async function commitContextRecovery(input: CommitMemoryContextRecovery, stillCurrent: () => boolean): Promise<MemoryContextRecoveryTicket> {
    requireReady()
    return mutate(() => {
      requireReady()
      const item = saved(input.ticketId)
      if (!stillCurrent()) throw new Error('Native context changed before recovery commit')
      if (input.persisted !== true || item.state === 'prepared' || item.baseSurfaceHash !== input.baseSurfaceHash
        || item.replacementMessageId !== input.replacementMessageId || item.replacementHash !== input.replacementHash
        || latest(item.sessionId)?.ticketId !== item.ticketId) throw new Error('Context recovery acknowledgement conflicts')
      if (item.state === 'committed') return ticket(item)
      if (!current(item)) throw new Error('Context recovery evidence changed')
      store.tx(() => {
        // Retire every known old occurrence first, then exempt only authenticated human originals.
        db.prepare(`INSERT OR IGNORE INTO owner_context_retired SELECT session,message FROM owner_occurrences WHERE session=? AND admitted=1`).run(item.sessionId)
        db.prepare(`INSERT OR IGNORE INTO owner_context_retired SELECT session,message FROM owner_derived_occurrences WHERE session=?`).run(item.sessionId)
        db.prepare(`INSERT OR IGNORE INTO owner_context_retired SELECT origin_session,message FROM owner_derived WHERE origin_session=?`).run(item.sessionId)
        for (const retained of item.retained) db.prepare('DELETE FROM owner_context_retired WHERE session=? AND message=?').run(item.sessionId, retained.messageId)
        // Existing child output is part of the replaced surface, not fresh input to the new generation.
        db.prepare(`INSERT OR IGNORE INTO owner_context_retired_children SELECT parent,session FROM owner_session_parents WHERE parent=?`).run(item.sessionId)
        db.prepare('DELETE FROM owner_answer_sources WHERE session=?').run(item.sessionId)
        replace(item.sessionId, item.retained.map(r => r.sourceId))
        db.prepare('INSERT INTO owner_context_generations VALUES (?,?) ON CONFLICT(session) DO UPDATE SET generation=excluded.generation').run(item.sessionId, item.generation)
        item.state = 'committed'; persist(item)
      })
      committed(item.sessionId)
      return ticket(item)
    })
  }
  return { contextGeneration, contextRecovery, pending, retired, retiredDerived, prepareContextRecovery, bindContextRecovery, commitContextRecovery }
}
