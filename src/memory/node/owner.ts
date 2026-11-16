import { createOwnerContextRecovery } from './owner-context-recovery.ts'
import { removeAbandonedMemoryTemps } from './memory-file-store.ts'
import { memoryProjectScope } from './project-scope.ts'
import path from 'node:path'
import { randomUUID, createHmac } from 'node:crypto'
import { lockMemoryRoot } from './owner-lock.ts'
import { openMemoryStore, memoryHash } from './memory-store.ts'
import { createMemoryRuntime } from './runtime.ts'
import { createMemoryEmbedder } from './memory-embedder.ts'
import type { NodeMemoryRuntimeOptions } from './runtime.ts'
import { combineMemoryProvenance } from '../contracts/provenance.ts'
import { createMemoryDispatch } from '../core/memory-dispatch.ts'
import { createMemoryCoordination } from '../core/coordination.ts'
import type { MemoryHistoryOccurrence } from '../core/coordination.ts'
import { MemoryDomainError } from '../core/presentation.ts'
import { createMemorySendFence } from '../core/send-fence.ts'
import { parseHostMemoryCommand } from '../contracts/host.ts'
import type { MemorySourceAlias, SourceChangeInput, HostMemoryCommand, MemoryOwnerContextUsed } from '../contracts/host.ts'
import type { MemoryOperationOutcome, MemoryHostEffect, MemorySourceReference } from '../contracts/service.ts'
import type { MemoryFileMutationResult, MemoryManagedFileIdentity } from '../contracts/file-management.ts'
import type { MemoryDomainErrorCode } from '../contracts/domain-error.ts'
import type { MemoryScope } from '../contracts/memory-contract.ts'

// Adapter-independent ingestion DTOs: the adapter authenticates identity and original/derived origin.
export type ReceivedSource = { sessionId: string, messageId: string, text: string, at: number, timezone: string,
  turn: number, step: number, eventSeq?: number, contextGeneration?: number, contentDigest?: string, admitted: boolean, inherited: boolean, project?: string, live?: boolean, derived?: boolean }
export type CompletedTurn = { sessionId: string, turn: number, eventSeq: number, contextGeneration?: number, sourceIds: readonly string[],
  assistant: string, completed: boolean, at: number, timezone: string }
export type DerivedSource = { verifiedDelivery?: true, contentDigest?: string, sessionId: string, messageId: string, eventSeq?: number, contextGeneration?: number, senderContextGeneration?: number, sourceIds: readonly string[], inherited?: boolean, senderSessionId?: string }
type Options = Pick<NodeMemoryRuntimeOptions, 'compute' | 'route' | 'quiesce'> & {
  root: string, hostNamespace?: string, dailyNotes?: NodeMemoryRuntimeOptions['dailyNotes'], fileMode?: boolean, embedding?: { modelRoot: string, runtimeRoot?: string },
  onChange?: NodeMemoryRuntimeOptions['changed'],
  onContextUsed?: (notice: Omit<MemoryOwnerContextUsed, 'type' | 'protocol' | 'epoch'>) => void,
  onProjectionChanged?: () => void,
  onHostEffects?: () => void, canPresentControlReceipt?: () => boolean,
}
type StoredAlias = Omit<MemorySourceAlias, 'text' | 'wireText'> & { textHash: string, textLength: number, textStart: number }
type Session = { conversation: string, context: string | null, project: string | null }
type Operation = { id: string, fingerprint: string, state: MemoryOperationOutcome['state'], payload: string | null, ticket: string | null }

/** Single storage owner shared by every adapter. Host callers never receive its DB or runtime. */
export function openMemoryOwner(options: Options) {
  const lock = lockMemoryRoot(options.root)
  const store = (() => { try { return openMemoryStore(path.join(lock.root, 'memory.db')) } catch (error) { lock.close(); throw error } })()
  try { removeAbandonedMemoryTemps(store.fileRoot); return assembleOwner(options, lock, store) }
  catch (error) { try { store.close() } finally { lock.close() }; throw error }
}

function assembleOwner(options: Options, lock: ReturnType<typeof lockMemoryRoot>, store: ReturnType<typeof openMemoryStore>) {
  const db = store.db
  const boundHost = store.meta('owner.host')
  if (boundHost && boundHost !== options.hostNamespace) throw new Error('Memory root belongs to a different host binding')
  if (options.hostNamespace && !boundHost) store.setMeta('owner.host', options.hostNamespace)
  const hash = (value: unknown) => createHmac('sha256', store.meta('secret')!).update(JSON.stringify(value)).digest('hex')
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_session_parents(session TEXT PRIMARY KEY,parent TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_active_turns(session TEXT PRIMARY KEY,turn TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_answer_sources(session TEXT NOT NULL,turn TEXT NOT NULL,source TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS owner_sessions(session TEXT PRIMARY KEY,conversation TEXT NOT NULL,context TEXT,project TEXT);
    CREATE TABLE IF NOT EXISTS owner_aliases(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,session TEXT NOT NULL,wire_hash TEXT NOT NULL,payload TEXT,source TEXT NOT NULL,conversation TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,delivery INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS owner_messages(id TEXT PRIMARY KEY,source TEXT NOT NULL,hash TEXT NOT NULL,kind TEXT NOT NULL,query_start INTEGER,query_end INTEGER);
    CREATE TABLE IF NOT EXISTS owner_occurrences(session TEXT NOT NULL,message TEXT NOT NULL,source TEXT NOT NULL,conversation TEXT NOT NULL,admitted INTEGER NOT NULL,removed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session,message));
    CREATE TABLE IF NOT EXISTS owner_derived(message TEXT PRIMARY KEY,evidence TEXT NOT NULL,origin_session TEXT NOT NULL,origin_turn TEXT,owner_epoch TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_turns(session TEXT NOT NULL,turn INTEGER NOT NULL,seq INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(session,turn));
    CREATE TABLE IF NOT EXISTS owner_operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,payload TEXT,ticket TEXT);
    CREATE TABLE IF NOT EXISTS owner_intents(source TEXT PRIMARY KEY,operation TEXT NOT NULL,method TEXT NOT NULL,target INTEGER NOT NULL,revision INTEGER NOT NULL,text TEXT);
    CREATE TABLE IF NOT EXISTS owner_file_native_erasures (operation TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_host_effects(id TEXT PRIMARY KEY,payload TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);
  `)
  const epoch = randomUUID()
  let state: 'recovering' | 'ready' | 'unavailable' = 'recovering'
  let closed = false
  let replayingWrites = false
  const generalQuestions = new Map<string, { session: string, cards: readonly { id: string, question: string }[], check(): boolean }>()
  const dispatch = createMemoryDispatch(store, (items, at) => runtime.dependenciesCurrent(items, at),
    (id, at) => runtime.dispatchSourceCurrent(id, at), (items, sources, at) => runtime.dispatchDeadline(items, sources, at), (files, _, sources) => runtime.fileDependenciesCurrent(files, sources))
  const runtime = createMemoryRuntime({ store, compute: options.compute, route: options.route,
    dailyNotes: options.dailyNotes ?? true, fileMode: options.fileMode ?? false,
    // P2 captures completed daily turns while retaining the existing fact engine until the planned switch.
    automaticFactProcessing: 'source',
    ...(options.embedding ? { embedder: createMemoryEmbedder(options.embedding), maintainSemanticIndex: true } : {}),
    profilesEnabled: true, profileBusy: () => state !== 'ready' || Boolean(db.prepare('SELECT 1 FROM owner_active_turns LIMIT 1').get()),
    quiesce: options.quiesce, changed: change => { options.onChange?.(change) },
    projectionChanged: () => options.onProjectionChanged?.(),
    injected: (session, turn, pushed) => options.onContextUsed?.({ session, turn, pushed, revision: store.revision(),
      conversation: sessionContext(session).conversation ?? null, at: Date.now() }),
    validateDispatch: dispatch.validateCommit, dependencies: dispatch.record, provisionalRead: dispatch.recordTurnOnly,
    runDocumentMutation: work => fence.mutate(work),
    fileDependencies: dispatch.recordFiles,
    canCommit: source => state === 'ready' && (!source.session || !db.prepare('SELECT 1 FROM owner_active_turns WHERE session=?').get(source.session)),
  })
  const removedSession = (session: string) => Boolean(db.prepare(`SELECT 1 FROM owner_occurrences o WHERE o.session=? AND o.removed=1
    AND NOT EXISTS(SELECT 1 FROM owner_context_retired r WHERE r.session=o.session AND r.message=o.message) LIMIT 1`).get(session))
  const coordinated = { ...runtime,
    staleSession: (session: string | null | undefined) => runtime.staleSession(session) || Boolean(session && removedSession(session)),
    allowedHistory(row: MemoryHistoryOccurrence) {
      // Browsable history without original-source or generated-session provenance
      // cannot be replayed as model context.
      if (row.role === 'user' ? !row.sourceId : !row.sessionId) return false
      if (row.sourceId) {
        const message = db.prepare('SELECT id FROM owner_messages WHERE source=?').get(row.sourceId)
        if (message && contextRecovery.retiredDerived(String(message.id))) return false
        if (row.role === 'user' && !runtime.canRecoverOriginal(row.sourceId, sessionContext(row.sessionId ?? store.readSource(row.sourceId)?.session ?? ''))) return false
      }
      if (row.sessionId && contextRecovery.contextGeneration(row.sessionId) > 0) {
        // Viva's segmentId identifies a timeline conversation, not a native message.
        // Generated UI history has no durable generation/message mapping and therefore
        // stays browseable only; it cannot re-enter auxiliary models after recovery.
        if (row.role !== 'user') return false
        if (row.sourceId && !db.prepare(`SELECT 1 FROM owner_occurrences o WHERE o.session=? AND o.source=? AND o.admitted=1 AND o.removed=0
          AND NOT EXISTS(SELECT 1 FROM owner_context_retired r WHERE r.session=o.session AND r.message=o.message)`).get(row.sessionId, row.sourceId)) return false
      }
      return runtime.allowedHistory(row)
    },
  }
  const coordination = createMemoryCoordination({ runtime: () => coordinated, dispatch: () => dispatch })
  function sessionContext(session: string) {
    const saved = db.prepare('SELECT * FROM owner_sessions WHERE session=?').get(session) as Session | undefined
    const project = saved?.project ?? runtime.sessionProject(session)
    const turn = db.prepare('SELECT turn FROM owner_active_turns WHERE session=?').get(session)?.turn as string | undefined
    return { conversation: saved?.conversation ?? session, session, ...(turn ? { foregroundTurn: turn } : {}),
      ...(saved?.context ? { context: JSON.parse(saved.context) as MemoryScope } : {}),
      ...(project ? { project: { kind: 'project' as const, id: project } } : {}) }
  }
  const hasPending = () => Boolean(db.prepare("SELECT 1 FROM owner_operations WHERE state IN ('intent','preparing','prepared','host-committed') LIMIT 1").get())
  const fence = createMemorySendFence({ epoch, admit(origin) {
    if (state !== 'ready' || replayingWrites || hasPending()) return null
    if ('jobId' in origin) return runtime.computeAdmission(origin.jobId)
    const session = origin.session, project = sessionContext(session).project
    if (contextRecovery.pending(session) || (origin.contextGeneration ?? 0) !== contextRecovery.contextGeneration(session)) return null
    const admission = dispatch.admission(session)
    if (!admission.allowed || !coordination.allowsSession(session, project)) return null
    const deadline = runtime.provisionalDeadline(session, Date.now())
    return { current: () => state === 'ready' && !hasPending() && !contextRecovery.pending(session)
      && (origin.contextGeneration ?? 0) === contextRecovery.contextGeneration(session) && coordination.allowsSession(session, project),
      deadline: deadline === undefined ? admission.deadline : Math.min(deadline, admission.deadline ?? Infinity) }
  } })
  function requireReady() { if (state !== 'ready' || hasPending()) throw new Error('Memory owner is recovering') }
  const contextRecovery = createOwnerContextRecovery({ db, store, hash, requireReady, mutate: work => fence.mutate(work),
    sourceAllowed: (session, source) => runtime.canRecoverOriginal(source, sessionContext(session)),
    replace: dispatch.replaceAfterRecovery,
    committed(session) {
      runtime.finishTurn(session)
      for (const [key, question] of generalQuestions) if (question.session === session) generalQuestions.delete(key)
    },
  })
  function needsContextRecovery(session: string, visited = new Set<string>()): boolean {
    if (visited.has(session)) return true
    visited.add(session)
    if (contextRecovery.pending(session) || removedSession(session)) return true
    // New native sessions have no old model context to recover, even after a global memory epoch change.
    if (!db.prepare('SELECT 1 FROM owner_sessions WHERE session=?').get(session)) return false
    if (runtime.staleSession(session) || dispatch.stale(session) || !runtime.provisionalReadsCurrent(session)) return true
    for (const row of db.prepare(`SELECT p.session FROM owner_session_parents p WHERE p.parent=?
      AND NOT EXISTS(SELECT 1 FROM owner_context_retired_children r WHERE r.parent=p.parent AND r.child=p.session)`).all(session)) {
      const child = String(row.session)
      if (needsContextRecovery(child, visited) || !dispatch.transferable(dispatch.snapshot(child))
        || !coordination.allowsEvidence(dispatch.snapshot(child), sessionContext(session).project)) return true
    }
    visited.delete(session)
    return false
  }
  function requireContextGeneration(session: string, generation?: number) {
    if ((generation ?? 0) !== contextRecovery.contextGeneration(session)) throw new Error('Memory context generation changed')
  }

  const operation = (id: string) => db.prepare('SELECT * FROM owner_operations WHERE id=?').get(id) as Operation | undefined
  const outcome = (item: Operation): MemoryOperationOutcome => ({ operationId: item.id, state: item.state,
    revision: store.revision(), sendFence: ['prepared', 'host-committed', 'completed'].includes(item.state) ? 'complete' : 'pending',
    cleanup: item.state === 'completed' && runtime.cleanupPending() === 0
      && !db.prepare('SELECT 1 FROM owner_host_effects WHERE id=? AND acked=0').get(item.id)
      && !db.prepare('SELECT 1 FROM owner_file_native_erasures WHERE operation=?').get(item.id) ? 'complete' : 'pending' })
  /** Reconcile durable child reads even if a crash preceded the live settlement callback.
   * Conservatively retaining unfinished-child reads also covers persisted foreground tool results. */
  function reconcileChildren(session: string, visited = new Set<string>()) {
    if (visited.has(session)) throw new Error('Session parent cycle')
    visited.add(session)
    for (const row of db.prepare('SELECT session FROM owner_session_parents WHERE parent=?').all(session)) {
      const child = String(row.session)
      if (db.prepare('SELECT 1 FROM owner_context_retired_children WHERE parent=? AND child=?').get(session, child)) continue
      reconcileChildren(child, visited)
      const evidence = dispatch.snapshot(child)
      if (!coordination.allowsSession(child, sessionContext(child).project) || !dispatch.transferable(evidence)
        || !coordination.allowsEvidence(evidence, sessionContext(session).project)) throw new Error('Child memory context is unavailable')
      dispatch.attach(session, evidence)
    }
    visited.delete(session)
  }
  /** Native session metadata binds workspace identity before original or derived replay. */
  function initializeSession(input: { sessionId: string, cwd?: string, parentSessionId?: string }) {
    requireReady()
    if (input.cwd === undefined && input.parentSessionId === undefined) { if (!needsContextRecovery(input.sessionId)) reconcileChildren(input.sessionId); return }
    const project = input.cwd === undefined ? sessionContext(input.sessionId).project : memoryProjectScope(input.cwd)
    const saved = db.prepare('SELECT project FROM owner_sessions WHERE session=?').get(input.sessionId)
    if (saved && saved.project !== (project?.id ?? null)) throw new Error('Session project context changed')
    const parent = db.prepare('SELECT parent FROM owner_session_parents WHERE session=?').get(input.sessionId)?.parent
    const ancestors = new Set([input.sessionId])
    for (let ancestor = input.parentSessionId; ancestor;) {
      if (ancestors.has(ancestor)) throw new Error('Session parent cycle')
      ancestors.add(ancestor)
      ancestor = db.prepare('SELECT parent FROM owner_session_parents WHERE session=?').get(ancestor)?.parent as string | undefined
    }
    if (parent && parent !== input.parentSessionId) throw new Error('Session parent context changed')
    if (input.parentSessionId && !parent && (!db.prepare('SELECT 1 FROM owner_sessions WHERE session=?').get(input.parentSessionId)
      || !coordination.canInherit(input.parentSessionId, sessionContext(input.parentSessionId).project, project, true)
      || !dispatch.transferable(dispatch.snapshot(input.parentSessionId)))) throw new Error('Parent memory context is unavailable')
    store.tx(() => {
      runtime.recordSession(input.sessionId)
      if (!coordination.bindProject(input.sessionId, project)) throw new Error('Session project changed')
      db.prepare('INSERT OR IGNORE INTO owner_sessions VALUES (?,?,NULL,?)').run(input.sessionId, input.sessionId, project?.id ?? null)
      if (input.parentSessionId && !parent) {
        dispatch.attach(input.sessionId, dispatch.snapshot(input.parentSessionId))
        db.prepare('INSERT INTO owner_session_parents VALUES (?,?)').run(input.sessionId, input.parentSessionId)
      }
    })
    if (!needsContextRecovery(input.sessionId)) reconcileChildren(input.sessionId)
  }
  function storeAlias(input: MemorySourceAlias): StoredAlias {
    const { text, wireText, ...metadata } = input
    const textStart = (wireText ?? text).indexOf(text)
    if (textStart < 0) throw new Error('Source alias does not identify a verbatim wire span')
    return { ...metadata, textHash: hash(text), textLength: text.length, textStart }
  }
  function restoreAlias(saved: StoredAlias, wireText: string): MemorySourceAlias {
    const { textHash, textLength, textStart, ...metadata } = saved
    const text = wireText.slice(textStart, textStart + textLength)
    if (hash(text) !== textHash) throw new Error('Source alias wire span changed')
    return { ...metadata, text, wireText }
  }
  function alias(input: MemorySourceAlias) {
    requireReady()
    const saved = storeAlias(input) // Validate before any session/source registration.
    const fingerprint = hash(input)
    const old = db.prepare('SELECT fingerprint,revoked FROM owner_aliases WHERE id=?').get(input.operationId)
    const source = store.readSource(input.sourceId)
    if (store.sourceExcluded(input.sourceId) || source?.erasure || old?.revoked
      || source && input.origin !== 'derived' && !runtime.dispatchSourceCurrent(input.sourceId)) {
      throw new Error('Source alias was withdrawn or is unavailable')
    }
    if (old && old.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict', 'Memory operation ID conflicts')
    const context = input.context ? JSON.stringify(input.context) : null
    const previous = db.prepare('SELECT * FROM owner_sessions WHERE session=?').get(input.session) as Session | undefined
    if (previous && previous.project !== (input.project?.id ?? null)) throw new Error('Session project context changed')
    store.tx(() => {
      db.prepare('INSERT OR IGNORE INTO owner_aliases(id,fingerprint,session,wire_hash,payload,source,conversation) VALUES (?,?,?,?,?,?,?)').run(input.operationId, fingerprint, input.session, hash(input.wireText ?? input.text), JSON.stringify(saved), input.sourceId, input.conversation)
      db.prepare('INSERT OR IGNORE INTO owner_sessions VALUES (?,?,?,?)').run(input.session, input.conversation, context, input.project?.id ?? null)
      db.prepare('UPDATE owner_sessions SET conversation=?,context=?,project=? WHERE session=?').run(input.conversation, context, input.project?.id ?? null, input.session)
      runtime.recordSession(input.session)
      if (!coordination.bindProject(input.session, input.project)) throw new Error('Session project changed')
      if (input.dependencies && !coordination.transfer(input.session, input.dependencies, input.project, true)) throw new Error('Stale alias dependencies')
    })
    return { sourceId: input.sourceId }
  }
  function markLiveTurn(input: ReceivedSource) {
    if (input.turn > 0 && !input.inherited && input.live !== false) db.prepare('INSERT INTO owner_active_turns VALUES (?,?) ON CONFLICT(session) DO UPDATE SET turn=excluded.turn').run(input.sessionId, String(input.turn))
  }
  async function receiveSource(input: ReceivedSource) {
    requireReady()
    requireContextGeneration(input.sessionId, input.contextGeneration)
    if (contextRecovery.retired(input.sessionId, input.messageId)) throw new Error('Source context was retired')
    if (input.contentDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.contentDigest)) throw new Error('Invalid original content digest')
    const contentIdentity = db.prepare('SELECT digest FROM owner_message_content WHERE message=?').get(input.messageId)
    if (contentIdentity && contentIdentity.digest !== hash(input.contentDigest)) throw new Error('Original content identity conflicts')

    const known = db.prepare('SELECT * FROM owner_messages WHERE id=?').get(input.messageId) as { source: string, hash: string, kind: string, query_start: number | null, query_end: number | null } | undefined
    if (known?.kind === 'host-derived' && known.hash === hash(input.text)) {
      await registerDerived({ sessionId: input.sessionId, messageId: input.messageId, contextGeneration: input.contextGeneration, contentDigest: input.contentDigest, sourceIds: [], inherited: input.inherited })
      markLiveTurn(input)
      return { sourceId: known.source, text: '', handledIntent: true,
        retrievalQuery: known.query_start === null || known.query_end === null ? '' : input.text.slice(known.query_start, known.query_end) }
    }
    if (!known && input.derived) {
      if (input.inherited) throw new Error('Unregistered inherited source')
      await registerDerived({ sessionId: input.sessionId, messageId: input.messageId, contextGeneration: input.contextGeneration, contentDigest: input.contentDigest, sourceIds: [] })
      db.prepare("UPDATE owner_messages SET kind='host-derived',hash=?,query_start=0,query_end=? WHERE id=?").run(hash(input.text), input.text.length, input.messageId)
      markLiveTurn(input)
      const sourceId = db.prepare('SELECT source FROM owner_messages WHERE id=?').get(input.messageId)!.source as string
      return { sourceId, text: '', handledIntent: true, retrievalQuery: input.text }
    }
    if (known && (known.hash !== hash(input.text) || known.kind !== 'original')) throw new Error('Source identity conflicts')
    if (!known && input.inherited) throw new Error('Unregistered inherited source')
    if (db.prepare('SELECT 1 FROM owner_aliases WHERE session=? AND wire_hash=? AND revoked=1').get(input.sessionId, hash(input.text))) throw new Error('Source delivery was withdrawn')
    const candidates = db.prepare('SELECT id,payload FROM owner_aliases WHERE session=? AND wire_hash=? AND payload IS NOT NULL').all(input.sessionId, hash(input.text)) as Array<{ id: string, payload: string }>
    if (!known && candidates.length > 1) throw new Error('Ambiguous source alias')
    const mapped = !known && candidates[0] ? restoreAlias(JSON.parse(candidates[0].payload) as StoredAlias, input.text) : undefined
    if (mapped?.origin === 'derived') {
      const start = input.text.indexOf(mapped.text)
      if (start < 0) throw new Error('Derived source alias does not identify its wire text')
      const sources = mapped.dependencies?.sources ?? []
      await registerDerived({ sessionId: input.sessionId, messageId: input.messageId, contextGeneration: input.contextGeneration, contentDigest: input.contentDigest, sourceIds: sources })
      db.prepare('UPDATE owner_aliases SET payload=NULL WHERE id=?').run(mapped.operationId)
      db.prepare("UPDATE owner_messages SET kind='host-derived',hash=?,query_start=?,query_end=? WHERE id=?").run(hash(input.text), start, start + mapped.text.length, input.messageId)
      const canonical = db.prepare('SELECT source FROM owner_messages WHERE id=?').get(input.messageId)!.source as string
      markLiveTurn(input)
      return { sourceId: canonical, text: '', handledIntent: true, retrievalQuery: mapped.text }
    }
    const sourceId = known?.source ?? mapped?.sourceId ?? input.messageId
    if (store.sourceExcluded(sourceId)) throw new Error('Source was withdrawn')
    if ((known || store.readSource(sourceId)) && !runtime.dispatchSourceCurrent(sourceId)) throw new Error('Source is withdrawn or unavailable')
    const text = mapped?.text ?? (known ? store.readSource(sourceId)?.text ?? '' : input.text)
    let context = mapped ? { ...sessionContext(input.sessionId), conversation: mapped.conversation, context: mapped.context, project: mapped.project } : sessionContext(input.sessionId)
    if (!db.prepare('SELECT 1 FROM owner_sessions WHERE session=?').get(input.sessionId)) {
      db.prepare('INSERT INTO owner_sessions VALUES (?,?,NULL,?)').run(input.sessionId, input.sessionId, input.project ?? null)
      context = sessionContext(input.sessionId)
      runtime.recordSession(input.sessionId)
      coordination.bindProject(input.sessionId, context.project)
    }
    store.tx(() => {
      markLiveTurn(input)
      if (!known) {
        const canonical = store.readSource(sourceId)
        if (canonical) {
          if (!mapped || canonical.hash !== memoryHash(text) || !runtime.sourceCurrent(sourceId)
            || !runtime.projectAllows({ dependencies: [], sources: [sourceId] }, context.project)) throw new Error('Invalid replay alias')
        } else {
          runtime.recordDeliveredSource(sourceId, context.conversation)
          if (text.trim()) runtime.accept(text, context, sourceId, undefined, { deferAutomatic: true, at: input.at, timezone: input.timezone })
        }
      }
      db.prepare("INSERT OR IGNORE INTO owner_messages(id,source,hash,kind) VALUES (?,?,?,'original')").run(input.messageId, sourceId, hash(input.text))
      if (input.contentDigest && !known) db.prepare('INSERT INTO owner_message_content VALUES (?,?)').run(input.messageId, hash(input.contentDigest))
      db.prepare('INSERT INTO owner_occurrences(session,message,source,conversation,admitted) VALUES (?,?,?,?,?) ON CONFLICT(session,message) DO UPDATE SET admitted=MAX(admitted,excluded.admitted)').run(input.sessionId, input.messageId, sourceId, context.conversation, Number(input.admitted))
      if (mapped) db.prepare('UPDATE owner_aliases SET payload=NULL WHERE id=?').run(mapped.operationId)
      if (input.admitted) { runtime.bindSource(sourceId, input.sessionId); dispatch.recordSource(input.sessionId, sourceId) }
    })
    if (!runtime.dispatchSourceCurrent(sourceId)) throw new Error('Source is withdrawn or unavailable')
    // A rejected original remains withdrawable as a delivery, but cannot authorize a memory write.
    if (store.readSource(sourceId)?.outcome === 'rejected') return { sourceId, text: '' }
    if (input.admitted) {
      let intent = db.prepare('SELECT * FROM owner_intents WHERE source=?').get(sourceId) as { operation: string, method: string, target: number, revision: number, text: string | null } | undefined
      if (!intent) {
        const forgotten = runtime.forgetIntent(text, context.context, context.project)
        const corrected = runtime.correctionIntent(text, context.context, context.project)
        if (forgotten || corrected) {
          const target = forgotten || corrected && corrected.entry
          if (target) {
            db.prepare('INSERT INTO owner_intents VALUES (?,?,?,?,?,?)').run(sourceId, randomUUID(), forgotten ? 'stopMemory' : 'editMemory', target.id, target.revision, corrected ? corrected.text : null)
            intent = db.prepare('SELECT * FROM owner_intents WHERE source=?').get(sourceId) as typeof intent
          }
        }
      }
      if (intent) {
        const done = operation(intent.operation)?.state === 'completed'
        if (!done && options.canPresentControlReceipt?.() === false) throw new Error('This adapter cannot present a local memory operation receipt')
        if (!done) await handleHost(intent.method, { args: intent.method === 'stopMemory'
          ? [intent.target, intent.revision, intent.operation] : [intent.target, intent.text, intent.revision, intent.operation] })
        db.prepare('UPDATE owner_intents SET text=NULL WHERE source=?').run(sourceId)
        store.outcome(sourceId, 'intent-handled')
        return { sourceId, text, handledIntent: true, controlReceipt: { operationId: intent.operation, kind: intent.method === 'stopMemory' ? 'stop' as const : 'correct' as const, targetId: intent.target } }
      }
    }
    return { sourceId, text: store.readSource(sourceId)?.text ?? text }
  }
  async function registerDerived(input: DerivedSource) {
    requireReady()
    requireContextGeneration(input.sessionId, input.contextGeneration)
    if (contextRecovery.retired(input.sessionId, input.messageId) || contextRecovery.retiredDerived(input.messageId)) throw new Error('Derived context was retired')
    const old = db.prepare('SELECT kind,hash,source FROM owner_messages WHERE id=?').get(input.messageId)
    if (old && old.kind !== 'derived' && old.kind !== 'host-derived') throw new Error('Derived identity conflicts')
    if (!old && input.inherited) throw new Error('Unregistered inherited derived context')
    const saved = db.prepare('SELECT * FROM owner_derived WHERE message=?').get(input.messageId)
    if (!saved && input.senderSessionId) {
      requireContextGeneration(input.senderSessionId, input.senderContextGeneration)
      // Generation numbers alone do not prove when a queued cross-session delivery was
      // produced. After either side has recovered, only the native adapter's captured
      // causal receipt may authorize a new delivery; saved receipts keep their old proof.
      if ((contextRecovery.contextGeneration(input.sessionId) > 0 || contextRecovery.contextGeneration(input.senderSessionId) > 0)
        && input.verifiedDelivery !== true) throw new Error('Unverified delivery receipt across a recovered context')
    }
    if (input.contentDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.contentDigest)) throw new Error('Invalid derived content digest')
    const contentIdentity = db.prepare('SELECT digest FROM owner_message_content WHERE message=?').get(input.messageId)
    if (contentIdentity && contentIdentity.digest !== hash(input.contentDigest)) throw new Error('Derived content identity conflicts')
    let observed = dispatch.snapshot(input.sessionId)
    if (!saved && input.senderSessionId) {
      const sender = input.senderSessionId
      const evidence = dispatch.snapshot(sender)
      if (!db.prepare('SELECT 1 FROM owner_sessions WHERE session=?').get(sender)
        || !coordination.allowsSession(sender, sessionContext(sender).project) || !dispatch.transferable(evidence)) throw new Error('Sender memory context is unavailable')
      observed = combineMemoryProvenance(observed, evidence)
    }
    const evidence = saved ? JSON.parse(saved.evidence as string) as typeof observed
      : { ...observed, sources: [...new Set([...observed.sources, ...input.sourceIds])] }
    const active = sessionContext(input.sessionId).foregroundTurn
    const sameLiveTurn = Boolean(active && !input.inherited && (!saved || saved.owner_epoch === epoch
      && saved.origin_session === input.sessionId && saved.origin_turn === active))
    const valid = evidence.turnOnly ? sameLiveTurn && runtime.provisionalReadsCurrent(input.sessionId) && !dispatch.stale(input.sessionId)
      : dispatch.transferable(evidence)
    if (!coordination.allowsEvidence(evidence, sessionContext(input.sessionId).project) || !valid) throw new Error('Derived dependencies unavailable')
    const canonical = typeof old?.source === 'string' ? old.source : randomUUID()
    store.tx(() => {
      db.prepare("INSERT OR IGNORE INTO owner_messages(id,source,hash,kind) VALUES (?,?,?,'derived')").run(input.messageId, canonical, hash(evidence))
      db.prepare('INSERT OR IGNORE INTO owner_derived VALUES (?,?,?,?,?)').run(input.messageId, JSON.stringify(evidence), input.sessionId, active ?? null, epoch)
      dispatch.attach(input.sessionId, evidence)
      db.prepare('INSERT OR IGNORE INTO owner_derived_occurrences VALUES (?,?)').run(input.sessionId, input.messageId)
      if (!saved && input.contentDigest) db.prepare('INSERT INTO owner_message_content VALUES (?,?)').run(input.messageId, hash(input.contentDigest))
      if (!old) runtime.recordDeliveredSource(canonical, sessionContext(input.sessionId).conversation, true)
    })
  }
  async function completeTurn(input: CompletedTurn) {
    requireReady()
    requireContextGeneration(input.sessionId, input.contextGeneration)
    const answers = db.prepare('SELECT source FROM owner_answer_sources WHERE session=? AND turn=?').all(input.sessionId, String(input.turn)) as Array<{source: string}>
    input = { ...input, sourceIds: [...new Set([...input.sourceIds, ...answers.map(row => row.source)])] }
    const receipt = db.prepare('SELECT state FROM owner_turns WHERE session=? AND turn=?').get(input.sessionId, input.turn)
    if (receipt) {
      db.prepare('DELETE FROM owner_active_turns WHERE session=? AND turn=?').run(input.sessionId, String(input.turn))
      return
    }
    store.tx(() => {
      if (input.completed) {
        for (const id of input.sourceIds) {
          const occurrence = db.prepare('SELECT 1 FROM owner_occurrences WHERE session=? AND source=? AND admitted=1 AND removed=0').get(input.sessionId, id)
          const source = store.readSource(id)
          if (occurrence && (!source || source.outcome === 'rejected') && runtime.dispatchSourceCurrent(id)) continue
          if (!occurrence || !source || !runtime.sourceCurrent(id)) throw new Error('Turn source is unavailable')
          if (source.outcome === 'received' && source.text) runtime.accept(source.text, { conversation: source.conversation, session: source.session,
            context: source.context ?? undefined, scope: source.scope, ...(source.project?.kind === 'project' ? { project: { kind: 'project' as const, id: source.project.id } } : {}) }, source.id, source.author === 'answer' && source.question && source.requestId && source.questionId
              ? { question: source.question, requestId: source.requestId, questionId: source.questionId, custom: true } : undefined)
        }
      }
    })
    // File journal has its own crash receipt and must not be nested inside a SQLite transaction.
    if (input.completed) runtime.recordNoteTurn?.(input.sessionId, input.sourceIds, input.assistant)
    db.prepare('INSERT INTO owner_turns VALUES (?,?,?,?)').run(input.sessionId, input.turn, input.eventSeq, input.completed ? 'completed' : 'cancelled')
    for (const [key, question] of generalQuestions) if (question.session === input.sessionId) generalQuestions.delete(key)
    db.prepare('DELETE FROM owner_active_turns WHERE session=? AND turn=?').run(input.sessionId, String(input.turn))
    runtime.finishTurn(input.sessionId, input.completed)
    dispatch.endTurn(input.sessionId)
  }
  async function prepare(input: SourceChangeInput) {
    const fingerprint = hash(input), existing = operation(input.operationId)
    if (existing && existing.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict', 'Memory operation ID conflicts')
    if (!existing) db.prepare("INSERT INTO owner_operations VALUES (?,?,'intent',?,?)").run(input.operationId, fingerprint, JSON.stringify(input), randomUUID())
    const item = operation(input.operationId)!
    if (!['intent', 'preparing'].includes(item.state)) return { ticket: item.ticket!, operation: outcome(item) }
    // Persist intent before denying reads or aborting a physical request. Recovery reinstates this hold.
    db.prepare("UPDATE owner_operations SET state='preparing' WHERE id=?").run(item.id)
    runtime.holdWithdrawal(input.conversation, input.onlySources ? input.ids : undefined)
    await fence.mutate(async () => { await options.quiesce(); db.prepare("UPDATE owner_operations SET state='prepared' WHERE id=?").run(item.id) })
    return { ticket: item.ticket!, operation: outcome(operation(item.id)!) }
  }
  async function commit(input: { operationId: string, ticket: string }) {
    const item = operation(input.operationId)
    if (!item || item.ticket !== input.ticket || !['prepared', 'host-committed', 'completed'].includes(item.state)) throw new Error('Source change was not prepared')
    if (item.state === 'completed') return outcome(item)
    const change = JSON.parse(item.payload!) as SourceChangeInput
    db.prepare("UPDATE owner_operations SET state='host-committed' WHERE id=?").run(item.id)
    await fence.mutate(() => {
      store.tx(() => {
        for (const id of change.ids) db.prepare('UPDATE owner_occurrences SET removed=1 WHERE conversation=? AND source=?').run(change.conversation, id)
        if (change.onlySources) {
          for (const id of change.ids) db.prepare('UPDATE owner_aliases SET payload=NULL,revoked=1 WHERE conversation=? AND source=?').run(change.conversation, id)
        } else db.prepare('UPDATE owner_aliases SET payload=NULL,revoked=1 WHERE conversation=?').run(change.conversation)
        const removed = change.ids.filter(id => !db.prepare('SELECT 1 FROM owner_occurrences WHERE source=? AND removed=0 LIMIT 1').get(id))
        runtime.withdraw({ conversation: change.conversation, ids: removed, onlySources: true })
        for (const id of removed) {
          store.excludeSource(id)
          db.prepare('UPDATE owner_intents SET text=NULL WHERE source=?').run(id)
        }
        db.prepare("UPDATE owner_operations SET state='completed',payload=NULL WHERE id=?").run(item.id)
      })
      runtime.releaseWithdrawal(change.conversation, change.onlySources ? change.ids : undefined)
    })
    if (state === 'ready' && !hasPending()) await replayWrites()
    return outcome(operation(item.id)!)
  }
  async function recover() {
    if (closed) throw new Error('Memory owner is closed')
    db.prepare('DELETE FROM owner_active_turns').run()
    for (const item of db.prepare("SELECT * FROM owner_operations WHERE state IN ('intent','preparing','prepared','host-committed')").all() as Operation[]) {
      const input = JSON.parse(item.payload!) as SourceChangeInput
      runtime.holdWithdrawal(input.conversation, input.onlySources ? input.ids : undefined)
      if (item.state === 'host-committed') await commit({ operationId: item.id, ticket: item.ticket! })
      else if (item.state !== 'prepared') await prepare(input)
    }
    state = 'ready'
    if (!hasPending()) await replayWrites()
    void runtime.wake()
  }
  async function replayWrites() {
    if (replayingWrites) return
    replayingWrites = true
    try {
      for (const item of db.prepare("SELECT * FROM owner_operations WHERE state='running'").all() as Operation[]) {
        const { command } = JSON.parse(item.payload!) as Pick<WritePayload | FileWritePayload, 'command'>
        try { await handleHost(command.method, command.input) }
        catch (error) { if (operation(item.id)?.state !== 'failed') throw error }
      }
    } finally { replayingWrites = false }
  }
  const pendingHostEffects = () => (db.prepare(`SELECT payload FROM owner_host_effects WHERE acked=0
    ORDER BY json_extract(payload,'$.revision'),rowid`).all() as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as MemoryHostEffect)
  type WritePayload = { command: HostMemoryCommand, sources: string[], sessions: string[] }
  async function durableWrite(command: HostMemoryCommand, id: string, operationIndex: number, targets: number[], work: () => unknown | Promise<unknown>) {
    if (!('args' in command.input)) throw new Error('Invalid write command')
    const args = [...command.input.args]; args[operationIndex] = id
    command = parseHostMemoryCommand(command.method, { args })
    const previous = operation(id)
    const fingerprint = hash(command)
    if (previous && previous.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict', 'Memory operation ID conflicts')
    if (previous?.state === 'failed') throw new Error('Memory operation previously failed')
    const sources = previous?.payload ? (JSON.parse(previous.payload) as WritePayload).sources
      : [...new Set(targets.flatMap(target => store.get(target)?.evidence.map(edge => edge.sourceId) ?? []))]
    const sessions = previous?.payload ? (JSON.parse(previous.payload) as WritePayload).sessions :
      (db.prepare('SELECT id FROM memory_sessions').all() as Array<{id: string}>).flatMap(({id: session}) => {
        const evidence = dispatch.snapshot(session)
        return evidence.sources.some(source => sources.includes(source)) || evidence.dependencies.some(ref => targets.includes(ref.id)) ? [session] : []
      })
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?,NULL)").run(id, fingerprint, JSON.stringify({ command, sources, sessions }))
    return fence.mutate(async () => {
      let result: unknown
      try { result = await work() }
      catch (error) {
        if (error instanceof MemoryDomainError && error.code !== 'change.pending') {
          db.prepare("UPDATE owner_operations SET state='failed',payload=NULL WHERE id=?").run(id)
        }
        throw error
      }
      store.tx(() => {
        // The core's command receipt makes retry after a crash safe. Keep the host effect in the same
        // transaction as this completion receipt, including copies captured before core erasure.
        if (options.hostNamespace && sources.length) {
          const effect: MemoryHostEffect = { effectId: id, causeOperationId: id, revision: store.revision(), hostNamespace: options.hostNamespace,
            kind: command.method === 'deleteMemory' ? 'erase-copies' : 'invalidate-context', sessions, memoryIds: targets,
            sources: sources.map(sourceId => ({ namespace: 'memory', sourceId, revision: store.revision() })) }
          db.prepare('INSERT OR IGNORE INTO owner_host_effects(id,payload) VALUES (?,?)').run(id, JSON.stringify(effect))
        }
        if (command.method === 'deleteMemory') {
          for (const source of sources) {
            db.prepare("UPDATE owner_aliases SET payload=NULL,revoked=1 WHERE source=?").run(source)
            db.prepare('UPDATE owner_intents SET text=NULL WHERE source=?').run(source)
          }
        }
        db.prepare("UPDATE owner_operations SET state='completed',payload=NULL WHERE id=?").run(id)
      })
      options.onHostEffects?.()
      return result
    })
  }
  type FileWriteCommand = Extract<HostMemoryCommand, { method: 'setFileEnabled' | 'undoFile' | 'forgetFile' }>
  type FileWritePayload = { command: FileWriteCommand, sources: MemorySourceReference[], sessions: string[] }
  function fileSessions(identity: MemoryManagedFileIdentity, sources: readonly MemorySourceReference[]): string[] {
    const sourceIds = new Set(sources.map(ref => ref.sourceId))
    return (db.prepare('SELECT id FROM memory_sessions').all() as Array<{ id: string }>).flatMap(({ id }) => {
      const evidence = dispatch.snapshot(id)
      return evidence.sources.some(source => sourceIds.has(source))
        || evidence.files?.some(file => file.workspace === identity.workspace && file.id === identity.id) ? [id] : []
    })
  }
  /** The runtime owns the only send fence. The durable intent bridges its document receipt and
   * this completion/outbox transaction if the process exits between the two commits. */
  async function durableFileWrite(command: FileWriteCommand): Promise<MemoryFileMutationResult> {
    requireReady()
    const request = command.input.args[0], id = request.operationId, fingerprint = hash(command)
    const previous = operation(id)
    if (previous && previous.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
    if (previous?.state === 'completed') return (JSON.parse(previous.payload!) as { result: MemoryFileMutationResult }).result
    if (previous?.state === 'failed') {
      const failure = JSON.parse(previous.payload!) as { code: MemoryDomainErrorCode }
      throw new MemoryDomainError(failure.code)
    }
    const pending = previous?.payload ? JSON.parse(previous.payload) as FileWritePayload : null
    const sources = pending?.sources ?? (command.method === 'forgetFile' || request.identity.kind === 'daily' ? [] : runtime.readFile(request.identity)?.sources ?? [])
    const sessions = pending?.sessions ?? (command.method === 'forgetFile' ? [] : fileSessions(request.identity, sources))
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?,NULL)").run(id, fingerprint, JSON.stringify({ command, sources, sessions } satisfies FileWritePayload))
    let notify = false
    const committed = (result: MemoryFileMutationResult, affectedSources: readonly MemorySourceReference[] = sources) => {
      store.tx(() => {
        if (operation(id)?.state === 'completed') return
        // Include readers attached while the mutation waited for outstanding physical sends.
        const affectedSessions = [...new Set([...sessions, ...fileSessions(request.identity, affectedSources)])]
        if (options.hostNamespace && result.usageVersion !== request.version.usageVersion && (affectedSources.length || affectedSessions.length)) {
          const effect: MemoryHostEffect = { effectId: id, causeOperationId: id, revision: store.revision(), hostNamespace: options.hostNamespace,
            kind: 'invalidate-context', sources: [...affectedSources], sessions: affectedSessions }
          db.prepare('INSERT OR IGNORE INTO owner_host_effects(id,payload) VALUES (?,?)').run(id, JSON.stringify(effect))
          notify = true
        }
        // Retain only the public immutable receipt; no Markdown, previous body or source copies.
        db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result }), id)
      })
    }
    try {
      const result = command.method === 'setFileEnabled'
        ? await runtime.setFileEnabled(command.input.args[0], committed)
        : command.method === 'undoFile' ? await runtime.undoFile(command.input.args[0], committed)
          : await runtime.forgetFile(command.input.args[0], (result, cuts) => {
            const sourceIds = new Set(cuts.map(cut => cut.id))
            const invalidated = (db.prepare('SELECT id FROM memory_sessions').all() as Array<{ id: string }>).flatMap(({ id: session }) => {
              const evidence = dispatch.snapshot(session)
              const relevant = evidence.sources.some(source => sourceIds.has(source))
                || evidence.files?.some(file => file.workspace === result.identity.workspace)
              return relevant && (evidence.sources.some(source => sourceIds.has(source) && !evidence.fileSources?.includes(source))
                || !runtime.fileDependenciesCurrent(evidence.files ?? [], evidence.fileSources)) ? [session] : []
            })
            const current = db.prepare('SELECT session FROM owner_occurrences WHERE source=?')
            let native = false
            for (const cut of cuts) {
              const occurrences = current.all(cut.id)
              native ||= occurrences.length > 0 || Boolean(store.readSource(cut.id)?.session)
              for (const row of occurrences) invalidated.push(String(row.session))
              db.prepare('UPDATE owner_aliases SET payload=NULL,revoked=1 WHERE source=?').run(cut.id)
              db.prepare('UPDATE owner_intents SET text=NULL WHERE source=?').run(cut.id)
            }
            const sessions = [...new Set(invalidated)]
            const ranges = cuts.map(({ id: sourceId, version: revision, length, hash, spans }) => {
              const afterHash = store.readSource(sourceId)?.hash
              if (!afterHash) throw new Error('Missing committed source erasure proof')
              return { sourceId, revision, length, hash, afterHash, spans }
            })
            if (native) db.prepare('INSERT INTO owner_file_native_erasures VALUES (?,?)').run(id, JSON.stringify({ sessions, ranges }))
            if (options.hostNamespace) {
              const effect: MemoryHostEffect = { effectId: id, causeOperationId: id, revision: store.revision(), hostNamespace: options.hostNamespace,
                kind: 'erase-file-copies', sessions,
                sources: cuts.map(cut => ({ namespace: 'canonical', sourceId: cut.id, revision: cut.version })), ranges }
              db.prepare('INSERT INTO owner_host_effects(id,payload) VALUES (?,?)').run(id, JSON.stringify(effect))
              notify = true
            }
            db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result }), id)
          })
      if (notify) options.onHostEffects?.()
      return result
    } catch (error) {
      if (error instanceof MemoryDomainError && error.code !== 'change.pending' && operation(id)?.state !== 'completed') {
        db.prepare("UPDATE owner_operations SET state='failed',payload=? WHERE id=?").run(JSON.stringify({ code: error.code }), id)
      }
      // Storage/flush failures keep the intent for recovery, including a committed document receipt.
      throw error
    }
  }
  async function handleHost(method: unknown, input: unknown): Promise<unknown> {
    const command = parseHostMemoryCommand(method, input)
    switch (command.method) {
      case 'prepareSourceChange': return prepare(command.input)
      case 'commitSourceChange': return commit(command.input)
      case 'getOperation': { const item = operation(command.input.operationId); return item ? outcome(item) : null }
      case 'pendingHostEffects': return pendingHostEffects()
      case 'ackHostEffect': {
        const saved = db.prepare('SELECT payload FROM owner_host_effects WHERE id=?').get(command.input.effectId)
        if (!saved) throw new Error('Unknown host effect')
        const effect = JSON.parse(saved.payload as string) as MemoryHostEffect
        if ( (effect.causeOperationId !== command.input.causeOperationId || effect.revision !== command.input.revision)) throw new Error('Host effect version conflicts')
        db.prepare('UPDATE owner_host_effects SET acked=1 WHERE id=?').run(command.input.effectId)
        return { accepted: true }
      }
      case 'sourceAlias': return alias(command.input)
      case 'bindWireAlias': {
        requireReady()
        const [session, text, wireText, sourceId] = command.input.args
        const delivery = randomUUID()
        // The entire wire is matched against this trusted receipt. Never parse/strip a marker from user text.
        const prepared = `${wireText}\n\n<memory-delivery id="${delivery}" />`
        let input: MemorySourceAlias
        if (!sourceId) {
          const context = sessionContext(session)
          input = { operationId: delivery, sourceId: delivery, session, conversation: context.conversation, text, wireText: prepared,
            context: context.context, project: context.project, origin: 'derived', dependencies: dispatch.snapshot(session) }
        } else {
          const rows = db.prepare('SELECT id,payload,delivery FROM owner_aliases WHERE session=? AND source=? AND payload IS NOT NULL AND revoked=0').all(session, sourceId) as Array<{id: string,payload: string,delivery: number}>
          const matched = rows.filter(row => (JSON.parse(row.payload) as StoredAlias).textHash === hash(text))
          const staged = matched.find(row => !row.delivery) ?? matched[0]
          if (staged) {
            const { textHash: _hash, textLength: _length, textStart: _start, ...metadata } = JSON.parse(staged.payload) as StoredAlias
            input = { ...metadata, text, operationId: delivery, wireText: prepared }
          }
          else {
            if (!runtime.replaySource(sourceId, text)) throw new Error('Original source alias is unavailable')
            const context = sessionContext(session)
            input = { operationId: delivery, sourceId, session, conversation: context.conversation, text, wireText: prepared,
              context: context.context, project: context.project }
          }
        }
        store.tx(() => {
          alias(input)
          db.prepare('UPDATE owner_aliases SET delivery=1 WHERE id=?').run(delivery)
          // Keep earlier immutable delivery receipts until they are consumed; retries never rebind them.
          if (sourceId) db.prepare('UPDATE owner_aliases SET payload=NULL WHERE session=? AND source=? AND delivery=0').run(session, sourceId)
        })
        return { wireText: prepared }
      }
    }
    requireReady()
    switch (command.method) {
      case 'acceptQuestionAnswer': {
        const input = command.input, sourceId = input.operationId
        const existing = store.readSource(sourceId)
        if (existing) {
          if (existing.erasure || existing.hash !== memoryHash(input.text) || existing.author !== 'answer' || existing.questionId !== input.questionId
            || existing.requestId !== input.requestId || existing.conversation !== input.conversation) throw new Error('Answer operation identity conflicts')
          return { sourceId }
        }
        const context = sessionContext(input.session), turn = context.foregroundTurn
        if (!turn || context.conversation !== input.conversation || context.project?.id !== input.project?.id
          || !coordination.allowsSession(input.session, context.project)) throw new Error('Answer context is unavailable')
        const clarification = runtime.clarificationQuestion(input.session, turn, input.questionId, 'check')
        const general = [...generalQuestions.values()].some(item => item.session === input.session && item.check()
          && item.cards.some(card => card.id === input.questionId && card.question === input.question))
        if (!general && (!clarification || clarification.question !== input.question)) throw new Error('Question is no longer authorized')
        store.tx(() => {
          runtime.accept(input.text, { ...context, context: input.context }, sourceId,
            { question: input.question, requestId: input.requestId, questionId: input.questionId, custom: true },
            { deferAutomatic: true, at: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          if (!runtime.sourceCurrent(sourceId)) throw new Error('Answer cannot be retained')
          db.prepare('INSERT INTO owner_answer_sources VALUES (?,?,?)').run(input.session, turn, sourceId)
          db.prepare('INSERT INTO owner_occurrences(session,message,source,conversation,admitted) VALUES (?,?,?,?,1)').run(input.session, sourceId, sourceId, input.conversation)
          dispatch.recordSource(input.session, sourceId)
        })
        return { sourceId }
      }
      case 'clarificationQuestion': { const [session, , id, phase] = command.input.args; const turn = sessionContext(session).foregroundTurn; return turn ? runtime.clarificationQuestion(session, turn, id, phase) : null }
      case 'authorizeGeneralQuestion': {
        const [session, hostTurn, cards, conversation, context, project, phase] = command.input.args
        const turn = sessionContext(session).foregroundTurn
        if (!turn) return false
        const key = hash([session, hostTurn, turn, cards, conversation, context, project])
        const prior = generalQuestions.get(key)
        if (phase === 'check') return prior?.check() ?? false
        if (prior) return prior.check()
        if (generalQuestions.size >= 128) return false
        const check = await runtime.authorizeGeneralQuestion({ session, turn, conversation, context, project }, cards)
        if (typeof check !== 'function' || closed || state !== 'ready' || !check()) return false
        generalQuestions.set(key, { session, cards, check })
        return true
      }
      case 'listMemories': return runtime.listMemories(...command.input.args)
      case 'listInvalid': return runtime.listInvalid(...command.input.args)
      case 'listChanges': return runtime.listChanges(...command.input.args)
      case 'profile': return runtime.profile(...command.input.args)
      case 'profileView': return runtime.profileView(...command.input.args)
      case 'revision': return runtime.revision(...command.input.args)
      case 'epoch': return runtime.epoch(...command.input.args)
      case 'cleanupPending': return runtime.cleanupPending(...command.input.args)
      case 'onboarding': return runtime.onboarding(...command.input.args)
      case 'sessionProject': return runtime.sessionProject(...command.input.args)
      case 'recordSessionProject': return runtime.recordSessionProject(...command.input.args)
      case 'recordSession': return runtime.recordSession(...command.input.args)
      case 'recordDeliveredSource': runtime.recordDeliveredSource(command.input.args[0], command.input.args[1], command.input.args[2]); dispatch.recordSource(command.input.args[3], command.input.args[0]); return
      case 'isDerivedDelivery': return runtime.isDerivedDelivery(...command.input.args)
      case 'forgetIntent': return runtime.forgetIntent(...command.input.args)
      case 'correctionIntent': return runtime.correctionIntent(...command.input.args)
      case 'bindProject': return coordination.bindProject(...command.input.args)
      case 'projectChanged': return coordination.projectChanged(...command.input.args)
      case 'allowsEvidence': return coordination.allowsEvidence(...command.input.args)
      case 'stale': return coordination.stale(...command.input.args)
      case 'recoverContext': throw new Error('Context recovery requires the native host adapter')
      case 'allowsSession': return coordination.allowsSession(...command.input.args)
      case 'transferable': return coordination.transferable(...command.input.args)
      case 'transferStatus': return coordination.transferStatus(...command.input.args)
      case 'transfer': return coordination.transfer(...command.input.args)
      case 'canInherit': return coordination.canInherit(...command.input.args)
      case 'inherit': return coordination.inherit(...command.input.args)
      case 'allowsProjectHistory': return coordination.allowsProjectHistory(...command.input.args)
      case 'useHistory': return coordination.useHistory(...command.input.args)
      case 'listFiles': return runtime.listFiles(command.input.args[0])
      case 'readFile': return runtime.readFile(...command.input.args)
      case 'setFileEnabled':
      case 'forgetFile':
      case 'undoFile': return durableFileWrite(command)
      case 'setOnboarding': return fence.mutate(() => runtime.setOnboarding(...command.input.args))
      case 'rebuildIndexes': return fence.mutate(() => runtime.rebuildIndexes(...command.input.args))
      case 'setProfile': { const a = command.input.args, id = a[1] ?? randomUUID(); return durableWrite(command, id, 1, [], () => runtime.setProfile(a[0], id)) }
      case 'resolveConflictPair': { const a = command.input.args, id = a[3] ?? randomUUID(); return durableWrite(command, id, 3, [a[0].id,a[1].id], () => runtime.resolveConflictPair(a[0], a[1], a[2], id, a[4], a[5])) }
      case 'undoChange': { const a = command.input.args, id = a[2] ?? randomUUID(); return durableWrite(command, id, 2, a[3].map(side => side.id), () => runtime.undoChange(a[0], a[1], id, a[3])) }
      case 'addMemory': { const a = command.input.args, id = a[2] ?? randomUUID(); return durableWrite(command, id, 2, [], () => runtime.addMemory(a[0], a[1], id)) }
      case 'editMemory': { const a = command.input.args, id = a[3] ?? randomUUID(); return durableWrite(command, id, 3, [a[0]], () => runtime.editMemory(a[0], a[1], a[2], id)) }
      case 'restoreMemory': { const a = command.input.args, id = a[2] ?? randomUUID(); return durableWrite(command, id, 2, [a[0]], () => runtime.restore(a[0], a[1], id)) }
      case 'deleteMemory': { const a = command.input.args, id = a[2] ?? randomUUID(); return durableWrite(command, id, 2, [a[0]], () => runtime.deleteMemory(a[0], a[1], id)) }
      case 'stopMemory': { const a = command.input.args, id = a[2] ?? randomUUID(); return durableWrite(command, id, 2, [a[0]], () => runtime.forget(a[0], a[1], 'forget', id)) }
      case 'provenance': return dispatch.snapshot(...command.input.args)
      case 'replaySources': return runtime.replaySources(command.input.args[0], command.input.args[1])
    }
    throw new Error('Unsupported host operation')
  }
  return { runtime, dispatch, coordination, initializeSession, epoch, ready: () => state === 'ready' && !replayingWrites && !hasPending(), status: () => state === 'ready' && (replayingWrites || hasPending()) ? 'recovering' as const : state,
    recover, receiveSource, completeTurn, registerDerived, sessionContext, handleHost,
    contextGeneration: contextRecovery.contextGeneration, contextRecovery: contextRecovery.contextRecovery, needsContextRecovery,
    prepareContextRecovery: contextRecovery.prepareContextRecovery, bindContextRecovery: contextRecovery.bindContextRecovery, commitContextRecovery: contextRecovery.commitContextRecovery,
    acquireSend(id: string, origin: { session: string, contextGeneration?: number } | { jobId: string }, payload: string) {
      if ('session' in origin) {
        if (contextRecovery.pending(origin.session) || (origin.contextGeneration ?? 0) !== contextRecovery.contextGeneration(origin.session)) throw new Error('Memory context generation changed')
        reconcileChildren(origin.session)
      }
      const admission = 'session' in origin
        ? coordination.beginSession(id, origin.session, sessionContext(origin.session).project, () => sessionContext(origin.session).project)
        : coordination.beginJob(id, origin.jobId)
      if (!admission) throw new Error('Memory dispatch denied')
      try {
        const permit = fence.acquire(id, origin, payload)
        return { ...permit, settled() { coordination.endDispatch(id); permit.settled() } }
      } catch (error) { coordination.endDispatch(id); throw error }
    },
    async close() {
      if (closed) return
      closed = true; state = 'unavailable'; generalQuestions.clear()
      await fence.close()
      try { runtime.close() } finally { lock.close() }
    },
  }
}
