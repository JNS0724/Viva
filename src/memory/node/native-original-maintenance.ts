import { createHash, createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { MEMORY_CONTRACT } from '../contracts/memory-contract.ts'
import { memoryHostErasureRange } from '../contracts/service.ts'
import { maskTextSpans } from '../contracts/text-spans.ts'
import { lockMemoryRoot } from './owner-lock.ts'
import { APP_DB_PRAGMAS, transaction } from './sqlite.ts'
import { createNativeOutputAttempts } from './native-output-attempts.ts'
import { createNativeOutputJournal } from './native-output-journal.ts'
import { createNativeToolReads } from './native-tool-reads.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const span = z.strictObject({ start: z.int().nonnegative(), end: z.int().positive() }).refine(x => x.end > x.start)
const replica = z.strictObject({
  sessionId: z.string().min(1), messageId: z.string().min(1), sourceId: z.string().min(1),
  sourceHash: digest, wireHash: digest, contentHash: digest,
  sourceSpans: z.array(span).min(1), wireCuts: z.array(span).min(1),
})
const planShape = z.strictObject({
  sessions: z.array(z.string().min(1)), ranges: z.array(memoryHostErasureRange), memoryIds: z.array(z.int().nonnegative()).optional(), originals: z.array(replica).optional(),
})
const publicationShape = z.strictObject({
  intent: z.strictObject({ before: digest, after: digest, events: digest }),
  media: z.array(z.strictObject({ messageId: z.string().min(1), sourceHash: digest, wireHash: digest, contentHash: digest })),
})
type Plan = z.output<typeof planShape>
type Publication = z.output<typeof publicationShape>
type Medium = Publication['media'][number]
export type NativeOriginalCandidate = { sessionId: string, messageId: string, wireText: string, contentDigest: string }

export function nativeSurfaceInvalidation(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_native_surface_invalidations (session TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS owner_native_fork_parents (session TEXT PRIMARY KEY,parent TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_native_original_publications (
      operation TEXT NOT NULL, session TEXT NOT NULL, payload TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (operation, session)
    )
  `)
  const found = db.prepare('SELECT 1 FROM owner_native_surface_invalidations WHERE session=?')
  const remove = db.prepare('DELETE FROM owner_native_surface_invalidations WHERE session=?')
  const mark = db.prepare('INSERT OR IGNORE INTO owner_native_surface_invalidations VALUES (?)')
  const locate = db.prepare(`SELECT 1 FROM owner_native_original_publications pub,json_each(pub.payload,'$.media') medium
    WHERE pub.published=1 AND json_extract(medium.value,'$.messageId')=?
      AND json_extract(medium.value,'$.wireHash')=? AND json_extract(medium.value,'$.contentHash')=? LIMIT 1`)
  const parent = db.prepare('SELECT parent FROM owner_native_fork_parents WHERE session=?')
  const link = db.prepare('INSERT OR IGNORE INTO owner_native_fork_parents VALUES (?,?)')
  return {
    has: (session: string) => Boolean(found.get(session)),
    clear: (session: string) => { remove.run(session) },
    mark: (session: string) => { mark.run(session) },
    provesErasedOriginal: (message: string, wire: string, content: string) => Boolean(locate.get(message, wire, content)),
    parent: (session: string) => parent.get(session)?.parent as string | undefined,
    bindFork(session: string, parent: string) { link.run(session, parent) },
  }
}

/** Offline adapter access to the owner's exact original plans. It takes the same
 * root lock as the live owner and stores only receipts and digests. */
export function openNativeOriginalMaintenance(root: string, hostNamespace: string) {
  if (!existsSync(path.join(root, 'memory.db'))) return null
  const lock = lockMemoryRoot(root)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path.join(lock.root, 'memory.db'))
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== MEMORY_CONTRACT) throw new Error('Memory storage version prevents native cleanup')
    const meta = db.prepare('SELECT value FROM memory_meta WHERE key=?')
    const secret = meta.get('secret')?.value
    if (meta.get('owner.host')?.value !== hostNamespace || typeof secret !== 'string') throw new Error('Native cleanup owner binding differs')
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_file_native_erasures'").get()) {
      db.close()
      lock.close()
      return null
    }
    db.exec(APP_DB_PRAGMAS)
    return assemble(db, secret, lock.close)
  } catch (error) {
    try { db?.close() } finally { lock.close() }
    throw error
  }
}

function assemble(db: DatabaseSync, secret: string, closeLock: () => void) {
  const surface = nativeSurfaceInvalidation(db)
  const outputAttempts = createNativeOutputAttempts(db)
  const toolReads = createNativeToolReads(db)
  const outputJournal = createNativeOutputJournal(db, surface.mark)
  db.exec('CREATE TABLE IF NOT EXISTS owner_native_original_completed (operation TEXT PRIMARY KEY)')
  const hash = (value: string) => createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex')
  const canonical = (value: string) => createHash('sha256').update(value).digest('hex')
  const publications = db.prepare('SELECT payload, published FROM owner_native_original_publications WHERE operation=? AND session=?')
  const published = db.prepare('SELECT payload FROM owner_native_original_publications WHERE published=1')
  const complete = db.prepare('INSERT OR IGNORE INTO owner_native_original_completed VALUES (?)')

  function operations() {
    const rows = db.prepare(`SELECT plan.operation,plan.payload FROM owner_file_native_erasures plan
      WHERE NOT EXISTS(SELECT 1 FROM owner_native_original_completed c WHERE c.operation=plan.operation)
      ORDER BY plan.rowid`).all()
    return rows.flatMap(row => {
      const plan = planShape.parse(JSON.parse(String(row.payload)))
      return plan.originals?.length ? [{ operationId: z.uuid().parse(row.operation), plan }] : []
    })
  }

  function operation(operationId: string, plan: Plan) {
    const bySource = new Map(plan.ranges.map(range => [range.sourceId, range]))
    const replicas = new Map<string, z.output<typeof replica>>()
    for (const original of plan.originals ?? []) {
      const known = replicas.get(original.messageId)
      if (known && (known.sourceId !== original.sourceId || known.wireHash !== original.wireHash || known.contentHash !== original.contentHash)) {
        throw new Error('Native original locations disagree')
      }
      replicas.set(original.messageId, original)
    }
    const knownMedia = new Map<string, Medium[]>()
    for (const row of published.iterate()) {
      for (const medium of publicationShape.parse(JSON.parse(String(row.payload))).media) {
        if (!replicas.has(medium.messageId)) continue
        const prior = knownMedia.get(medium.messageId) ?? []
        prior.push(medium)
        knownMedia.set(medium.messageId, prior)
      }
    }
    function publication(session: string) {
      const row = publications.get(operationId, session)
      return row ? { ...publicationShape.parse(JSON.parse(String(row.payload))), published: Boolean(row.published) } : undefined
    }
    const matches = (proof: Medium, actual: Medium) => proof.messageId === actual.messageId && proof.sourceHash === actual.sourceHash
      && proof.wireHash === actual.wireHash && proof.contentHash === actual.contentHash

    function authorize(candidate: NativeOriginalCandidate) {
      const original = replicas.get(candidate.messageId)
      if (!original) return null
      const range = bySource.get(original.sourceId)
      if (!range || original.sourceSpans.some(part => part.end > candidate.wireText.length)) throw new Error('Native erasure source coordinates are unavailable')
      const sourceText = (wire: string) => original.sourceSpans.map(part => wire.slice(part.start, part.end)).join('')
      const source = sourceText(candidate.wireText)
      const actual = { messageId: candidate.messageId, sourceHash: canonical(source), wireHash: hash(candidate.wireText), contentHash: hash(candidate.contentDigest) }
      const prior = knownMedia.get(candidate.messageId) ?? []
      const sessionMedia = publication(candidate.sessionId)?.media ?? []
      if (actual.sourceHash === range.afterHash && [...prior, ...sessionMedia].some(proof => matches(proof, actual))) {
        return { kind: 'applied' as const }
      }
      if (source.length !== range.length || actual.sourceHash !== range.hash || ![original, ...prior].some(proof => matches(proof, actual))) {
        throw new Error('Native original bytes differ from their authenticated source')
      }
      const projected = maskTextSpans(candidate.wireText, original.wireCuts)
      if (canonical(sourceText(projected)) !== range.afterHash) throw new Error('Native source projection differs from the canonical erasure')
      return { kind: 'cut' as const, wireCuts: original.wireCuts,
        replaced(contentDigest: string): Medium {
          return { messageId: candidate.messageId, sourceHash: range.afterHash, wireHash: hash(projected), contentHash: hash(contentDigest) }
        } }
    }
    return {
      messageIds: new Set(replicas.keys()), authorize, publication,
      prepare(session: string, entry: Publication) {
        transaction(db, () => {
          db.prepare('INSERT INTO owner_native_original_publications VALUES (?,?,?,0)').run(operationId, session, JSON.stringify(publicationShape.parse(entry)))
          surface.mark(session)
        })
      },
      finish(session: string, verified: Publication['intent']) {
        transaction(db, () => {
          const prior = publication(session)
          if (!prior || JSON.stringify(prior.intent) !== JSON.stringify(verified)) throw new Error('Native publication receipt differed')
          db.prepare('UPDATE owner_native_original_publications SET published=1 WHERE operation=? AND session=?').run(operationId, session)
        })
      },
      markCopied(session: string) { surface.mark(session) },
      complete() { complete.run(operationId) },
      pendingSessions: () => db.prepare('SELECT session FROM owner_native_original_publications WHERE operation=? AND published=0').all(operationId).map(row => String(row.session)),
    }
  }
  const outputPlans = db.prepare('SELECT operation,payload FROM owner_file_native_erasures ORDER BY rowid')
  function outputOperations() {
    return outputPlans.all().flatMap(row => {
      const { ranges, memoryIds } = planShape.parse(JSON.parse(String(row.payload)))
      const operationId = z.uuid().parse(row.operation)
      const journal = outputJournal.forOperation(operationId)
      const targets = () => outputAttempts.affected(ranges, memoryIds ?? []).flatMap(attempt =>
        attempt.result.state === 'settled' && !outputJournal.erased(attempt.id) ? [{ ...attempt, result: attempt.result }] : [])
      return targets().length || journal.pendingSessions().length ? [{ operationId, journal, targets }] : []
    })
  }

  function toolResultOperations() {
    return outputPlans.all().flatMap(row => {
      const { ranges } = planShape.parse(JSON.parse(String(row.payload)))
      const operationId = z.uuid().parse(row.operation)
      const journal = outputJournal.forOperation(operationId + ':tool-results')
      const targets = () => toolReads.affected(ranges).flatMap(call =>
        call.result && !outputJournal.erased(call.id) ? [{ ...call, result: call.result }] : [])
      return targets().length || journal.pendingSessions().length ? [{ operationId, journal, targets }] : []
    })
  }

  const unsettled = db.prepare('SELECT DISTINCT operation FROM owner_native_original_publications WHERE published=0')
  return { operations, operation, outputOperations, toolResultOperations,
    pendingOriginalOperations: () => new Set(unsettled.all().map(row => String(row.operation))),
    carriesUnsettledPublication: () => Boolean(unsettled.get()) || outputJournal.pending(),
    close() { try { db.close() } finally { closeLock() } } }
}
