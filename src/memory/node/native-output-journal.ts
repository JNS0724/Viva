import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { transaction } from './sqlite.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const replacement = z.strictObject({
  attempt: z.uuid(), seq: z.int().nonnegative(), before: digest, after: digest, trace: digest.optional(),
})
const publication = z.strictObject({
  intent: z.strictObject({ before: digest, after: digest, events: digest }),
  replacements: z.array(replacement).min(1),
})
export type NativeOutputPublication = z.output<typeof publication>
export type NativeOutputReplacement = z.output<typeof replacement>

/** Holds exact artifact and event identities while native and trace publications are in flight. */
export function createNativeOutputJournal(db: DatabaseSync, invalidateSurface: (session: string) => void) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_native_output_publications (
      batch INTEGER PRIMARY KEY, operation TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS owner_native_output_session_publications ON owner_native_output_publications(operation,session);
    CREATE UNIQUE INDEX IF NOT EXISTS owner_native_output_one_pending
      ON owner_native_output_publications(operation,session) WHERE published=0;
    CREATE TABLE IF NOT EXISTS owner_native_output_erased (attempt TEXT PRIMARY KEY);
  `)
  const record = db.prepare(`SELECT batch,payload,published FROM owner_native_output_publications
    WHERE operation=? AND session=? ORDER BY batch DESC`)
  const insert = db.prepare('INSERT INTO owner_native_output_publications(operation,session,payload) VALUES (?,?,?)')
  const acknowledge = db.prepare('UPDATE owner_native_output_publications SET published=1 WHERE batch=?')
  const unresolved = db.prepare('SELECT session FROM owner_native_output_publications WHERE operation=? AND published=0')
  const pending = db.prepare('SELECT 1 FROM owner_native_output_publications WHERE published=0 LIMIT 1')
  const projected = db.prepare(`SELECT r.value FROM owner_native_output_publications p,json_each(p.payload,'$.replacements') r
    WHERE p.published=1 AND json_extract(r.value,'$.attempt')=? AND json_extract(r.value,'$.seq')=?
    AND json_extract(r.value,'$.before')=? AND json_extract(r.value,'$.after')=? LIMIT 1`)
  const erased = db.prepare('SELECT 1 FROM owner_native_output_erased WHERE attempt=?')
  const satisfy = db.prepare('INSERT OR IGNORE INTO owner_native_output_erased VALUES (?)')
  function read(operation: string, session: string) {
    return record.all(operation, session).map(row => ({ ...publication.parse(JSON.parse(String(row.payload))),
      batch: Number(row.batch), published: Boolean(row.published) }))
  }
  return {
    pending: () => Boolean(pending.get()),
    erased: (attempt: string) => Boolean(erased.get(attempt)),
    forOperation(operation: string) {
      return {
        pendingSessions: () => unresolved.all(operation).map(row => String(row.session)),
        read: (session: string) => read(operation, session),
        provenProjection({ attempt, seq, before, after }: NativeOutputReplacement) {
          const found = projected.get(attempt, seq, before, after)
          return found ? replacement.parse(JSON.parse(String(found.value))) : undefined
        },
        markCopied: invalidateSurface,
        prepare(session: string, output: NativeOutputPublication) {
          transaction(db, () => {
            insert.run(operation, session, JSON.stringify(publication.parse(output)))
            invalidateSurface(session)
          })
        },
        finish(session: string, intent: NativeOutputPublication['intent']) {
          const saved = read(operation, session).find(batch => !batch.published)
          if (!saved || JSON.stringify(saved.intent) !== JSON.stringify(intent)) throw new Error('Native output publication changed')
          acknowledge.run(saved.batch)
        },
        complete(attempts: readonly string[]) {
          if (unresolved.get(operation)) throw new Error('Native output publication still requires recovery')
          transaction(db, () => { for (const attempt of attempts) satisfy.run(attempt) })
        },
      }
    },
  }
}
