import { createHash, createHmac } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
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
import { createNativeSpills } from './native-spills.ts'
import { createNativeDerivedMessages } from './native-derived-messages.ts'
import { createNativeErasureReceipts } from './native-erasure-receipts.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const span = z.strictObject({ start: z.int().nonnegative(), end: z.int().positive() }).refine(x => x.end > x.start)
const replica = z.strictObject({
  sessionId: z.string().min(1), messageId: z.string().min(1), sourceId: z.string().min(1),
  sourceHash: digest, wireHash: digest, contentHash: digest,
  sourceSpans: z.array(span).min(1), wireCuts: z.array(span).min(1),
})
const planShape = z.strictObject({
  sessions: z.array(z.string().min(1)), ranges: z.array(memoryHostErasureRange), originals: z.array(replica).optional(),
})
const publicationShape = z.strictObject({
  intent: z.strictObject({ before: digest, after: digest, events: digest }),
  media: z.array(z.strictObject({ messageId: z.string().min(1), sourceHash: digest, wireHash: digest, contentHash: digest })),
})
type Plan = z.output<typeof planShape>
type Publication = z.output<typeof publicationShape>
type Medium = Publication['media'][number]
export type NativeOriginalCandidate = { sessionId: string, messageId: string, wireText: string, contentDigest: string }

/** Probe inside the live owner before releasing the root for cold native maintenance. */
export function nativeMaintenancePending(db: DatabaseSync) {
  const receipts = createNativeErasureReceipts(db)
  return db.prepare('SELECT operation FROM owner_file_native_erasures').all()
    .some(row => !receipts.complete(String(row.operation)))
}

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
export function openNativeOriginalMaintenance(root: string, hostNamespace: string | undefined) {
  if (!existsSync(path.join(root, 'memory.db'))) return null
  const lock = lockMemoryRoot(root)
  let db: DatabaseSync | undefined
  try {
    const file = path.join(lock.root, 'memory.db')
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) { lock.close(); return null }
    const probe = new DatabaseSync(file, { readOnly: true })
    let secret: string | undefined
    try {
      if (probe.prepare('PRAGMA user_version').get()?.user_version === MEMORY_CONTRACT
        && probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_file_native_erasures'").get()) {
        const meta = probe.prepare('SELECT value FROM memory_meta WHERE key=?')
        const identity = digest.safeParse(meta.get('secret')?.value)
        if (identity.success && meta.get('owner.host')?.value === hostNamespace) secret = identity.data
      }
    } finally { probe.close() }
    if (!secret) {
      lock.close()
      return null
    }
    db = new DatabaseSync(file)
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
  const spills = createNativeSpills(db)
  const derived = createNativeDerivedMessages(db)
  const outputJournal = createNativeOutputJournal(db, surface.mark)
  const cleanupReceipts = createNativeErasureReceipts(db)
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
      satisfiesCuts(candidate: NativeOriginalCandidate) {
        const original = replicas.get(candidate.messageId)
        if (!original || maskTextSpans(candidate.wireText, original.wireCuts) !== candidate.wireText) return false
        const actual = { messageId: candidate.messageId, wireHash: hash(candidate.wireText), contentHash: hash(candidate.contentDigest) }
        return (knownMedia.get(candidate.messageId) ?? []).some(proof =>
          proof.wireHash === actual.wireHash && proof.contentHash === actual.contentHash)
      },
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
      const { ranges } = planShape.parse(JSON.parse(String(row.payload)))
      const operationId = z.uuid().parse(row.operation)
      const journal = outputJournal.forOperation(operationId)
      const targets = () => outputAttempts.affected(ranges).flatMap(attempt =>
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
        (call.result || call.absent && call.inputDerived) && !outputJournal.erased(call.id) ? [call] : [])
      return targets().length || journal.pendingSessions().length ? [{ operationId, journal, targets, rootCuts: toolReads.rootCuts }] : []
    })
  }

  function spillOperations() {
    return outputPlans.all().map(row => {
      const { ranges } = planShape.parse(JSON.parse(String(row.payload)))
      const targets = () => spills.affected(toolReads.affected(ranges), outputAttempts.affected(ranges))
      return { operationId: z.uuid().parse(row.operation), targets, complete: spills.complete,
        pending: () => targets().length > 0 }
    }).filter(operation => operation.pending())
  }

  function ptcInputCuts() {
    const cuts = new Map<string, ReturnType<typeof toolReads.readCuts>[number]>()
    for (const row of outputPlans.all()) {
      const { ranges } = planShape.parse(JSON.parse(String(row.payload)))
      for (const cut of toolReads.readCuts(ranges)) if (!outputJournal.erased(cut.call.id)) cuts.set(JSON.stringify(cut), cut)
    }
    return [...cuts.values()]
  }

  function derivedMessageOperations() {
    return outputPlans.all().flatMap(row => {
      const { ranges } = planShape.parse(JSON.parse(String(row.payload)))
      const operationId = z.uuid().parse(row.operation)
      const journal = outputJournal.forOperation(operationId + ':derived-messages')
      const targets = () => derived.affected(ranges)
      return targets().length || journal.pendingSessions().length ? [{ operationId, journal, targets, complete: derived.erased,
        verify: (target: { digest: string, envelope?: string }, content: string, messageDigest: string) => hash(content) === target.digest
          && (!target.envelope || hash(messageDigest) === target.envelope),
      }] : []
    })
  }

  db.exec(`CREATE TABLE IF NOT EXISTS owner_native_recovery_erased (
    operation TEXT NOT NULL,ticket TEXT NOT NULL,PRIMARY KEY(operation,ticket)
  ) WITHOUT ROWID`)
  const recoveryTickets = db.prepare('SELECT id,payload FROM owner_context_recoveries')
  const recovered = db.prepare('SELECT 1 FROM owner_native_recovery_erased WHERE operation=? AND ticket=?')
  const eraseRecovery = db.prepare('INSERT OR IGNORE INTO owner_native_recovery_erased VALUES (?,?)')
  function recoveryMessageOperations() {
    return outputPlans.all().flatMap(row => {
      const plan = planShape.parse(JSON.parse(String(row.payload)))
      if (!plan.originals?.length) return []
      const operationId = z.uuid().parse(row.operation), originals = operation(operationId, plan)
      const messageIds = originals.messageIds
      const journal = outputJournal.forOperation(operationId + ':recovery-messages')
      const targets = () => recoveryTickets.all().flatMap(row => {
        const ticket = z.strictObject({
          ticketId: z.uuid(), sessionId: z.string(), state: z.enum(['prepared', 'bound', 'committed']),
          replacementMessageId: z.string().optional(), replacementHash: digest.optional(),
          retainedMessageIds: z.array(z.string()),
        }).passthrough().parse(JSON.parse(String(row.payload)))
        return ticket.state !== 'prepared' && ticket.replacementMessageId && ticket.replacementHash
          && ticket.retainedMessageIds.some(id => messageIds.has(id)) && !recovered.get(operationId, ticket.ticketId)
          ? [{ ticket: ticket.ticketId, message: ticket.replacementMessageId, hash: ticket.replacementHash, originals: ticket.retainedMessageIds }] : []
      })
      return targets().length || journal.pendingSessions().length ? [{ operationId, journal, targets,
        contains: (message: string) => messageIds.has(message), authorize: originals.authorize, satisfies: originals.satisfiesCuts,
        complete(tickets: readonly string[]) { transaction(db, () => { for (const id of tickets) eraseRecovery.run(operationId, id) }) },
      }] : []
    })
  }

  function unsettledReceipts() {
    const attempts = new Map<string, ReturnType<typeof outputAttempts.affected>[number]>()
    const tools = new Map<string, ReturnType<typeof toolReads.affected>[number]>()
    for (const row of outputPlans.all()) {
      const { ranges } = planShape.parse(JSON.parse(String(row.payload)))
      for (const item of outputAttempts.affected(ranges)) if (item.result.state === 'open') attempts.set(item.id, item)
      for (const item of toolReads.affected(ranges)) if (!item.result && !item.absent) tools.set(item.id, item)
    }
    return { attempts: [...attempts.values()], tools: [...tools.values()] }
  }

  function acknowledgeCatalog(catalog: string, uncertainSessions: ReadonlySet<string>) {
    if (outputJournal.pending()) return
    const completedOriginal = db.prepare('SELECT 1 FROM owner_native_original_completed WHERE operation=?')
    const activeRecoveries = new Set(recoveryMessageOperations().map(item => item.operationId))
    const activeSpills = new Set(spillOperations().map(item => item.operationId))
    const publishedOriginalSessions = db.prepare('SELECT session FROM owner_native_original_publications WHERE operation=?')
    const publishedDerivedSessions = db.prepare('SELECT session FROM owner_native_output_publications WHERE operation=? OR operation LIKE ?')
    for (const row of outputPlans.all()) {
      const operationId = z.uuid().parse(row.operation), plan = planShape.parse(JSON.parse(String(row.payload)))
      const sessions = [...plan.sessions, ...publishedOriginalSessions.all(operationId).map(row => String(row.session)),
        ...publishedDerivedSessions.all(operationId, operationId + ':%').map(row => String(row.session))]
      if (sessions.some(session => uncertainSessions.has(session)) || activeRecoveries.has(operationId) || activeSpills.has(operationId)
        || plan.originals?.length && !completedOriginal.get(operationId)
        || outputAttempts.affected(plan.ranges).some(item => !outputJournal.erased(item.id))
        || toolReads.affected(plan.ranges).some(item => !item.result && !item.absent || !outputJournal.erased(item.id))
        || derived.affected(plan.ranges).length) continue
      cleanupReceipts.acknowledge(operationId, catalog)
    }
  }

  const unsettled = db.prepare('SELECT DISTINCT operation FROM owner_native_original_publications WHERE published=0')
  return { operations, operation, outputOperations, toolResultOperations, spillOperations, derivedMessageOperations, recoveryMessageOperations, unsettledReceipts, acknowledgeCatalog,
    hasPlans: () => outputPlans.all().some(row => !cleanupReceipts.complete(String(row.operation))),
    ptcInputCuts,
    toolInputRootCuts: toolReads.rootCuts,
    recoverPtcInput(call: Parameters<typeof toolReads.recoverInput>[0], evidence: Parameters<typeof toolReads.recoverInput>[1]) {
      toolReads.recoverInput(call, evidence, outputJournal.forOperation('native-proof').provenTransition)
    },
    nativeTransition: outputJournal.forOperation('native-proof').provenTransition,
    finishRecoveredOutput: outputAttempts.finish, finishRecoveredTool: toolReads.finish,
    finishAbsentTool(call: Parameters<typeof toolReads.finishAbsent>[0]) {
      toolReads.finishAbsent(call)
      if (!call.inputDerived) outputJournal.forOperation('native-absent-tools').complete([call.id])
    },
    toolSpillsPending: (call: Parameters<typeof toolReads.finishAbsent>[0]) => spillOperations().some(operation => operation.targets().some(spill =>
      spill.call.id === call.id || spill.call.session === call.session && spill.call.generation === call.generation
        && spill.call.ptc?.rootCallId === call.callId)),
    pendingOriginalOperations: () => new Set(unsettled.all().map(row => String(row.operation))),
    carriesUnsettledPublication: () => Boolean(unsettled.get()) || outputJournal.pending(),
    close() { try { db.close() } finally { closeLock() } } }
}
