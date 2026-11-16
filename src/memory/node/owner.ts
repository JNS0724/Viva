import { createOwnerContextRecovery } from './owner-context-recovery.ts'
import { removeAbandonedMemoryTemps } from './memory-file-store.ts'
import { memoryProjectScope } from './project-scope.ts'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, createHmac } from 'node:crypto'
import { lockMemoryRoot } from './owner-lock.ts'
import { openMemoryStore, memoryHash } from './memory-store.ts'
import { createMemoryRuntime } from './runtime.ts'
import { createMemoryEmbedder } from './memory-embedder.ts'
import type { NodeMemoryRuntimeOptions } from './runtime.ts'
import type { DocumentSourceCut, DocumentSourceRef } from '../core/ports/documents.ts'
import { combineMemoryProvenance, usesErasedMemory, type MemoryErasureEvidence } from '../contracts/provenance.ts'
import { createMemoryDispatch } from '../core/memory-dispatch.ts'
import { createMemoryCoordination } from '../core/coordination.ts'
import type { MemoryHistoryOccurrence } from '../core/coordination.ts'
import { MemoryDomainError } from '../core/presentation.ts'
import { createMemorySendFence } from '../core/send-fence.ts'
import { parseHostMemoryCommand } from '../contracts/host.ts'
import { MEMORY_FILE_QUESTION_PREFIX } from '../contracts/memory-contract.ts'
import type { MemorySourceAlias, SourceChangeInput, HostMemoryCommand, MemoryOwnerContextUsed, MemoryProject } from '../contracts/host.ts'
import type { MemoryOperationOutcome, MemoryHostEffect, MemorySourceReference } from '../contracts/service.ts'
import type { MemoryFileMutationResult, MemoryManagedFileIdentity, MemoryFileCreateRequest, MemoryFileEditRequest } from '../contracts/file-management.ts'
import { memoryFileCreateRequest, memoryFileForgetRequest } from '../contracts/file-management.ts'
import type { MemoryDomainErrorCode } from '../contracts/domain-error.ts'
import type { MemoryScope } from '../contracts/memory-contract.ts'
import type { MemoryFileDependency } from '../contracts/records.ts'
import type { TextSpan } from '../contracts/text-spans.ts'
import { createOwnerNativeOriginals } from './owner-native-originals.ts'
import { nativeSurfaceInvalidation } from './native-original-maintenance.ts'
import { createNativeOutputAttempts, type NativeOutputAttempt } from './native-output-attempts.ts'
import { createNativeToolReads, type NativeToolCall, type NativeToolReadScope } from './native-tool-reads.ts'
import { createNativeErasureReceipts } from './native-erasure-receipts.ts'
import { createNativeSpills, nativeSpillProvenance, type NativeSpillIntent } from './native-spills.ts'
import { createNativeDerivedMessages } from './native-derived-messages.ts'

// Adapter-independent ingestion DTOs: the adapter authenticates identity and original/derived origin.
export type ReceivedSource = { sessionId: string, messageId: string, text: string, at: number, timezone: string,
  turn: number, step: number, eventSeq?: number, contextGeneration?: number, contentDigest?: string, nativeMessageDigest?: string, admitted: boolean, inherited: boolean, project?: string, live?: boolean, derived?: boolean }
export type CompletedTurn = { sessionId: string, turn: number, eventSeq: number, contextGeneration?: number, sourceIds: readonly string[],
  assistant: string, completed: boolean, at: number, timezone: string }
export type DerivedSource = { verifiedDelivery?: true, contentDigest?: string, nativeUserSource?: string, nativeMessageDigest?: string, sessionId: string, messageId: string, eventSeq?: number, contextGeneration?: number, senderContextGeneration?: number, sourceIds: readonly string[], inherited?: boolean, senderSessionId?: string }
type Options = Pick<NodeMemoryRuntimeOptions, 'compute' | 'route' | 'quiesce'> & {
  root: string, hostNamespace?: string, dailyNotes?: NodeMemoryRuntimeOptions['dailyNotes'], embedding?: { modelRoot: string, runtimeRoot?: string },
  onChange?: NodeMemoryRuntimeOptions['changed'],
  onContextUsed?: (notice: Omit<MemoryOwnerContextUsed, 'type' | 'protocol' | 'epoch'>) => void,
  onProjectionChanged?: () => void,
  onHostEffects?: () => void,
}
type StoredAlias = Omit<MemorySourceAlias, 'text' | 'wireText' | 'wireSpans'> & { textHash: string, spans: TextSpan[] }
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
    CREATE TABLE IF NOT EXISTS owner_turn_sources(session TEXT NOT NULL,turn INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(session,turn,source));
    CREATE TABLE IF NOT EXISTS owner_file_native_erasures (operation TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_host_effects(id TEXT PRIMARY KEY,payload TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);
  `)
  db.exec('CREATE TABLE IF NOT EXISTS owner_file_host_receipts (effect TEXT PRIMARY KEY,fingerprint TEXT NOT NULL) WITHOUT ROWID')
  const nativeCleanup = createNativeErasureReceipts(db)
  const epoch = randomUUID()
  let state: 'recovering' | 'ready' | 'unavailable' = 'recovering'
  let closed = false
  let replayingWrites = false
  const generalQuestions = new Map<string, { session: string, cards: readonly { id: string, question: string }[], check(): boolean }>()
  const dispatch = createMemoryDispatch(store, items => runtime.dependenciesCurrent(items),
    (id, at) => runtime.dispatchSourceCurrent(id, at), (items, sources, at) => runtime.dispatchDeadline(items, sources, at), (files, _, sources) => runtime.fileDependenciesCurrent(files, sources))
  const nativeToolReads = createNativeToolReads(db)
  const nativeSpills = createNativeSpills(db)
  const toolReadScope = new AsyncLocalStorage<NativeToolReadScope>()
  const runtime = createMemoryRuntime({ store, compute: options.compute, route: options.route,
    dailyNotes: options.dailyNotes ?? true,
    ...(options.embedding ? { embedder: createMemoryEmbedder(options.embedding) } : {}),
    quiesce: options.quiesce, changed: change => { options.onChange?.(change) },
    injected: (session, turn, pushed) => options.onContextUsed?.({ session, turn, pushed, revision: store.revision(),
      conversation: sessionContext(session).conversation ?? null, at: Date.now() }),
    validateDispatch: dispatch.validateCommit, dependencies: dispatch.record, provisionalRead: dispatch.recordTurnOnly, fileClarificationDispatch: dispatch,
    runDocumentMutation: work => fence.mutate(work),
    fileDependencies(session, files, sources) {
      const scope = toolReadScope.getStore()
      if (!files.length || scope?.call.session !== session) return dispatch.recordFiles(session, files, sources)
      if (!scope.current() || scope.call.generation !== contextRecovery.contextGeneration(session)) throw new Error('Native tool changed before its read was committed')
      store.tx(() => {
        for (const call of scope.calls) {
          if (call.session !== session || call.generation !== scope.call.generation) throw new Error('Native tool ancestor changed its read origin')
          nativeToolReads.record(call, files, sources, scope.readCut?.())
        }
        dispatch.recordFiles(session, files, sources)
      })
    },
    canCommit: source => state === 'ready' && (!source.session || !db.prepare('SELECT 1 FROM owner_active_turns WHERE session=?').get(source.session)),
  })
  const removedSession = (session: string) => Boolean(db.prepare(`SELECT 1 FROM owner_occurrences o WHERE o.session=? AND o.removed=1
    AND NOT EXISTS(SELECT 1 FROM owner_context_retired r WHERE r.session=o.session AND r.message=o.message) LIMIT 1`).get(session))
  const nativeSurface = nativeSurfaceInvalidation(db)
  const nativeOutputs = createNativeOutputAttempts(db)
  const coordinated = { ...runtime,
    staleSession: (session: string | null | undefined) => runtime.staleSession(session) || Boolean(session && (removedSession(session) || nativeSurface.has(session))),
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
    resolveInherited(session, nativeParent) {
      if (!nativeSurface.has(session)) return null
      const forkParent = nativeSurface.parent(session) ?? nativeParent
      if (forkParent && forkParent !== session) {
        const parent = db.prepare('SELECT context,project FROM owner_sessions WHERE session=?').get(forkParent)
        if (typeof parent?.context === 'string') {
          db.prepare('UPDATE owner_sessions SET context=? WHERE session=? AND context IS NULL AND project IS ?')
            .run(parent.context, session, parent.project ?? null)
        }
      }
      return sessionContext(session).conversation
    },
    replace(session, sources) {
      dispatch.replaceAfterRecovery(session, sources)
      nativeSurface.clear(session)
    },
    committed(session) {
      runtime.finishTurn(session)
      for (const [key, question] of generalQuestions) if (question.session === session) generalQuestions.delete(key)
    },
  })
  const nativeOriginals = createOwnerNativeOriginals(db)
  const nativeDerived = createNativeDerivedMessages(db)
  function needsContextRecovery(session: string, visited = new Set<string>()): boolean {
    if (visited.has(session)) return true
    visited.add(session)
    if (contextRecovery.pending(session) || removedSession(session) || nativeSurface.has(session)) return true
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
      && nativeCleanup.complete(item.id) ? 'complete' : 'pending' })
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
  function originalFromWire(wire: string, spans: readonly TextSpan[]) {
    let position = 0
    return spans.map(({ start, end }) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < position || start >= end || end > wire.length) {
        throw new Error('Source alias does not identify a verbatim wire span')
      }
      position = end
      return wire.slice(start, end)
    }).join('')
  }
  function inferUniqueWireSpan(wire: string, text: string): TextSpan[] {
    if (!text) return []
    const start = wire.indexOf(text)
    if (start < 0 || wire.indexOf(text, start + 1) !== -1) throw new Error('Source alias does not identify a unique verbatim wire span')
    return [{ start, end: start + text.length }]
  }
  function verifiedWireSpans(wire: string, text: string, supplied?: TextSpan[]) {
    const spans = supplied ?? inferUniqueWireSpan(wire, text)
    if (originalFromWire(wire, spans) !== text) throw new Error('Source alias wire spans do not prove the canonical original')
    return spans
  }
  function storeAlias(input: MemorySourceAlias): StoredAlias {
    const { text, wireText, wireSpans, ...metadata } = input
    return { ...metadata, textHash: hash(text), spans: verifiedWireSpans(wireText ?? text, text, wireSpans) }
  }
  function restoreAlias(saved: StoredAlias, wireText: string): MemorySourceAlias & { wireSpans: TextSpan[] } {
    const { textHash, spans, ...metadata } = saved
    const text = originalFromWire(wireText, spans)
    if (hash(text) !== textHash) throw new Error('Source alias wire spans changed')
    return { ...metadata, text, wireText, wireSpans: spans }
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
  function noteInheritedNativeCut(input: Pick<ReceivedSource, 'sessionId' | 'messageId' | 'text' | 'contentDigest' | 'inherited'>) {
    if (!input.inherited || !input.contentDigest || !nativeSurface.provesErasedOriginal(input.messageId, hash(input.text), hash(input.contentDigest))) return false
    nativeSurface.mark(input.sessionId)
    return true
  }
  async function receiveSource(input: ReceivedSource) {
    requireReady()
    requireContextGeneration(input.sessionId, input.contextGeneration)
    if (contextRecovery.retired(input.sessionId, input.messageId)) throw new Error('Source context was retired')
    if (input.contentDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.contentDigest)) throw new Error('Invalid original content digest')
    if (input.nativeMessageDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.nativeMessageDigest)) throw new Error('Invalid native message digest')
    const contentIdentity = db.prepare('SELECT digest FROM owner_message_content WHERE message=?').get(input.messageId)
    if (contentIdentity && contentIdentity.digest !== hash(input.contentDigest)) {
      if (noteInheritedNativeCut(input)) {
        const sourceId = db.prepare("SELECT source FROM owner_messages WHERE id=? AND kind='original'").get(input.messageId)?.source
        if (typeof sourceId === 'string') return { sourceId, text: '', handledIntent: true as const }
      }
      throw new Error('Original content identity conflicts')
    }

    const known = db.prepare(`SELECT m.*, r.spans AS query_spans FROM owner_messages m
      LEFT JOIN owner_message_wires r ON r.message=m.id AND r.source_hash IS NULL WHERE m.id=?`).get(input.messageId) as
      { source: string, hash: string, kind: string, query_start: number | null, query_end: number | null, query_spans: string | null } | undefined
    if (known?.kind === 'host-derived' && known.hash === hash(input.text)) {
      await registerDerived({ sessionId: input.sessionId, messageId: input.messageId, contextGeneration: input.contextGeneration, contentDigest: input.contentDigest, nativeUserSource: 'user', nativeMessageDigest: input.nativeMessageDigest, sourceIds: [], inherited: input.inherited })
      markLiveTurn(input)
      return { sourceId: known.source, text: '', handledIntent: true,
        retrievalQuery: known.query_spans ? originalFromWire(input.text, JSON.parse(known.query_spans) as TextSpan[])
          : known.query_start === null || known.query_end === null ? '' : input.text.slice(known.query_start, known.query_end) }
    }
    if (!known && input.derived) {
      if (input.inherited) throw new Error('Unregistered inherited source')
      await registerDerived({ sessionId: input.sessionId, messageId: input.messageId, contextGeneration: input.contextGeneration, contentDigest: input.contentDigest, nativeUserSource: 'user', nativeMessageDigest: input.nativeMessageDigest, sourceIds: [] })
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
      const sources = mapped.dependencies?.sources ?? []
      await registerDerived({ sessionId: input.sessionId, messageId: input.messageId, contextGeneration: input.contextGeneration, contentDigest: input.contentDigest, nativeUserSource: 'user', nativeMessageDigest: input.nativeMessageDigest, sourceIds: sources })
      const canonical = store.tx(() => {
        db.prepare('UPDATE owner_aliases SET payload=NULL WHERE id=?').run(mapped.operationId)
        db.prepare("UPDATE owner_messages SET kind='host-derived',hash=? WHERE id=?").run(hash(input.text), input.messageId)
        nativeOriginals.record(input.messageId, null, mapped.wireSpans)
        return db.prepare('SELECT source FROM owner_messages WHERE id=?').get(input.messageId)!.source as string
      })
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
      if (input.contentDigest && !known) {
        db.prepare('INSERT INTO owner_message_content VALUES (?,?)').run(input.messageId, hash(input.contentDigest))
        const source = store.readSource(sourceId)
        if (source?.hash && source.hash === memoryHash(text)) {
          const spans = mapped?.wireSpans ?? inferUniqueWireSpan(input.text, text)
          nativeOriginals.record(input.messageId, source.hash, spans)
        }
      }
      db.prepare('INSERT INTO owner_occurrences(session,message,source,conversation,admitted) VALUES (?,?,?,?,?) ON CONFLICT(session,message) DO UPDATE SET admitted=MAX(admitted,excluded.admitted)').run(input.sessionId, input.messageId, sourceId, context.conversation, Number(input.admitted))
      if (mapped) db.prepare('UPDATE owner_aliases SET payload=NULL WHERE id=?').run(mapped.operationId)
      if (input.admitted) {
        dispatch.recordSource(input.sessionId, sourceId)
        if (input.turn > 0) db.prepare('INSERT OR IGNORE INTO owner_turn_sources VALUES (?,?,?)').run(input.sessionId, input.turn, sourceId)
      }
    })
    if (!runtime.dispatchSourceCurrent(sourceId)) throw new Error('Source is withdrawn or unavailable')
    // A rejected original remains withdrawable as a delivery, but cannot authorize a memory write.
    if (store.readSource(sourceId)?.outcome === 'rejected') return { sourceId, text: '' }
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
    if (input.nativeMessageDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.nativeMessageDigest)) throw new Error('Invalid native message digest')
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
      if (input.nativeUserSource && input.contentDigest && (!saved || contentIdentity)) nativeDerived.bind(input.messageId, input.nativeUserSource, input.nativeMessageDigest ? hash(input.nativeMessageDigest) : undefined)
      if (!old) runtime.recordDeliveredSource(canonical, sessionContext(input.sessionId).conversation, true)
    })
  }
  function acceptFileClarification(input: { session: string; contextGeneration: number; questionId: string; text: string; requireShown: boolean },
    stillCurrent: () => boolean) {
    const start = sessionContext(input.session)
    return runtime.answerFileClarification(input, () => sessionContext(input.session), () => {
      const current = sessionContext(input.session)
      return state === 'ready' && !hasPending() && stillCurrent() && contextRecovery.contextGeneration(input.session) === input.contextGeneration
        && current.foregroundTurn === start.foregroundTurn && current.conversation === start.conversation
        && !contextRecovery.pending(input.session) && coordination.allowsSession(input.session, current.project)
    }, (sourceId, context) => {
      db.prepare('INSERT INTO owner_occurrences(session,message,source,conversation,admitted) VALUES (?,?,?,?,1)')
        .run(input.session, sourceId, sourceId, context.conversation)
      // The pinned Dream work owns this answer; normal turn ingestion must not
      // run extraction or create independent daily evidence from the short reply.
      dispatch.recordSource(input.session, sourceId)
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
  type FileReaders = ReadonlyMap<string, readonly MemoryFileDependency[]>
  function currentFileReaders(workspace: string): FileReaders {
    const readers = new Map<string, MemoryFileDependency[]>()
    for (const { id: session } of db.prepare('SELECT id FROM memory_sessions').all() as Array<{ id: string }>) {
      const files = dispatch.snapshot(session).files?.filter(ref => ref.workspace === workspace && runtime.fileDependenciesCurrent([ref]))
      if (files?.length) readers.set(session, files)
    }
    return readers
  }
  function recordRangeErasure(id: string, cuts: readonly DocumentSourceCut[], memoryIds: readonly number[], readers?: FileReaders): boolean {
    if (!cuts.length) return false
    const ranges = cuts.map(({ id: sourceId, version: revision, length, hash, spans }) => {
      const afterHash = store.readSource(sourceId)?.hash
      if (!afterHash) throw new Error('Missing committed source erasure proof')
      return { sourceId, revision, length, hash, afterHash, spans }
    })
    const invalidated = (db.prepare('SELECT id FROM memory_sessions').all() as Array<{ id: string }>).flatMap(({ id: session }) =>
      usesErasedMemory(dispatch.snapshot(session), ranges, memoryIds)
        || readers?.get(session)?.some(ref => !runtime.fileDependenciesCurrent([ref])) ? [session] : [])
    const current = db.prepare('SELECT session FROM owner_occurrences WHERE source=?')
    // File reads can reach native transcripts without creating a source occurrence.
    const nativeSession = db.prepare('SELECT 1 FROM owner_sessions WHERE session=?')
    const nativeSessions = new Set(invalidated.filter(session => nativeSession.get(session)))
    for (const cut of cuts) {
      const origin = store.readSource(cut.id)?.session
      if (origin) nativeSessions.add(origin)
      for (const row of current.all(cut.id)) {
        const session = String(row.session)
        nativeSessions.add(session)
        invalidated.push(session)
      }
      db.prepare('UPDATE owner_aliases SET payload=NULL,revoked=1 WHERE source=?').run(cut.id)
    }
    const sessions = [...new Set(invalidated)]
    for (const session of contextRecovery.nativeReplicaSessions(proof => usesErasedMemory(proof, ranges, memoryIds))) nativeSessions.add(session)
    for (const { session } of nativeOutputs.affected(ranges, memoryIds)) nativeSessions.add(session)
    for (const { session } of nativeToolReads.affected(ranges)) nativeSessions.add(session)
    if (nativeSessions.size) {
      const originals = nativeOriginals.replicas(ranges)
      db.prepare('INSERT INTO owner_file_native_erasures VALUES (?,?)')
        .run(id, JSON.stringify({ sessions: [...nativeSessions], ranges, ...(memoryIds.length ? { memoryIds } : {}),
          ...(originals.length ? { originals } : {}) }))
    }
    if (options.hostNamespace) {
      const effect: MemoryHostEffect = { effectId: id, causeOperationId: id, revision: store.revision(), hostNamespace: options.hostNamespace,
        kind: 'erase-file-copies', sessions, memoryIds: [...memoryIds],
        ...(nativeSessions.size ? { traceSessions: [...nativeSessions] } : {}),
        sources: cuts.map(cut => ({ namespace: 'canonical', sourceId: cut.id, revision: cut.version })), ranges }
      db.prepare('INSERT INTO owner_host_effects(id,payload) VALUES (?,?)').run(id, JSON.stringify(effect))
      return true
    }
    return false
  }
  async function commit(input: { operationId: string, ticket: string }) {
    const item = operation(input.operationId)
    if (!item || item.ticket !== input.ticket || !['prepared', 'host-committed', 'completed'].includes(item.state)) throw new Error('Source change was not prepared')
    if (item.state === 'completed') return outcome(item)
    const change = JSON.parse(item.payload!) as SourceChangeInput
    db.prepare("UPDATE owner_operations SET state='host-committed' WHERE id=?").run(item.id)
    let notify = false
    await fence.mutate(() => {
      store.tx(() => {
        let ids = new Set(change.ids)
        if (change.onlySources) {
          for (const id of ids) {
            db.prepare('UPDATE owner_occurrences SET removed=1 WHERE conversation=? AND source=?').run(change.conversation, id)
            db.prepare('UPDATE owner_aliases SET payload=NULL,revoked=1 WHERE conversation=? AND source=?').run(change.conversation, id)
          }
        } else {
          // Native intake can be ahead of the renderer's last saved history.
          // Withdraw the owner's occurrences in this segment as well as host-known deliveries.
          const occurrences = db.prepare('SELECT DISTINCT source FROM owner_occurrences WHERE conversation=?').all(change.conversation) as { source: string }[]
          const aliases = db.prepare('SELECT DISTINCT source FROM owner_aliases WHERE conversation=?').all(change.conversation) as { source: string }[]
          const owned = new Set([...store.sourceIds(change.conversation), ...store.deliveredSourceIds(change.conversation), ...occurrences.map(row => row.source)])
          for (const id of [...ids, ...aliases.map(row => row.source)]) {
            if (!owned.has(id) && !store.deliveredSource(id) && !store.readSource(id)) owned.add(id)
          }
          ids = owned
          db.prepare('UPDATE owner_occurrences SET removed=1 WHERE conversation=?').run(change.conversation)
          db.prepare('UPDATE owner_aliases SET payload=NULL,revoked=1 WHERE conversation=?').run(change.conversation)
        }
        const surviving = db.prepare('SELECT 1 FROM owner_occurrences WHERE source=? AND removed=0 LIMIT 1')
        const removed = [...ids].filter(id => !surviving.get(id))
        const { cuts, memoryIds } = runtime.withdraw({ conversation: change.conversation, ids: removed, onlySources: true })
        notify = recordRangeErasure(item.id, cuts, memoryIds)
        for (const id of removed) {
          store.excludeSource(id)
        }
        db.prepare("UPDATE owner_operations SET state='completed',payload=NULL WHERE id=?").run(item.id)
      })
      runtime.releaseWithdrawal(change.conversation, change.onlySources ? change.ids : undefined)
    })
    if (notify) options.onHostEffects?.()
    if (state === 'ready' && !hasPending()) await replayWrites()
    return outcome(operation(item.id)!)
  }
  function completeFileEffects() {
    if (runtime.cleanupPending() !== 0) return false
    let changed = false
    const waiting = db.prepare(`SELECT e.id,e.payload,r.fingerprint FROM owner_host_effects e JOIN owner_file_host_receipts r ON r.effect=e.id
      WHERE e.acked=0 AND json_extract(e.payload,'$.kind')='erase-file-copies'`).all()
    for (const row of waiting) {
      if (row.fingerprint !== hash(String(row.payload))) throw new Error('Host erasure receipt differs from its effect')
      if (nativeCleanup.complete(String(row.id))) {
        db.prepare('UPDATE owner_host_effects SET acked=1 WHERE id=?').run(row.id)
        changed = true
      }
    }
    return changed
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
    completeFileEffects()
    if (!hasPending()) await replayWrites()
    runtime.resumeDocumentClarifications()
    void runtime.wake()
  }
  async function replayWrites() {
    if (replayingWrites) return
    replayingWrites = true
    try {
      for (const item of db.prepare("SELECT * FROM owner_operations WHERE state='running'").all() as Operation[]) {
        const payload = JSON.parse(item.payload!) as WritePayload | FileWritePayload | ManualFilePending | NativeRememberPayload
        try {
          if ('nativeRemember' in payload) await completeNativeRemember(item.id, payload.nativeRemember, () => !closed && !hasPending())
          else if ('manual' in payload) await completeManualFile(item.id, payload.manual)
          else if ('standaloneSession' in payload && payload.standaloneSession) await durableFileWrite(payload.command, payload.standaloneSession)
          else await handleHost(payload.command.method, payload.command.input)
        } catch (error) { if (operation(item.id)?.state !== 'failed') throw error }
      }
    } finally { replayingWrites = false }
  }
  const pendingHostEffects = () => (db.prepare(`SELECT payload FROM owner_host_effects WHERE acked=0
    ORDER BY json_extract(payload,'$.revision'),rowid`).all() as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as MemoryHostEffect)
  type ProfileWriteCommand = Extract<HostMemoryCommand, { method: 'setProfile' }>
  type WritePayload = { command: ProfileWriteCommand }
  async function durableProfileWrite(input: ProfileWriteCommand) {
    const [fields, requestedId] = input.input.args, id = requestedId ?? randomUUID()
    const command: ProfileWriteCommand = { method: 'setProfile', input: { args: [fields, id] } }
    const previous = operation(id), fingerprint = hash(command)
    if (previous && previous.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
    if (previous?.state === 'failed') throw new Error('Memory operation previously failed')
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?,NULL)").run(id, fingerprint, JSON.stringify({ command }))
    return fence.mutate(async () => {
      try {
        const result = await runtime.setProfile(fields, id)
        db.prepare("UPDATE owner_operations SET state='completed',payload=NULL WHERE id=?").run(id)
        return result
      } catch (error) {
        if (error instanceof MemoryDomainError && error.code !== 'change.pending') {
          db.prepare("UPDATE owner_operations SET state='failed',payload=NULL WHERE id=?").run(id)
        }
        throw error
      }
    })
  }
  type FileWriteCommand = Extract<HostMemoryCommand, { method: 'setFileEnabled' | 'undoFile' | 'forgetFile' }>
  type FileWritePayload = { command: FileWriteCommand, sources: MemorySourceReference[], sessions: string[], standaloneSession?: string }
  function fileSessions(identity: MemoryManagedFileIdentity, sources: readonly MemorySourceReference[]): string[] {
    const sourceIds = new Set(sources.map(ref => ref.sourceId))
    return (db.prepare('SELECT id FROM memory_sessions').all() as Array<{ id: string }>).flatMap(({ id }) => {
      const evidence = dispatch.snapshot(id)
      return evidence.sources.some(source => sourceIds.has(source))
        || evidence.files?.some(file => file.workspace === identity.workspace && file.id === identity.id) ? [id] : []
    })
  }
  type NativeRememberPlan = { session: string, source: DocumentSourceRef }
  type NativeRememberPayload = { nativeRemember: NativeRememberPlan }
  async function completeNativeRemember(id: string, plan: NativeRememberPlan, current: () => boolean) {
    try {
      return await runtime.writeSourceFile(id, plan.source, plan.session, result => {
        db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result }), id)
      }, current)
    } catch (error) {
      if (error instanceof MemoryDomainError && error.code !== 'change.pending') {
        db.prepare("UPDATE owner_operations SET state='failed',payload=NULL WHERE id=?").run(id)
      }
      throw error
    }
  }
  async function rememberNativeFile(text: string) {
    requireReady()
    const scope = toolReadScope.getStore()
    if (!scope || !scope.current()) return null
    const { call } = scope, origin = sessionContext(call.session)
    if (!scope.calls.length || !scope.calls.some(ancestor => ancestor.id === call.id)) return null
    if (call.generation !== contextRecovery.contextGeneration(call.session) || origin.foregroundTurn !== String(call.turn)) return null
    const sources = db.prepare(`SELECT source FROM owner_turn_sources WHERE session=? AND turn=?
      UNION ALL SELECT source FROM owner_answer_sources WHERE session=? AND turn=?`).all(call.session, call.turn, call.session, String(call.turn))
      .map(row => String(row.source))
    const proof = runtime.explicitFileSource(text, origin, sources)
    if (!proof) return null
    const digest = hash(['native-remember', call.session, call.seq, call.digest, call.callId])
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    const plan: NativeRememberPlan = { session: call.session, source: proof }
    const fingerprint = hash({ nativeRemember: plan }), previous = operation(id)
    if (previous && previous.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
    store.tx(() => {
      for (const ancestor of scope.calls) {
        if (ancestor.session !== call.session || ancestor.generation !== call.generation) throw new Error('Native remember ancestor changed its origin')
        nativeToolReads.recordEvidence(ancestor, { sources: [], fileRanges: [{ sourceId: proof.id, spans: proof.spans }], memoryIds: [] }, scope.readCut?.())
      }
      if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?,NULL)").run(id, fingerprint, JSON.stringify({ nativeRemember: plan }))
    })
    if (previous?.state === 'completed') return (JSON.parse(previous.payload!) as { result: MemoryFileMutationResult }).result
    if (previous?.state === 'failed') throw new MemoryDomainError('operation.conflict')
    return completeNativeRemember(id, plan, () => scope.current() && call.generation === contextRecovery.contextGeneration(call.session)
      && sessionContext(call.session).foregroundTurn === String(call.turn))
  }

  type ManualFileCommand = Extract<HostMemoryCommand, { method: 'createFile' | 'editFile' }>
  type ManualFilePlan = { workspace: string, usageVersion: number | null, sessions: string[], project?: MemoryProject }
  type ManualFilePending = { manual: ManualFilePlan }

  async function completeManualFile(id: string, plan: ManualFilePlan, request?: MemoryFileCreateRequest | MemoryFileEditRequest) {
    let notify = false
    try {
      const receipt = await runtime.writeManagedFile(id, plan.workspace, request, result => store.tx(() => {
        if (operation(id)?.state === 'completed') return
        const sessions = plan.usageVersion !== null && plan.usageVersion !== result.usageVersion
          ? [...new Set([...plan.sessions, ...fileSessions(result.identity, [])])] : []
        if (options.hostNamespace && sessions.length) {
          const effect: MemoryHostEffect = { effectId: id, causeOperationId: id, revision: store.revision(), hostNamespace: options.hostNamespace,
            kind: 'invalidate-context', sources: [], sessions }
          db.prepare('INSERT OR IGNORE INTO owner_host_effects(id,payload) VALUES (?,?)').run(id, JSON.stringify(effect))
          notify = true
        }
        db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result }), id)
      }), plan.project)
      if (notify) options.onHostEffects?.()
      return receipt
    } catch (error) {
      if (error instanceof MemoryDomainError && error.code !== 'change.pending' && operation(id)?.state !== 'completed') {
        db.prepare("UPDATE owner_operations SET state='failed',payload=? WHERE id=?").run(JSON.stringify({ code: error.code }), id)
      }
      throw error
    }
  }

  async function durableManualFileWrite(command: ManualFileCommand, project?: MemoryProject) {
    requireReady()
    const request = command.input.args[0], id = request.operationId, fingerprint = hash(project ? { command, project } : command)
    const previous = operation(id)
    if (previous && previous.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
    if (previous?.state === 'completed') return (JSON.parse(previous.payload!) as { result: MemoryFileMutationResult }).result
    if (previous?.state === 'failed') throw new MemoryDomainError((JSON.parse(previous.payload!) as { code: MemoryDomainErrorCode }).code)
    const plan = previous?.payload ? (JSON.parse(previous.payload) as ManualFilePending).manual : 'identity' in request
      ? { workspace: request.identity.workspace, usageVersion: request.version.usageVersion, sessions: fileSessions(request.identity, []) }
      : { workspace: runtime.manualFileWorkspace(project), usageVersion: null, sessions: [], ...(project ? { project } : {}) }
    // Only the file journal may retain a draft, with both its old and new backing proofs.
    // Waiting for the send fence must not persist a detached copy of the submitted words.
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?,NULL)")
      .run(id, fingerprint, JSON.stringify({ manual: plan } satisfies ManualFilePending))
    const receipt = await completeManualFile(id, plan, request)
    if (!receipt) throw new Error('Manual memory write missing its receipt')
    return receipt
  }

  /** The runtime owns the only send fence. The durable intent bridges its document receipt and
   * this completion/outbox transaction if the process exits between the two commits. */
  async function durableFileWrite(command: FileWriteCommand, standaloneSession?: string): Promise<MemoryFileMutationResult> {
    requireReady()
    const request = command.input.args[0], id = request.operationId, fingerprint = hash(standaloneSession ? { command, standaloneSession } : command)
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
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?,NULL)").run(id, fingerprint,
      JSON.stringify({ command, sources, sessions, standaloneSession } satisfies FileWritePayload))
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
    let readers: FileReaders | undefined
    try {
      const result = command.method === 'setFileEnabled'
        ? await runtime.setFileEnabled(command.input.args[0], committed)
        : command.method === 'undoFile' ? await runtime.undoFile(command.input.args[0], committed)
          : await runtime.forgetFile(command.input.args[0], (result, cuts, memoryIds) => {
            notify = recordRangeErasure(id, cuts, memoryIds, readers)
            db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result, standaloneSession }), id)
          }, () => { readers = currentFileReaders(request.identity.workspace) })
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
  function standaloneFileOrigin(session: string) {
    requireReady()
    if (options.hostNamespace || !db.prepare('SELECT 1 FROM owner_sessions WHERE session=?').get(session)) {
      throw new MemoryDomainError('not.found')
    }
    return sessionContext(session)
  }
  function rememberStandaloneFile(session: string, input: MemoryFileCreateRequest) {
    const origin = standaloneFileOrigin(session), request = memoryFileCreateRequest.parse(input)
    return durableManualFileWrite({ method: 'createFile', input: { args: [request] } }, origin.project)
  }
  async function forgetStandaloneFile(session: string, id: string, operationId: string) {
    const origin = standaloneFileOrigin(session), previous = operation(operationId)
    if (previous?.state === 'completed') {
      const receipt = JSON.parse(previous.payload!) as { standaloneSession?: string, result: MemoryFileMutationResult }
      if (receipt.standaloneSession !== session || receipt.result.identity.id !== id) throw new MemoryDomainError('operation.conflict')
      return outcome(previous).cleanup
    }
    if (previous?.state === 'running') {
      const payload = JSON.parse(previous.payload!) as FileWritePayload
      if (payload.standaloneSession !== session || payload.command.method !== 'forgetFile' || payload.command.input.args[0].identity.id !== id) {
        throw new MemoryDomainError('operation.conflict')
      }
      await durableFileWrite(payload.command, session)
    } else {
      const target = runtime.fileForSession(id, origin)
      if (!target) throw new MemoryDomainError('not.found')
      const request = memoryFileForgetRequest.parse({ ...target, operationId })
      await durableFileWrite({ method: 'forgetFile', input: { args: [request] } }, session)
    }
    const item = operation(operationId)
    return item?.state === 'completed' && outcome(item).cleanup === 'complete' ? 'complete' as const : 'pending' as const
  }
  async function handleHost(method: unknown, input: unknown): Promise<unknown> {
    const command = parseHostMemoryCommand(method, input)
    switch (command.method) {
      case 'prepareSourceChange': return prepare(command.input)
      case 'commitSourceChange': return commit(command.input)
      case 'getOperation': { completeFileEffects(); const item = operation(command.input.operationId); return item ? outcome(item) : null }
      case 'pendingHostEffects': completeFileEffects(); return pendingHostEffects()
      case 'nativeOutputEvidence': return nativeOutputs.outputEvidence(command.input.session, command.input.seq, command.input.digest)
      case 'cancelFileClarification': return runtime.cancelFileClarification(...command.input.args)
      case 'ackHostEffect': {
        const saved = db.prepare('SELECT payload FROM owner_host_effects WHERE id=?').get(command.input.effectId)
        if (!saved) throw new Error('Unknown host effect')
        const effect = JSON.parse(saved.payload as string) as MemoryHostEffect
        if ( (effect.causeOperationId !== command.input.causeOperationId || effect.revision !== command.input.revision)) throw new Error('Host effect version conflicts')
        if (effect.kind === 'erase-file-copies') {
          const fingerprint = hash(String(saved.payload))
          const prior = db.prepare('SELECT fingerprint FROM owner_file_host_receipts WHERE effect=?').get(effect.effectId)
          if (prior && prior.fingerprint !== fingerprint) throw new Error('Host erasure receipt differs from its effect')
          const inserted = db.prepare('INSERT OR IGNORE INTO owner_file_host_receipts VALUES (?,?)').run(effect.effectId, fingerprint)
          const completed = completeFileEffects()
          if (inserted.changes || completed) options.onProjectionChanged?.()
          return { accepted: true }
        }
        const acknowledged = db.prepare('UPDATE owner_host_effects SET acked=1 WHERE id=? AND acked=0').run(command.input.effectId)
        if (acknowledged.changes && effect.kind === 'erase-copies') options.onProjectionChanged?.()
        return { accepted: true }
      }
      case 'sourceAlias': return alias(command.input)
      case 'bindWireAlias': {
        requireReady()
        const [session, text, wireText, sourceId, suppliedSpans] = command.input.args
        const wireSpans = verifiedWireSpans(wireText, text, suppliedSpans)
        const delivery = randomUUID()
        // The entire wire is matched against this trusted receipt. Never parse/strip a marker from user text.
        const prepared = `${wireText}\n\n<memory-delivery id="${delivery}" />`
        let input: MemorySourceAlias
        if (!sourceId) {
          const context = sessionContext(session)
          input = { operationId: delivery, sourceId: delivery, session, conversation: context.conversation, text, wireText: prepared, wireSpans,
            context: context.context, project: context.project, origin: 'derived', dependencies: dispatch.snapshot(session) }
        } else {
          const rows = db.prepare('SELECT id,payload,delivery FROM owner_aliases WHERE session=? AND source=? AND payload IS NOT NULL AND revoked=0').all(session, sourceId) as Array<{id: string,payload: string,delivery: number}>
          const matched = rows.filter(row => (JSON.parse(row.payload) as StoredAlias).textHash === hash(text))
          const staged = matched.find(row => !row.delivery) ?? matched[0]
          if (staged) {
            const { textHash: _hash, spans: _spans, ...metadata } = JSON.parse(staged.payload) as StoredAlias
            input = { ...metadata, text, operationId: delivery, wireText: prepared, wireSpans }
          }
          else {
            if (!runtime.replaySource(sourceId, text)) throw new Error('Original source alias is unavailable')
            const context = sessionContext(session)
            input = { operationId: delivery, sourceId, session, conversation: context.conversation, text, wireText: prepared, wireSpans,
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
        if (input.questionId.startsWith(MEMORY_FILE_QUESTION_PREFIX)) {
          const context = sessionContext(input.session), turn = context.foregroundTurn
          const current = turn && runtime.clarificationQuestion(input.session, turn, input.questionId, 'check')
          if (!current || current.question !== input.question || context.conversation !== input.conversation
            || context.project?.id !== input.project?.id) throw new Error('Question is no longer authorized')
          const accepted = await acceptFileClarification({ ...input, contextGeneration: contextRecovery.contextGeneration(input.session), requireShown: true }, () => true)
          if (!accepted) throw new Error('Question is no longer authorized')
          return accepted
        }
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
      case 'profile': return runtime.profile(...command.input.args)
      case 'revision': return runtime.revision(...command.input.args)
      case 'epoch': return runtime.epoch(...command.input.args)
      case 'cleanupPending': {
        completeFileEffects()
        const pending = runtime.cleanupPending()
        const native = db.prepare('SELECT operation FROM owner_file_native_erasures').all()
          .flatMap(row => nativeCleanup.complete(String(row.operation)) ? [] : [String(row.operation)])
        const host = db.prepare(`SELECT id FROM owner_host_effects WHERE acked=0
          AND json_extract(payload,'$.kind') IN ('erase-file-copies','erase-copies')`).all().map(row => String(row.id))
        return pending + new Set([...native, ...host]).size
      }
      case 'onboarding': return runtime.onboarding(...command.input.args)
      case 'sessionProject': return runtime.sessionProject(...command.input.args)
      case 'recordSessionProject': return runtime.recordSessionProject(...command.input.args)
      case 'recordSession': return runtime.recordSession(...command.input.args)
      case 'recordDeliveredSource': runtime.recordDeliveredSource(command.input.args[0], command.input.args[1], command.input.args[2]); dispatch.recordSource(command.input.args[3], command.input.args[0]); return
      case 'isDerivedDelivery': return runtime.isDerivedDelivery(...command.input.args)
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
      case 'inheritFork': {
        const [parent, session] = command.input.args
        const previous = nativeSurface.parent(session)
        if (parent === session || previous && previous !== parent) return false
        return store.tx(() => {
          if (!coordination.inherit(...command.input.args)) return false
          nativeSurface.bindFork(session, parent)
          return true
        })
      }
      case 'allowsProjectHistory': return coordination.allowsProjectHistory(...command.input.args)
      case 'useHistory': return coordination.useHistory(...command.input.args)
      case 'listFiles': return runtime.listFiles(command.input.args[0])
      case 'readFile': return runtime.readFile(...command.input.args)
      case 'fileProfile': return runtime.fileProfile(...command.input.args)
      case 'createFile':
      case 'editFile': return durableManualFileWrite(command)
      case 'setFileEnabled':
      case 'forgetFile':
      case 'undoFile': return durableFileWrite(command)
      case 'setOnboarding': return fence.mutate(() => runtime.setOnboarding(...command.input.args))
      case 'rebuildIndexes': return fence.mutate(() => runtime.rebuildIndexes(...command.input.args))
      case 'setProfile': return durableProfileWrite(command)
      case 'provenance': return dispatch.snapshot(...command.input.args)
      case 'authorizedProvenance': {
        const { session, prior, sourceId } = command.input
        if (!db.prepare('SELECT 1 FROM owner_sessions WHERE session=?').get(session)
          || fence.blocked() || contextRecovery.pending(session) || hasPending()) return null
        const { project, conversation } = sessionContext(session)
        if (!coordination.allowsSession(session, project)) return null
        if (prior) return !sourceId && coordination.transferStatus(prior, project, true) === 'ready' ? prior : null
        const evidence = dispatch.snapshot(session)
        if (!sourceId) return evidence
        // Fast routing may take the wire before native inbox intake. A host-bound
        // delivery receipt still identifies the exact raw request independently.
        if (!db.prepare('SELECT 1 FROM owner_aliases WHERE session=? AND conversation=? AND source=? AND delivery=1 AND revoked=0')
          .get(session, conversation, sourceId)) return null
        if (!store.readSource(sourceId) && !store.deliveredSource(sourceId)) runtime.recordDeliveredSource(sourceId, conversation)
        if (!runtime.dispatchSourceCurrent(sourceId)) return null
        return combineMemoryProvenance(evidence, { dependencies: [], sources: [sourceId], epoch: evidence.epoch, turnOnly: false })
      }
      case 'replaySources': return runtime.replaySources(command.input.args[0], command.input.args[1])
    }
    throw new Error('Unsupported host operation')
  }
  return { runtime, dispatch, coordination, initializeSession, epoch, ready: () => state === 'ready' && !replayingWrites && !hasPending(), status: () => state === 'ready' && (replayingWrites || hasPending()) ? 'recovering' as const : state,
    recover, receiveSource, completeTurn, registerDerived, sessionContext, handleHost, acceptFileClarification,
    rememberStandaloneFile, forgetStandaloneFile, rememberNativeFile,
    contextGeneration: contextRecovery.contextGeneration, contextRecovery: contextRecovery.contextRecovery, needsContextRecovery,
    nativeContextRewritten: nativeSurface.has, noteInheritedNativeCut,
    prepareContextRecovery: contextRecovery.prepareContextRecovery, bindContextRecovery: contextRecovery.bindContextRecovery, commitContextRecovery: contextRecovery.commitContextRecovery,
    finishNativeOutput: nativeOutputs.finish,
    finishNativeToolRead: nativeToolReads.finish,
    beginNativeSpill(intent: NativeSpillIntent) {
      if (state !== 'ready' || replayingWrites || hasPending() || intent.call.generation !== contextRecovery.contextGeneration(intent.call.session)) throw new Error('Native spill belongs to a retired execution')
      const evidence = nativeSpills.evidence(intent.call)
      const provenance = nativeSpillProvenance(dispatch.snapshot(intent.call.session), evidence)
      const { evidence: _claimed, provenance: _unchecked, ...identity } = intent
      return nativeSpills.begin({ ...identity, evidence, ...(provenance ? { provenance } : {}) })
    },
    finishNativeSpill: nativeSpills.finish, nativeSpillCandidates: nativeSpills.candidates,
    admitNativeSpillRead(id: string, scope: NativeToolReadScope) {
      const saved = nativeSpills.read(id)
      if (!saved || saved.erased || !saved.file || !saved.provenance || !saved.evidence?.length) throw new Error('Native spill proof is unavailable')
      const generation = contextRecovery.contextGeneration(scope.call.session)
      const proof = { ...saved.provenance, epoch: store.epoch() }
      const current = () => state === 'ready' && !replayingWrites && !hasPending() && scope.current() && scope.call.generation === generation
        && contextRecovery.contextGeneration(scope.call.session) === generation && nativeSpills.read(id)?.erased === false
        && dispatch.transferable(proof) && coordination.allowsEvidence(proof, sessionContext(scope.call.session).project)
      if (!current()) throw new Error('Native spill source or scope was retired')
      store.tx(() => {
        for (const call of scope.calls) for (const evidence of saved.evidence!) nativeToolReads.recordEvidence(call, evidence, scope.readCut?.())
        dispatch.attach(scope.call.session, proof)
      })
      return { current }
    },
    nativeSpillGoverned: nativeSpills.governed,
    nativeToolEvidence: nativeToolReads.evidence,
    inheritNativeToolRead(scope: NativeToolReadScope, evidence: readonly MemoryErasureEvidence[]) {
      if (!scope.current() || scope.call.generation !== contextRecovery.contextGeneration(scope.call.session)) throw new Error('Native tool input changed its generation')
      store.tx(() => {
        for (const call of scope.calls) for (const item of evidence) nativeToolReads.recordEvidence(call, item, scope.readCut?.())
      })
    },
    withNativeToolRead<T>(scope: NativeToolReadScope, read: () => T): T {
      return toolReadScope.run(scope, read)
    },
    acquireSend(id: string, origin: { session: string, contextGeneration?: number, output?: NativeOutputAttempt } | { jobId: string }, payload: string) {
      const output = 'session' in origin ? origin.output : undefined
      if ('session' in origin) {
        if (output && (output.session !== origin.session || output.generation !== (origin.contextGeneration ?? 0))) throw new Error('Native output attempt belongs to a different send origin')
        if (contextRecovery.pending(origin.session) || (origin.contextGeneration ?? 0) !== contextRecovery.contextGeneration(origin.session)) throw new Error('Memory context generation changed')
        reconcileChildren(origin.session)
      }
      const sessionAdmission = 'session' in origin && coordination.beginSession(id, origin.session, sessionContext(origin.session).project,
        () => sessionContext(origin.session).project)
      if (!('session' in origin ? sessionAdmission : coordination.beginJob(id, origin.jobId))) throw new Error('Memory dispatch denied')
      const evidence = sessionAdmission ? sessionAdmission.evidence : undefined
      try {
        const permit = fence.acquire(id, origin, payload)
        return { ...permit, settled() { coordination.endDispatch(id); permit.settled() },
          ...(output && evidence ? { recordBody: () => nativeOutputs.record(output, evidence) } : {}) }
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
