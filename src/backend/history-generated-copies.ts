import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { intersectsMemoryErasure, memoryErasureEvidenceSchema, type MemoryErasureEvidence } from '../memory/contracts/provenance.ts'
import type { StoredMessage } from './history-schema.ts'

type Role = 'assistant' | 'user'
export type GeneratedHistoryScope = { session: string, key: string, role: Role }
type Replica = { session: string, role: Role, digest: string, proof: string, erased: number }
const digestOf = (text: string) => createHash('sha256').update(text).digest('hex')
const blank = (message: StoredMessage): StoredMessage => ({ ...message, text: '', images: undefined, receipt: null })

/** Evidence is accepted only from a trusted host writer. Renderer snapshots supply a key and words, never proof. */
export function createHistoryGeneratedCopies(db: DatabaseSync, affected: (proof: MemoryErasureEvidence) => boolean) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_generated_history (
    key TEXT PRIMARY KEY, session TEXT NOT NULL, role TEXT NOT NULL, digest TEXT NOT NULL,
    proof TEXT NOT NULL, erased INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`)
  const select = db.prepare('SELECT session,role,digest,proof,erased FROM memory_generated_history WHERE key=?')
  const insert = db.prepare('INSERT INTO memory_generated_history VALUES (?,?,?,?,?,?)')
  const replicas = db.prepare('SELECT key,session,role,digest,proof,erased FROM memory_generated_history')
  const retire = db.prepare('UPDATE memory_generated_history SET erased=1 WHERE key=?')
  const copies = db.prepare('SELECT id,conversation_id,text FROM messages WHERE source_key=? AND session_id=? AND role=?')
  const mask = db.prepare("UPDATE messages SET text='',images=NULL,receipt=NULL WHERE id=?")
  const read = (key: string) => select.get(key) as Replica | undefined

  function bind(session: string, key: string, role: Role, text: string, evidence: readonly MemoryErasureEvidence[]) {
    const verified = evidence.map(item => memoryErasureEvidenceSchema.parse(item))
    const proof = JSON.stringify(verified.map(item => JSON.stringify(item)).sort().map(item => JSON.parse(item)))
    const digest = digestOf(text), old = read(key)
    if (old) {
      if (old.session !== session || old.role !== role || old.digest !== digest || old.proof !== proof) throw new Error('Generated history identity conflicts')
      return !old.erased
    }
    const erased = verified.some(affected)
    insert.run(key, session, role, digest, proof, Number(erased))
    return !erased
  }

  /** A late snapshot is accepted only for the exact proved payload or an already stored independent row. */
  function forSave(message: StoredMessage, session: string | null | undefined, known?: { text: string }) {
    if (message.role === 'note') return message
    const replica = message.key && read(message.key)
    if (replica && replica.session === session && replica.role === message.role) {
      if (replica.digest !== digestOf(message.text)) return known?.text === message.text ? message : blank(message)
      return replica.erased ? blank(message) : message
    }
    if (message.role === 'assistant' && message.key && known?.text !== message.text) return blank(message)
    return message
  }

  /** Called in the history erasure transaction, so later saves see the same retirement as readers. */
  function erase(ranges: Parameters<typeof intersectsMemoryErasure>[1], memoryIds: readonly number[]) {
    const conversations = new Set<string>()
    const erased: GeneratedHistoryScope[] = []
    for (const replica of replicas.all() as unknown as Array<Replica & { key: string }>) {
      const evidence = (JSON.parse(replica.proof) as unknown[]).map(item => memoryErasureEvidenceSchema.parse(item))
      if (!evidence.some(item => intersectsMemoryErasure(item, ranges, memoryIds))) continue
      erased.push({ key: replica.key, session: replica.session, role: replica.role })
      if (replica.erased) continue
      for (const row of copies.all(replica.key, replica.session, replica.role)) {
        if (digestOf(String(row.text)) !== replica.digest) continue
        mask.run(row.id)
        conversations.add(String(row.conversation_id))
      }
      retire.run(replica.key)
    }
    return { conversations, erased }
  }
  function retainedReply(session: string, key: string) {
    const replica = read(key)
    return replica?.session === session && replica.role === 'assistant' && !replica.erased
  }

  return { bind, forSave, erase, retainedReply }
}
