import { RequestTimeout } from '../../shared/request-budget.ts'
import type { DiagnosticOperation, DiagnosticPort } from '../../diagnostics/contracts.ts'
import { guardDiagnosticPort } from '../../diagnostics/contracts.ts'
import { observeDiagnosticAsync } from '../../diagnostics/operation.ts'
import { removeAbandonedMemoryTemps } from './memory-file-store.ts'
import { resolveMemoryProject, type MemoryProjectResolution } from './project-scope.ts'
import path from 'node:path'
import { randomUUID, createHmac } from 'node:crypto'
import { lockMemoryRoot } from './owner-lock.ts'
import { openMemoryStore, memoryHash } from './memory-store.ts'
import { createMemoryRuntime } from './runtime.ts'
import { createMemoryEmbedder } from './memory-embedder.ts'
import type { NodeMemoryRuntimeOptions } from './runtime.ts'
import type { DocumentSourceRef } from '../core/ports/documents.ts'
import { MemoryDomainError } from '../core/presentation.ts'
import { looksSecret } from '../core/memory-sensitive.ts'
import { parseHostMemoryCommand } from '../contracts/host.ts'
import type { MemorySourceAlias, HostMemoryCommand, MemoryOwnerContextUsed, MemoryProject } from '../contracts/host.ts'
import type { MemoryOperationOutcome } from '../contracts/service.ts'
import type { MemoryFileMutationResult, MemoryFileCreateRequest, MemoryFileEditRequest } from '../contracts/file-management.ts'
import { memoryFileCreateRequest, memoryFileForgetRequest } from '../contracts/file-management.ts'
import type { MemoryDomainErrorCode } from '../contracts/domain-error.ts'
import type { MemoryScope } from '../contracts/memory-contract.ts'
import type { TextSpan } from '../contracts/text-spans.ts'

// Adapter-independent ingestion DTOs: the adapter authenticates identity and original/derived origin.
export type ReceivedSource = { sessionId: string, messageId: string, text: string, at: number, timezone: string,
  turn: number, live?: boolean, derived?: boolean, cwd?: string | null, task?: boolean }
export type CompletedTurn = { sessionId: string, turn: number, eventSeq: number, sourceIds: readonly string[],
  assistant: string, completed: boolean, at: number, timezone: string }
type Options = Pick<NodeMemoryRuntimeOptions, 'compute' | 'route'> & {
  diagnostics?: DiagnosticPort
  now?: () => number
  root: string, hostNamespace?: string, dailyNotes?: NodeMemoryRuntimeOptions['dailyNotes'], embedding?: { modelRoot: string, runtimeRoot?: string },
  onChange?: NodeMemoryRuntimeOptions['changed'],
  onContextUsed?: (notice: Omit<MemoryOwnerContextUsed, 'type' | 'protocol' | 'epoch'>) => void,
}
type StoredAlias = Omit<MemorySourceAlias, 'text' | 'wireText' | 'wireSpans' | 'cwd'> & { textHash: string, spans: TextSpan[] }
type Session = { conversation: string, context: string | null, project: string | null }
type Operation = { id: string, fingerprint: string, state: MemoryOperationOutcome['state'], payload: string | null }

/** Protocol operations only. This classification has no role in facts, conflicts or admission. */
function hostDiagnosticOperation(method: HostMemoryCommand['method']): DiagnosticOperation | undefined {
  switch (method) {
    case 'forgetFile': return 'memory.forget'
    case 'createFile': case 'editFile': case 'setFileEnabled': case 'setProfile': case 'setOnboarding': case 'getOperation': return 'memory.write'
    case 'undoFile': return 'memory.undo'
    case 'rebuildIndexes': return 'memory.index'
    case 'sourceAlias': return 'memory.intake'
  }
}

/** Single storage owner shared by every adapter. Host callers never receive its DB or runtime. */
export function openMemoryOwner(options: Options) {
  const lock = lockMemoryRoot(options.root)
  const store = (() => { try { return openMemoryStore(path.join(lock.root, 'memory.db'), options.now) } catch (error) { lock.close(); throw error } })()
  try { return assembleOwner(options, lock, store) }
  catch (error) { try { store.close() } finally { lock.close() }; throw error }
}

function assembleOwner(options: Options, lock: ReturnType<typeof lockMemoryRoot>, store: ReturnType<typeof openMemoryStore>) {
  const diagnostics = guardDiagnosticPort(options.diagnostics)
  const db = store.db
  const boundHost = store.meta('owner.host')
  if (boundHost && boundHost !== options.hostNamespace) throw Object.assign(new Error('Memory root belongs to a different host binding'), { code: 'denied' })
  if (options.hostNamespace && !boundHost) store.setMeta('owner.host', options.hostNamespace)
  const hash = (value: unknown) => createHmac('sha256', store.meta('secret')!).update(JSON.stringify(value)).digest('hex')
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_active_turns(session TEXT PRIMARY KEY,turn TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_answer_sources(session TEXT NOT NULL,turn TEXT NOT NULL,source TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS owner_sessions(session TEXT PRIMARY KEY,conversation TEXT NOT NULL,context TEXT,project TEXT);
    CREATE TABLE IF NOT EXISTS owner_aliases(
      id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,session TEXT NOT NULL,wire_hash TEXT NOT NULL,payload TEXT NOT NULL,source TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS owner_alias_wire ON owner_aliases(session,wire_hash);
    CREATE TABLE IF NOT EXISTS owner_messages(
      id TEXT PRIMARY KEY,session TEXT NOT NULL,source TEXT NOT NULL,hash TEXT NOT NULL,kind TEXT NOT NULL,project TEXT,spans TEXT);
    CREATE TABLE IF NOT EXISTS owner_turns(session TEXT NOT NULL,turn INTEGER NOT NULL,seq INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(session,turn));
    CREATE TABLE IF NOT EXISTS owner_operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,payload TEXT);
    CREATE TABLE IF NOT EXISTS owner_skip_assistant(session TEXT NOT NULL,turn INTEGER NOT NULL,PRIMARY KEY(session,turn));
    CREATE TABLE IF NOT EXISTS owner_turn_sources(session TEXT NOT NULL,turn INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(session,turn,source));
  `)
  const epoch = randomUUID()
  let state: 'recovering' | 'ready' | 'unavailable' = 'recovering'
  let closed = false
  let replayingWrites = false
  const runtime = createMemoryRuntime({ store, compute: options.compute, route: options.route, diagnostics: options.diagnostics,
    ...(options.now ? { now: options.now } : {}),
    dailyNotes: options.dailyNotes ?? true,
    ...(options.embedding ? { embedder: createMemoryEmbedder(options.embedding) } : {}),
    changed: change => { options.onChange?.(change) },
    injected: (session, turn, pushed) => options.onContextUsed?.({ session, turn, pushed, revision: store.revision(),
      conversation: sessionContext(session).conversation ?? null, at: Date.now() }),
    canCommit: source => state === 'ready' && (!source.session || !db.prepare('SELECT 1 FROM owner_active_turns WHERE session=?').get(source.session)),
  })
  function sessionContext(session: string) {
    const saved = db.prepare('SELECT * FROM owner_sessions WHERE session=?').get(session) as Session | undefined
    const project = saved?.project
    const turn = db.prepare('SELECT turn FROM owner_active_turns WHERE session=?').get(session)?.turn as string | undefined
    return { conversation: saved?.conversation ?? session, session, ...(turn ? { foregroundTurn: turn } : {}),
      ...(saved?.context ? { context: JSON.parse(saved.context) as MemoryScope } : {}),
      ...(project ? { project: { kind: 'project' as const, id: project } } : {}) }
  }
  function resolveIntakeScope(cwd?: string | null): MemoryProjectResolution {
    return options.hostNamespace === 'viva' ? { status: 'user' } : resolveMemoryProject(cwd)
  }
  function scopeMatches(session: string, scope: MemoryProjectResolution) {
    if (scope.status === 'unknown') return false
    const current = sessionContext(session)
    return !current.context || current.project?.id === (scope.status === 'project' ? scope.project.id : undefined)
  }
  function bindSession(session: string, scope: Exclude<MemoryProjectResolution, { status: 'unknown' }>, task: boolean, conversation?: string) {
    const existing = sessionContext(session)
    const project = scope.status === 'project' ? scope.project : undefined
    const context: MemoryScope = task || existing.context?.kind === 'task' ? { kind: 'task', id: session } : project ?? { kind: 'user' }
    db.prepare(`INSERT INTO owner_sessions VALUES (?,?,?,?) ON CONFLICT(session) DO UPDATE
      SET conversation=excluded.conversation,context=excluded.context,project=excluded.project`)
      .run(session, conversation ?? existing.conversation, JSON.stringify(context), project?.id ?? null)
    return { ...sessionContext(session), project, context }
  }
  function bindIntakeSession(session: string, cwd?: string | null, task = false) {
    requireReady()
    const scope = resolveIntakeScope(cwd)
    if (scope.status === 'unknown' || !scopeMatches(session, scope)) throw new Error('Memory project is unavailable')
    bindSession(session, scope, task)
  }
  function requireReady() { if (state !== 'ready') throw new Error('Memory owner is unavailable') }

  const operation = (id: string) => db.prepare('SELECT * FROM owner_operations WHERE id=?').get(id) as Operation | undefined
  const outcome = (item: Operation): MemoryOperationOutcome => {
    const receipt = item.payload ? JSON.parse(item.payload) as { result?: MemoryFileMutationResult } : null
    const cleaned = item.state === 'completed' && (receipt?.result?.action === 'FORGET'
      ? !runtime.deletedFileCleanupPending(receipt.result.identity) : true)
    return { operationId: item.id, state: item.state, revision: store.revision(),
      cleanup: cleaned ? 'complete' : 'pending' }
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
    const { text, wireText, wireSpans, cwd: _cwd, ...metadata } = input
    return { ...metadata, textHash: hash(text), spans: verifiedWireSpans(wireText, text, wireSpans) }
  }
  function restoreAlias(saved: StoredAlias, wireText: string): MemorySourceAlias & { wireSpans: TextSpan[] } {
    const { textHash, spans, ...metadata } = saved
    const text = originalFromWire(wireText, spans)
    if (hash(text) !== textHash) throw new Error('Source alias wire spans changed')
    return { ...metadata, text, wireText, wireSpans: spans }
  }
  function aliasForWire(session: string, wireHash: string, project?: MemoryProject) {
    const matching = db.prepare('SELECT payload FROM owner_aliases WHERE session=? AND wire_hash=? ORDER BY rowid')
      .all(session, wireHash).map(row => JSON.parse(String(row.payload)) as StoredAlias).filter(alias => alias.project?.id === project?.id)
    const first = matching[0]
    return first && matching.every(alias => alias.sourceId === first.sourceId || alias.origin === 'derived' && first.origin === 'derived') ? first : undefined
  }

  function intakeQuery(session: string, project: MemoryProject | undefined, messages: readonly { id: string, text: string }[]) {
    return messages.flatMap(({ id, text }) => {
      const wireHash = hash(text)
      const known = db.prepare('SELECT source,kind,project,spans FROM owner_messages WHERE session=? AND id=? AND hash=?').get(session, id, wireHash)
      if (known) {
        if (known.project !== (project?.id ?? null)) return []
        if (known.kind === 'derived' && typeof known.spans === 'string') return [originalFromWire(text, JSON.parse(known.spans) as TextSpan[])]
        const source = known.kind === 'original' && store.readSource(String(known.source))
        return source && source.text ? [source.text] : []
      }
      const saved = aliasForWire(session, wireHash, project)
      if (saved) return [restoreAlias(saved, text).text]
      return options.hostNamespace ? [] : [text]
    }).filter(Boolean).join('\n').slice(0, 20_000)
  }

  function alias(input: MemorySourceAlias, assertCurrent: () => void) {
    requireReady()
    const resolved = resolveIntakeScope(input.cwd)
    if (resolved.status === 'unknown' || !scopeMatches(input.session, resolved)) throw new Error('Memory project is unavailable')
    const project = resolved.status === 'project' ? resolved.project : undefined
    const context = input.context?.kind === 'task' ? input.context : project ?? { kind: 'user' as const }
    const normalized = { ...input, project, context }
    const saved = storeAlias(normalized)
    const fingerprint = hash(normalized)
    const source = store.readSource(input.sourceId)
    if (source && (source.conversation !== input.conversation || source.hash !== null && source.hash !== memoryHash(input.text)
      || (source.project?.kind === 'project' ? source.project.id : undefined) !== project?.id)) throw new MemoryDomainError('operation.conflict')
    store.tx(() => {
      assertCurrent()
      const old = db.prepare('SELECT fingerprint FROM owner_aliases WHERE id=?').get(input.operationId)
      if (old && old.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
      bindSession(input.session, resolved, context.kind === 'task', input.conversation)
      db.prepare('INSERT OR IGNORE INTO owner_aliases VALUES (?,?,?,?,?,?)')
        .run(input.operationId, fingerprint, input.session, hash(input.wireText), JSON.stringify(saved), input.sourceId)
    })
    return { sourceId: input.sourceId }
  }

  /** Native log events may be delivered again after a crash. Keep their identity and original scope. */
  function receiveSource(input: ReceivedSource) {
    requireReady()
    const { sessionId: session, messageId: message, text } = input
    const resolved = resolveIntakeScope(input.cwd)
    return store.tx(() => {
      if (input.turn > 0 && input.live !== false && !db.prepare('SELECT 1 FROM owner_turns WHERE session=? AND turn=?').get(session, input.turn)) {
        db.prepare('INSERT INTO owner_active_turns VALUES (?,?) ON CONFLICT(session) DO UPDATE SET turn=excluded.turn').run(session, String(input.turn))
      }
      const wireHash = hash(text)
      const project = resolved.status === 'project' ? resolved.project : undefined
      const known = db.prepare('SELECT session,source,hash,kind,project FROM owner_messages WHERE id=?').get(message)
      if (known && (known.session !== session || known.hash !== wireHash)) throw new Error('Native original identity conflicts')
      const scoped = scopeMatches(session, resolved)
      const saved = !known && scoped ? aliasForWire(session, wireHash, project) : undefined
      const mapped = saved ? restoreAlias(saved, text) : undefined
      const sourceId = known ? String(known.source) : mapped?.sourceId ?? message
      const ignored = !scoped || Boolean(options.hostNamespace && !mapped)
      const kind = known?.kind ?? (ignored ? 'ignored' : mapped?.origin === 'derived' || input.derived ? 'derived' : 'original')
      // The durable session replay gets a second chance to match an authenticated host mapping.
      if (input.live === true && !known && scoped && options.hostNamespace && !mapped) {
        return { sourceId, text: '', handledIntent: true }
      }
      if ((!scoped || kind !== 'original') && input.turn > 0) {
        db.prepare('INSERT OR IGNORE INTO owner_skip_assistant VALUES (?,?)').run(session, input.turn)
      }
      if (!known) {
        if (kind === 'original' && resolved.status !== 'unknown') {
          const origin = bindSession(session, resolved, input.task === true || mapped?.context?.kind === 'task', mapped?.conversation)
          const words = mapped?.text ?? text
          const existing = store.readSource(sourceId)
          if (existing && (existing.conversation !== origin.conversation || existing.hash !== null && existing.hash !== memoryHash(words)
            || (existing.project?.kind === 'project' ? existing.project.id : undefined) !== origin.project?.id)) throw new MemoryDomainError('operation.conflict')
          if (!existing && words.trim()) runtime.accept(words, origin, sourceId, undefined, { deferAutomatic: true, at: input.at, timezone: input.timezone })
        }
        const spans = kind === 'derived' ? mapped?.wireSpans ?? inferUniqueWireSpan(text, text) : undefined
        db.prepare('INSERT INTO owner_messages VALUES (?,?,?,?,?,?,?)')
          .run(message, session, sourceId, wireHash, String(kind), project?.id ?? null, spans ? JSON.stringify(spans) : null)
        if (saved) db.prepare('DELETE FROM owner_aliases WHERE id=?').run(saved.operationId)
      }
      const source = kind === 'original' && scoped && (!known || known.project === (project?.id ?? null))
        ? store.readSource(sourceId) : null
      if (source?.text && input.turn > 0) {
        db.prepare('INSERT OR IGNORE INTO owner_turn_sources VALUES (?,?,?)').run(session, input.turn, sourceId)
      }
      return { sourceId, text: source?.text ?? '', handledIntent: !source?.text }
    })
  }
  function intakeWatermark(session: string) {
    requireReady()
    const cursor = db.prepare('SELECT next_seq FROM memory_session_cursors WHERE session=?').get(session)
    return { createdAt: Number(store.meta('created_at')), nextSeq: cursor ? Number(cursor.next_seq) : null }
  }
  function advanceIntake(session: string, nextSeq: number) {
    requireReady()
    db.prepare(`INSERT INTO memory_session_cursors VALUES (?,?)
      ON CONFLICT(session) DO UPDATE SET next_seq=MAX(next_seq,excluded.next_seq)`).run(session, nextSeq)
  }
  function completeTurn(input: CompletedTurn, signal?: AbortSignal) {
    requireReady()
    signal?.throwIfAborted()
    const { sessionId: session, turn } = input
    if (!db.prepare('SELECT 1 FROM owner_turns WHERE session=? AND turn=?').get(session, turn)) {
      const answers = db.prepare('SELECT source FROM owner_answer_sources WHERE session=? AND turn=?').all(session, String(turn)).map(row => String(row.source))
      const sourceIds = [...new Set([...input.sourceIds, ...answers])]
      if (input.completed) {
        store.tx(() => {
          for (const id of sourceIds) {
            const wasReceived = db.prepare('SELECT 1 FROM owner_turn_sources WHERE session=? AND turn=? AND source=?').get(session, turn, id)
            if (!wasReceived && !answers.includes(id)) throw new Error('Turn source is unavailable')
            const source = store.readSource(id)
            if (source?.outcome === 'received' && source.text) runtime.accept(source.text,
              { conversation: source.conversation, session: source.session, context: source.context ?? undefined, scope: source.scope,
                ...(source.project?.kind === 'project' ? { project: { kind: 'project' as const, id: source.project.id } } : {}) }, source.id,
              source.author === 'answer' && source.question && source.requestId && source.questionId
                ? { question: source.question, requestId: source.requestId, questionId: source.questionId, custom: true } : undefined)
          }
        })
        const skipped = db.prepare('SELECT 1 FROM owner_skip_assistant WHERE session=? AND turn=?').get(session, turn)
        runtime.recordNoteTurn?.(session, sourceIds, skipped ? '' : input.assistant)
      }
      store.tx(() => {
        db.prepare('INSERT INTO owner_turns VALUES (?,?,?,?)').run(session, turn, input.eventSeq, input.completed ? 'completed' : 'cancelled')
        advanceIntake(session, input.eventSeq + 1)
        db.prepare('DELETE FROM owner_skip_assistant WHERE session=? AND turn=?').run(session, turn)
        db.prepare('DELETE FROM owner_turn_sources WHERE session=? AND turn=?').run(session, turn)
        db.prepare('DELETE FROM owner_answer_sources WHERE session=? AND turn=?').run(session, String(turn))
      })
    }
    db.prepare('DELETE FROM owner_active_turns WHERE session=? AND turn=?').run(session, String(turn))
    runtime.finishTurn(session, input.completed)
  }
  function reconcileActiveTurns(turns: readonly { sessionId: string, turn: number }[]) {
    const live = new Map(turns.map(({ sessionId, turn }) => [sessionId, String(turn)]))
    store.tx(() => {
      const retire = db.prepare('DELETE FROM owner_active_turns WHERE session=? AND turn=?')
      for (const row of db.prepare('SELECT session,turn FROM owner_active_turns').all()) {
        if (live.get(String(row.session)) !== row.turn) retire.run(row.session, row.turn)
      }
    })
    void runtime.wake()
  }

  async function recover(preserveActiveTurns: boolean) {
    if (closed) throw new Error('Memory owner is closed')
    if (!preserveActiveTurns) db.prepare('DELETE FROM owner_active_turns').run()
    state = 'ready'
    await replayWrites()
    void runtime.wake()
  }
  async function replayWrites() {
    if (replayingWrites) return
    replayingWrites = true
    try {
      for (const item of db.prepare("SELECT * FROM owner_operations WHERE state='running'").all() as Operation[]) {
        const payload = JSON.parse(item.payload!) as WritePayload | FileWritePayload | ManualFilePending | RememberPayload
        try {
          if ('remember' in payload) await completeRemember(item.id, payload.remember, () => !closed)
          else if ('manual' in payload) await completeManualFile(item.id, payload.manual)
          else if ('standaloneSession' in payload && payload.standaloneSession) await durableFileWrite(payload.command, payload.standaloneSession)
          else await handleHost(payload.command.method, payload.command.input)
        } catch (error) { if (operation(item.id)?.state !== 'failed') throw error }
      }
    } finally { replayingWrites = false }
  }
  type ProfileWriteCommand = Extract<HostMemoryCommand, { method: 'setProfile' }>
  type WritePayload = { command: ProfileWriteCommand }
  async function durableProfileWrite(input: ProfileWriteCommand) {
    const [fields, requestedId] = input.input.args, id = requestedId ?? randomUUID()
    const command: ProfileWriteCommand = { method: 'setProfile', input: { args: [fields, id] } }
    const previous = operation(id), fingerprint = hash(command)
    if (previous && previous.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
    if (previous?.state === 'failed') throw new Error('Memory operation previously failed')
    if (previous?.state === 'completed') return runtime.profile()
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?)").run(id, fingerprint, JSON.stringify({ command }))
    const write = async () => {
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
    }
    return write()
  }
  type FileWriteCommand = Extract<HostMemoryCommand, { method: 'setFileEnabled' | 'undoFile' | 'forgetFile' }>
  type FileWritePayload = { command: FileWriteCommand, standaloneSession?: string }
  type RememberPlan = { session: string, source: DocumentSourceRef }
  type RememberPayload = { remember: RememberPlan }
  async function completeRemember(id: string, plan: RememberPlan, current: () => boolean) {
    try {
      return await runtime.writeSourceFile(id, plan.source, result => {
        db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result }), id)
      }, current, !replayingWrites)
    } catch (error) {
      if (error instanceof MemoryDomainError && error.code !== 'change.pending' && operation(id)?.state !== 'completed') {
        db.prepare("UPDATE owner_operations SET state='failed',payload=NULL WHERE id=?").run(id)
      }
      throw error
    }
  }
  async function rememberSidecarFile(session: string, text: string, signal: AbortSignal) {
    requireReady()
    const origin = sessionContext(session)
    if (!origin.foregroundTurn) return null
    const current = () => !signal.aborted && !closed && sessionContext(session).foregroundTurn === origin.foregroundTurn
    const sources = db.prepare(`SELECT source FROM owner_turn_sources WHERE session=? AND turn=?
      UNION ALL SELECT source FROM owner_answer_sources WHERE session=? AND turn=?`).all(session, Number(origin.foregroundTurn), session, origin.foregroundTurn).map(row => String(row.source))
    const source = runtime.explicitFileSource(text, origin, sources)
    if (!source) return null
    const digest = hash(['remember', session, origin.foregroundTurn, source.id, source.spans])
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    const plan = { session, source }
    const previous = operation(id)
    if (previous?.state === 'completed') return runtime.searchableReceipt((JSON.parse(previous.payload!) as { result: MemoryFileMutationResult }).result)
    if (previous?.state === 'failed') return null
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?)").run(id, hash(plan), JSON.stringify({ remember: plan }))
    return completeRemember(id, plan, current)
  }

  type ManualFileCommand = Extract<HostMemoryCommand, { method: 'createFile' | 'editFile' }>
  type ManualFilePlan = { workspace: string, project?: MemoryProject, context?: MemoryScope }
  type ManualFilePending = { manual: ManualFilePlan }

  async function completeManualFile(id: string, plan: ManualFilePlan, request?: MemoryFileCreateRequest | MemoryFileEditRequest) {
    try {
      const receipt = await runtime.writeManagedFile(id, plan.workspace, request, result => store.tx(() => {
        if (operation(id)?.state === 'completed') return
        db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result }), id)
      }), plan.project, plan.context, !replayingWrites)
      if (receipt) diagnostics.emit({ event: 'state.changed', operation: 'memory.write', stage: 'applied',
        identities: { requestId: id, ownerEpoch: epoch, resourceId: receipt.identity.id, generation: receipt.contentRevision } })
      return receipt
    } catch (error) {
      if (error instanceof MemoryDomainError && error.code !== 'change.pending' && operation(id)?.state !== 'completed') {
        db.prepare("UPDATE owner_operations SET state='failed',payload=? WHERE id=?").run(JSON.stringify({ code: error.code }), id)
      }
      throw error
    }
  }

  async function durableManualFileWrite(command: ManualFileCommand, origin?: Pick<ReturnType<typeof sessionContext>, 'project' | 'context'>) {
    requireReady()
    const project = origin?.project, context = origin?.context ?? project ?? { kind: 'user' as const }
    const request = command.input.args[0], id = request.operationId, fingerprint = hash(origin ? { command, project, context } : command)
    const previous = operation(id)
    if (previous && previous.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
    if (previous?.state === 'completed') {
      diagnostics.emit({ event: 'operation.progress', operation: 'memory.write', stage: 'settled', reason: 'idempotent', identities: { requestId: id, ownerEpoch: epoch } })
      return runtime.searchableReceipt((JSON.parse(previous.payload!) as { result: MemoryFileMutationResult }).result)
    }
    if (previous?.state === 'failed') throw new MemoryDomainError((JSON.parse(previous.payload!) as { code: MemoryDomainErrorCode }).code)
    const plan = previous?.payload ? (JSON.parse(previous.payload) as ManualFilePending).manual : 'identity' in request
      ? { workspace: request.identity.workspace }
      : { workspace: runtime.manualFileWorkspace(project, context), context, ...(project ? { project } : {}) }
    // Keep the draft in the file journal so recovery can validate the expected revision.
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?)")
      .run(id, fingerprint, JSON.stringify({ manual: plan } satisfies ManualFilePending))
    const receipt = await completeManualFile(id, plan, request)
    if (!receipt) throw new Error('Manual memory write missing its receipt')
    return receipt
  }

  /** The durable intent lets a retry recover the file journal result after a process exit. */
  async function durableFileWrite(command: FileWriteCommand, standaloneSession?: string): Promise<MemoryFileMutationResult> {
    requireReady()
    const request = command.input.args[0], id = request.operationId, fingerprint = hash(standaloneSession ? { command, standaloneSession } : command)
    const previous = operation(id)
    if (previous && previous.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
    if (previous?.state === 'completed') {
      diagnostics.emit({ event: 'operation.progress', operation: command.method === 'undoFile' ? 'memory.undo' : command.method === 'forgetFile' ? 'memory.forget' : 'memory.write',
        stage: 'settled', reason: 'idempotent', identities: { requestId: id, ownerEpoch: epoch } })
      return runtime.searchableReceipt((JSON.parse(previous.payload!) as { result: MemoryFileMutationResult }).result)
    }
    if (previous?.state === 'failed') {
      const failure = JSON.parse(previous.payload!) as { code: MemoryDomainErrorCode }
      throw new MemoryDomainError(failure.code)
    }
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?)").run(id, fingerprint,
      JSON.stringify({ command, standaloneSession } satisfies FileWritePayload))
    const committed = (result: MemoryFileMutationResult) => {
      db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result }), id)
    }
    const finishForget = (result: MemoryFileMutationResult) => {
      db.prepare("UPDATE owner_operations SET state='completed',payload=? WHERE id=?").run(JSON.stringify({ result, standaloneSession }), id)
    }
    try {
      const result = command.method === 'setFileEnabled'
        ? await runtime.setFileEnabled(command.input.args[0], committed, !replayingWrites)
        : command.method === 'undoFile' ? await runtime.undoFile(command.input.args[0], committed, !replayingWrites)
          : runtime.forgetFile(command.input.args[0], finishForget)
      diagnostics.emit({ event: 'state.changed', operation: command.method === 'undoFile' ? 'memory.undo' : command.method === 'forgetFile' ? 'memory.forget' : 'memory.write',
        stage: 'applied', identities: { requestId: id, ownerEpoch: epoch, resourceId: result.identity.id, generation: result.contentRevision } })
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
    return durableManualFileWrite({ method: 'createFile', input: { args: [request] } }, origin)
  }
  async function forgetStandaloneFile(session: string, id: string, operationId: string, signal?: AbortSignal): Promise<'complete' | 'pending'> {
    const origin = standaloneFileOrigin(session), previous = operation(operationId)
    if (previous?.state === 'completed') {
      const receipt = JSON.parse(previous.payload!) as { standaloneSession?: string, result: MemoryFileMutationResult }
      if (receipt.standaloneSession !== session || receipt.result.identity.id !== id) throw new MemoryDomainError('operation.conflict')
      return outcome(previous).cleanup ?? 'pending'
    }
    if (previous?.state === 'running') {
      const payload = JSON.parse(previous.payload!) as FileWritePayload
      if (payload.standaloneSession !== session || payload.command.method !== 'forgetFile' || payload.command.input.args[0].identity.id !== id) {
        throw new MemoryDomainError('operation.conflict')
      }
      await durableFileWrite(payload.command, session)
    } else {
      const target = await runtime.fileForSession(id, origin, signal)
      signal?.throwIfAborted()
      // An identical concurrent forget can finish while this caller verifies the file.
      if (!target && ['running', 'completed'].includes(operation(operationId)?.state ?? '')) return forgetStandaloneFile(session, id, operationId, signal)
      if (!target) throw new MemoryDomainError('not.found')
      const request = memoryFileForgetRequest.parse({ ...target, operationId })
      await durableFileWrite({ method: 'forgetFile', input: { args: [request] } }, session)
    }
    const item = operation(operationId)
    return item?.state === 'completed' && outcome(item).cleanup === 'complete' ? 'complete' as const : 'pending' as const
  }
  function handleHost(method: unknown, input: unknown, signal?: AbortSignal, deadlineAt?: number): Promise<unknown> {
    try {
    const command = parseHostMemoryCommand(method, input)
    const kind = hostDiagnosticOperation(command.method)
    if (!kind) return executeHost(command, signal, deadlineAt)
    const raw = 'args' in command.input ? command.input.args[0] : command.input
    const requestId = raw !== null && typeof raw === 'object' && 'operationId' in raw && typeof raw.operationId === 'string'
      ? raw.operationId : command.method === 'setProfile' ? command.input.args[1] : undefined
    return observeDiagnosticAsync(options.diagnostics, kind, () => executeHost(command, signal, deadlineAt), {
      identities: { methodId: command.method, ownerEpoch: epoch, ...(requestId ? { requestId } : {}) },
    })
    } catch (error) { return Promise.reject(error) }
  }
  async function executeHost(command: HostMemoryCommand, signal?: AbortSignal, deadlineAt?: number): Promise<unknown> {
    const assertIntakeCurrent = () => {
      signal?.throwIfAborted()
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new RequestTimeout()
    }
    switch (command.method) {
      case 'getOperation': { const item = operation(command.input.operationId); return item ? outcome(item) : null }
      case 'sourceAlias': return alias(command.input, assertIntakeCurrent)
    }
    requireReady()
    switch (command.method) {
      case 'acceptQuestionAnswer': {
        const input = command.input, sourceId = input.operationId
        const existing = store.readSource(sourceId)
        if (existing) {
          if (existing.hash !== memoryHash(input.text) || existing.author !== 'answer' || existing.questionId !== input.questionId
            || existing.requestId !== input.requestId || existing.conversation !== input.conversation) throw new Error('Answer operation identity conflicts')
          return { sourceId }
        }
        const { session, turn } = input
        const context = sessionContext(session)
        if (context.conversation !== input.conversation || context.project?.id !== input.project?.id
          || db.prepare('SELECT 1 FROM owner_turns WHERE session=? AND turn=?').get(session, turn)) throw new Error('Answer context is unavailable')
        const question = input.cards.find(card => card.id === input.questionId)
        if (!question || input.cards.some(card => [card.question, card.header,
          ...card.options.flatMap(option => [option.label, option.description ?? ''])].some(looksSecret))) {
          throw new Error('Question cannot be retained')
        }
        store.tx(() => {
          assertIntakeCurrent()
          runtime.accept(input.text, { ...context, context: input.context }, sourceId,
            { question: question.question, requestId: input.requestId, questionId: input.questionId, custom: true },
            { deferAutomatic: true, at: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          if (!runtime.sourceCurrent(sourceId)) throw new Error('Answer cannot be retained')
          db.prepare('INSERT INTO owner_answer_sources VALUES (?,?,?)').run(session, String(turn), sourceId)
        })
        return { sourceId }
      }
      case 'profile': return runtime.profile(...command.input.args)
      case 'revision': return runtime.revision(...command.input.args)
      case 'epoch': return runtime.epoch(...command.input.args)
      case 'cleanupPending': return runtime.cleanupPending()
      case 'profilePage': {
        const fileProfile = await runtime.fileProfileAsync(command.input.args[0], signal)
        return { profile: runtime.profile(), onboarding: runtime.onboarding(), cleanupPending: runtime.cleanupPending(),
          revision: runtime.revision(), fileProfile }
      }
      case 'onboarding': return runtime.onboarding(...command.input.args)
      case 'dreamStatus': return runtime.dreamStatus(...command.input.args)
      case 'requestDream': return runtime.requestDream(...command.input.args)
      case 'listFiles': return runtime.listFilesAsync(command.input.args[0], signal)
      case 'readFile': return runtime.readFileAsync(command.input.args[0], signal)
      case 'fileProfile': return runtime.fileProfileAsync(command.input.args[0], signal)
      case 'createFile':
      case 'editFile': return durableManualFileWrite(command)
      case 'setFileEnabled':
      case 'forgetFile':
      case 'undoFile': return durableFileWrite(command)
      case 'setOnboarding': return runtime.setOnboarding(...command.input.args)
      case 'rebuildIndexes': return runtime.rebuildIndexes(...command.input.args)
      case 'setProfile': return durableProfileWrite(command)
    }
    throw new Error('Unsupported host operation')
  }
  const tempCleanup = new AbortController()
  void removeAbandonedMemoryTemps(store.fileRoot, tempCleanup.signal)
  return { runtime, bindIntakeSession, resolveIntakeScope, scopeMatches, intakeWatermark, advanceIntake, rememberSidecarFile, epoch, ready: () => state === 'ready' && !replayingWrites, status: () => state === 'ready' && replayingWrites ? 'recovering' as const : state,
    recover: (preserveActiveTurns = false) => observeDiagnosticAsync(options.diagnostics, 'memory.recover', () => recover(preserveActiveTurns), { stage: 'recovering', identities: { ownerEpoch: epoch } }),
    receiveSource: (input: ReceivedSource) => observeDiagnosticAsync(options.diagnostics, 'memory.intake', async () => receiveSource(input), {
      stage: 'received', identities: { sessionId: input.sessionId, requestId: input.messageId, generation: input.turn }, metrics: { count: 1, ok: true } }),
    completeTurn: (input: CompletedTurn, signal?: AbortSignal) => observeDiagnosticAsync(options.diagnostics, 'memory.daily', async () => completeTurn(input, signal), {
      stage: 'checkpoint', identities: { sessionId: input.sessionId, generation: input.turn }, metrics: { eventCursor: input.eventSeq, count: input.sourceIds.length, ok: input.completed } }),
    sessionContext, handleHost, reconcileActiveTurns, intakeQuery,
    rememberStandaloneFile: (...args: Parameters<typeof rememberStandaloneFile>) => observeDiagnosticAsync(options.diagnostics, 'memory.write', () => rememberStandaloneFile(...args), {
      identities: { sessionId: args[0], requestId: args[1].operationId } }),
    forgetStandaloneFile: (...args: Parameters<typeof forgetStandaloneFile>) => observeDiagnosticAsync(options.diagnostics, 'memory.forget', () => forgetStandaloneFile(...args), {
      identities: { sessionId: args[0], resourceId: args[1], requestId: args[2] } }),
    async close() {
      if (closed) return
      closed = true; state = 'unavailable'
      tempCleanup.abort()
      try { runtime.close() } finally { lock.close() }
    },
  }
}
