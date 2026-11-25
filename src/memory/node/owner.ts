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
import type { HostMemoryCommand, MemoryOwnerContextUsed, MemoryProject } from '../contracts/host.ts'
import type { MemoryOperationOutcome } from '../contracts/service.ts'
import type { MemoryFileMutationResult, MemoryFileCreateRequest, MemoryFileEditRequest } from '../contracts/file-management.ts'
import { memoryFileCreateRequest, memoryFileForgetRequest } from '../contracts/file-management.ts'
import { parseMemoryDomainErrorDetails, type MemoryDomainErrorCode } from '../contracts/domain-error.ts'
import type { MemoryScope } from '../contracts/memory-contract.ts'
import type { MemorySessionKind as SessionKind, MemorySource, MemorySourceKind } from '../contracts/records.ts'

export type TurnSourceCandidate = {
  sourceId: string
  author: 'user' | 'answer' | 'agent' | 'assistant'
  sourceKind: MemorySourceKind
  profileEligible: boolean
  text: string
  conversation?: string | null
  at: number
  timezone: string
}

export type AdvanceIntakeCursorInput = {
  sessionId: string
  expectedNextSeq: number | null
  nextSeq: number
  inheritedSeq?: number
  sessionKind?: SessionKind
  conversation?: string | null
  cwd?: string | null
}

export type BeginTurnInput = {
  sessionId: string
  turn: number
  sessionKind?: SessionKind
  conversation?: string | null
  cwd?: string | null
}

export type StageOpenTurnInput = {
  sessionId: string
  turn: number
  sessionKind: SessionKind
  conversation?: string | null
  cwd?: string | null
  sources: readonly TurnSourceCandidate[]
}

export type SettleTurnInput = {
  sessionId: string
  cwd?: string | null
  sessionKind: SessionKind
  conversation?: string | null
  inheritedSeq: number
  expectedNextSeq: number | null
  fromSeq: number
  toSeq: number
  turn: number
  reasonKind: string
  sources: readonly TurnSourceCandidate[]
  assistantText: string
  at: number
  timezone: string
  flushNotes?: boolean
}

export type CursorResult = { status: 'ok' | 'duplicate' | 'cas_mismatch' | 'scope_unavailable', nextSeq: number }

type Options = Pick<NodeMemoryRuntimeOptions, 'compute' | 'route' | 'readSessionRange'> & {
  diagnostics?: DiagnosticPort
  now?: () => number
  root: string
  hostNamespace?: string
  dailyNotes?: NodeMemoryRuntimeOptions['dailyNotes']
  embedding?: { modelRoot: string, runtimeRoot?: string }
  onChange?: NodeMemoryRuntimeOptions['changed']
  onContextUsed?: (notice: Omit<MemoryOwnerContextUsed, 'type' | 'protocol' | 'epoch'>) => void
}
type SessionRow = { conversation: string, context: string | null, project: string | null }
type CursorRow = { session: string, next_seq: number, inherited_seq: number, session_kind: string, conversation: string | null, created_at: number, updated_at: number }
type Operation = { id: string, fingerprint: string, state: MemoryOperationOutcome['state'], payload: string | null }

/** Protocol operations only. This classification has no role in facts, conflicts or admission. */
function hostDiagnosticOperation(method: HostMemoryCommand['method']): DiagnosticOperation | undefined {
  switch (method) {
    case 'forgetFile': return 'memory.forget'
    case 'createFile': case 'editFile': case 'setFileEnabled': case 'getOperation': return 'memory.write'
    case 'undoFile': return 'memory.undo'
    case 'rebuildIndexes': return 'memory.index'
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
  const now = options.now ?? Date.now
  const boundHost = store.meta('owner.host')
  if (boundHost && boundHost !== options.hostNamespace) throw Object.assign(new Error('Memory root belongs to a different host binding'), { code: 'denied' })
  if (options.hostNamespace && !boundHost) store.setMeta('owner.host', options.hostNamespace)
  const hash = (value: unknown) => createHmac('sha256', store.meta('secret')!).update(JSON.stringify(value)).digest('hex')
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_active_turns(session TEXT PRIMARY KEY,turn TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_answer_sources(session TEXT NOT NULL,turn TEXT NOT NULL,source TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS owner_sessions(session TEXT PRIMARY KEY,conversation TEXT NOT NULL,context TEXT,project TEXT);
    CREATE TABLE IF NOT EXISTS owner_intake_cursors(
      session TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL,
      inherited_seq INTEGER NOT NULL DEFAULT 0,
      session_kind TEXT NOT NULL DEFAULT 'main',
      conversation TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_open_turn_sources(
      session TEXT NOT NULL,
      turn INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY(session, turn, source_id)
    );
    CREATE TABLE IF NOT EXISTS owner_operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,payload TEXT);
  `)
  const epoch = randomUUID()
  let state: 'recovering' | 'ready' | 'unavailable' = 'recovering'
  let closed = false
  let replayingWrites = false
  const runtime = createMemoryRuntime({
    store,
    compute: options.compute,
    route: options.route,
    readSessionRange: options.readSessionRange,
    diagnostics: options.diagnostics,
    ...(options.now ? { now: options.now } : {}),
    dailyNotes: options.dailyNotes ?? true,
    ...(options.embedding ? { embedder: createMemoryEmbedder(options.embedding) } : {}),
    changed: change => { options.onChange?.(change) },
    injected: (session, turn, pushed) => options.onContextUsed?.({
      session, turn, pushed, revision: store.revision(),
      conversation: sessionContext(session).conversation ?? null, at: Date.now(),
    }),
    canCommit: source => state === 'ready' && (!source.session || !db.prepare('SELECT 1 FROM owner_active_turns WHERE session=?').get(source.session)),
  })

  function sessionContext(session: string) {
    const saved = db.prepare('SELECT * FROM owner_sessions WHERE session=?').get(session) as SessionRow | undefined
    const project = saved?.project
    const turn = db.prepare('SELECT turn FROM owner_active_turns WHERE session=?').get(session)?.turn as string | undefined
    return {
      conversation: saved?.conversation ?? session,
      session,
      ...(turn ? { foregroundTurn: turn } : {}),
      ...(saved?.context ? { context: JSON.parse(saved.context) as MemoryScope } : {}),
      ...(project ? { project: { kind: 'project' as const, id: project } } : {}),
    }
  }
  function resolveIntakeScope(cwd?: string | null): MemoryProjectResolution {
    return options.hostNamespace === 'viva' ? { status: 'user' } : resolveMemoryProject(cwd)
  }
  function scopeMatches(session: string, scope: MemoryProjectResolution) {
    if (scope.status === 'unknown') return false
    const current = sessionContext(session)
    return !current.context || current.project?.id === (scope.status === 'project' ? scope.project.id : undefined)
  }
  function bindSession(session: string, scope: Exclude<MemoryProjectResolution, { status: 'unknown' }>, conversation?: string | null) {
    const existing = sessionContext(session)
    const project = scope.status === 'project' ? scope.project : undefined
    // Global userWorkspace for Viva main & background-task sessions (§5.4 item 4); project isolation for standalone DSH.
    const context: MemoryScope = project ?? { kind: 'user' }
    const effectiveConversation = conversation && conversation.length > 0 ? conversation : existing.conversation
    db.prepare(`INSERT INTO owner_sessions VALUES (?,?,?,?) ON CONFLICT(session) DO UPDATE
      SET conversation=excluded.conversation,context=excluded.context,project=excluded.project`)
      .run(session, effectiveConversation, JSON.stringify(context), project?.id ?? null)
    return { ...sessionContext(session), project, context }
  }
  function bindIntakeSession(session: string, cwd?: string | null) {
    requireReady()
    const scope = resolveIntakeScope(cwd)
    if (scope.status === 'unknown' || !scopeMatches(session, scope)) throw new Error('Memory project is unavailable')
    bindSession(session, scope)
  }
  function requireReady() { if (state !== 'ready') throw new Error('Memory owner is unavailable') }

  const operation = (id: string) => db.prepare('SELECT * FROM owner_operations WHERE id=?').get(id) as Operation | undefined
  const outcome = (item: Operation): MemoryOperationOutcome => {
    const receipt = item.payload ? JSON.parse(item.payload) as { result?: MemoryFileMutationResult } : null
    const cleaned = item.state === 'completed' && (receipt?.result?.action === 'FORGET'
      ? !runtime.deletedFileCleanupPending(receipt.result.identity) : true)
    return { operationId: item.id, state: item.state, revision: store.revision(), cleanup: cleaned ? 'complete' : 'pending' }
  }

  function intakeCursor(session: string) {
    requireReady()
    const row = db.prepare('SELECT * FROM owner_intake_cursors WHERE session=?').get(session) as CursorRow | undefined
    return {
      createdAt: Number(store.meta('created_at')),
      nextSeq: row ? Number(row.next_seq) : null,
      inheritedSeq: row ? Number(row.inherited_seq) : 0,
      sessionKind: (row?.session_kind ?? 'main') as SessionKind,
      conversation: row?.conversation ?? null,
    }
  }

  function advanceIntakeCursor(input: AdvanceIntakeCursorInput): CursorResult {
    requireReady()
    const { sessionId: session, expectedNextSeq, nextSeq, inheritedSeq = 0, sessionKind = 'main', conversation = null, cwd } = input
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 0) throw new Error('Invalid intake cursor offset')
    return store.tx(() => {
      const existing = db.prepare('SELECT * FROM owner_intake_cursors WHERE session=?').get(session) as CursorRow | undefined
      if (existing) {
        if (expectedNextSeq !== existing.next_seq) {
          return { status: nextSeq <= existing.next_seq ? 'duplicate' as const : 'cas_mismatch' as const, nextSeq: existing.next_seq }
        }
        if (nextSeq < existing.next_seq) return { status: 'duplicate' as const, nextSeq: existing.next_seq }
      } else {
        if (expectedNextSeq !== null) {
          return { status: 'cas_mismatch' as const, nextSeq: 0 }
        }
      }
      const ts = now()
      const finalKind = existing && sessionKind === 'main' && existing.session_kind !== 'main'
        ? existing.session_kind : sessionKind
      const finalConv = conversation ?? existing?.conversation ?? null
      db.prepare(`INSERT INTO owner_intake_cursors(session, next_seq, inherited_seq, session_kind, conversation, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(session) DO UPDATE SET
          next_seq=excluded.next_seq,
          inherited_seq=MAX(owner_intake_cursors.inherited_seq, excluded.inherited_seq),
          session_kind=excluded.session_kind,
          conversation=COALESCE(excluded.conversation, owner_intake_cursors.conversation),
          updated_at=excluded.updated_at`).run(
        session, nextSeq, inheritedSeq, finalKind, finalConv, existing?.created_at ?? ts, ts,
      )
      if (finalKind !== 'unattended' && finalConv) {
        const resolved = resolveIntakeScope(cwd)
        if (resolved.status !== 'unknown' && scopeMatches(session, resolved)) {
          bindSession(session, resolved, finalConv)
        }
      }
      return { status: 'ok' as const, nextSeq }
    })
  }

  function beginTurn(input: BeginTurnInput) {
    requireReady()
    const { sessionId: session, turn, sessionKind = 'main', conversation = null, cwd } = input
    store.tx(() => {
      if (turn > 0) {
        db.prepare('INSERT INTO owner_active_turns VALUES (?,?) ON CONFLICT(session) DO UPDATE SET turn=excluded.turn')
          .run(session, String(turn))
      }
      if (sessionKind !== 'unattended') {
        const resolved = resolveIntakeScope(cwd)
        if (resolved.status !== 'unknown' && scopeMatches(session, resolved)) {
          bindSession(session, resolved, conversation)
        }
      }
    })
  }

  function resolveCandidateOrigin(
    session: string,
    bound: ReturnType<typeof bindSession>,
    candidate: TurnSourceCandidate,
  ) {
    const project = bound.project
    const isStandaloneProject = !options.hostNamespace && project !== undefined
    const sourceKind: MemorySourceKind = isStandaloneProject && candidate.author === 'user'
      ? 'project-user'
      : candidate.sourceKind
    const profileEligible = isStandaloneProject
      ? false
      : (candidate.author === 'user' || candidate.author === 'answer') && candidate.profileEligible
    return {
      conversation: candidate.conversation ?? bound.conversation,
      session,
      scope: { kind: 'user' as const },
      context: project ?? { kind: 'user' as const },
      ...(project ? { project } : {}),
      author: candidate.author,
      sourceKind,
      profileEligible,
    }
  }

  function stageOpenTurnSources(input: StageOpenTurnInput): { staged: string[] } {
    requireReady()
    const { sessionId: session, turn, sessionKind, conversation, cwd, sources } = input
    if (sessionKind === 'unattended' || turn <= 0) return { staged: [] }
    const resolved = resolveIntakeScope(cwd)
    if (resolved.status === 'unknown' || !scopeMatches(session, resolved)) return { staged: [] }
    return store.tx(() => {
      db.prepare('INSERT INTO owner_active_turns VALUES (?,?) ON CONFLICT(session) DO UPDATE SET turn=excluded.turn')
        .run(session, String(turn))
      const bound = bindSession(session, resolved, conversation)
      const staged: string[] = []
      for (const candidate of sources) {
        // Only verified persisted human user/answer sources may enter open-turn staging (§5.6).
        if (candidate.author !== 'user' && candidate.author !== 'answer') continue
        if (!candidate.text.trim()) continue
        const origin = resolveCandidateOrigin(session, bound, candidate)
        const expectedHash = memoryHash(candidate.text)
        const existing = store.readSource(candidate.sourceId)
        if (existing) {
          if (existing.session !== session
            || existing.conversation !== origin.conversation
            || existing.author !== origin.author
            || existing.hash !== expectedHash
            || existing.text !== candidate.text) {
            continue
          }
        } else {
          runtime.accept(candidate.text, origin, candidate.sourceId, undefined, {
            deferAutomatic: true, at: candidate.at, timezone: candidate.timezone,
          })
        }
        const saved = store.readSource(candidate.sourceId)
        if (saved?.text
          && saved.session === session
          && saved.conversation === origin.conversation
          && saved.author === origin.author
          && saved.hash === expectedHash
          && saved.text === candidate.text) {
          db.prepare('INSERT OR IGNORE INTO owner_open_turn_sources(session, turn, source_id) VALUES (?,?,?)')
            .run(session, turn, saved.id)
          staged.push(saved.id)
        }
      }
      return { staged }
    })
  }

  function settleTurn(input: SettleTurnInput, signal?: AbortSignal): CursorResult {
    requireReady()
    signal?.throwIfAborted()
    const { sessionId: session, cwd, sessionKind, conversation, inheritedSeq, expectedNextSeq, fromSeq, toSeq, turn, reasonKind, sources, assistantText, flushNotes } = input
    if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq < 0 || toSeq <= fromSeq) {
      throw new Error('Invalid turn range')
    }
    const result = store.tx(() => {
      const existingCursor = db.prepare('SELECT * FROM owner_intake_cursors WHERE session=?').get(session) as CursorRow | undefined
      if (runtime.hasNoteRange?.(session, fromSeq, toSeq)) {
        return { status: 'duplicate' as const, nextSeq: existingCursor?.next_seq ?? toSeq }
      }
      if (existingCursor) {
        if (expectedNextSeq === null || existingCursor.next_seq !== expectedNextSeq || fromSeq !== existingCursor.next_seq) {
          return { status: 'cas_mismatch' as const, nextSeq: existingCursor.next_seq }
        }
      } else {
        if (expectedNextSeq !== null || fromSeq !== inheritedSeq) {
          return { status: 'cas_mismatch' as const, nextSeq: 0 }
        }
      }
      const answers = db.prepare('SELECT source FROM owner_answer_sources WHERE session=? AND turn=?')
        .all(session, String(turn)).map(row => String(row.source))
      const effectiveKind: SessionKind = existingCursor && sessionKind === 'main' && existingCursor.session_kind !== 'main'
        ? existingCursor.session_kind as SessionKind : sessionKind
      const effectiveConv = conversation ?? existingCursor?.conversation ?? null

      // Terminal-reason gating (§5.2 item 2): ONLY 'completed' turns upsert canonical sources & note ranges.
      if (reasonKind === 'completed' && effectiveKind !== 'unattended') {
        const resolved = resolveIntakeScope(cwd)
        if (resolved.status === 'unknown') {
          // Temporarily unavailable project directory: leave cursor untouched so replay retries cleanly.
          return { status: 'scope_unavailable' as const, nextSeq: existingCursor?.next_seq ?? fromSeq }
        }
        if (scopeMatches(session, resolved)) {
          const bound = bindSession(session, resolved, effectiveConv)
          const admittedIds: string[] = []
          for (const candidate of sources) {
            if (!candidate.text.trim()) continue
            const origin = resolveCandidateOrigin(session, bound, candidate)
            const receipt = runtime.accept(candidate.text, origin, candidate.sourceId, undefined, {
              deferAutomatic: false, at: candidate.at, timezone: candidate.timezone,
            })
            const saved = store.readSource(receipt.sourceId)
            if (saved?.text) admittedIds.push(saved.id)
          }
          for (const answerId of answers) {
            const saved = store.readSource(answerId)
            if (saved?.text) {
              if (saved.outcome === 'received') {
                runtime.accept(saved.text, {
                  conversation: saved.conversation,
                  session: saved.session,
                  context: saved.context ?? undefined,
                  scope: saved.scope,
                  ...(saved.project?.kind === 'project' ? { project: { kind: 'project' as const, id: saved.project.id } } : {}),
                  author: 'answer',
                  sourceKind: saved.sourceKind,
                  profileEligible: saved.profileEligible,
                }, saved.id, saved.question && saved.requestId && saved.questionId
                  ? { question: saved.question, requestId: saved.requestId, questionId: saved.questionId, custom: true,
                    ...(saved.questionAt != null ? { questionAt: saved.questionAt } : {}),
                    ...(saved.questionProfileGen != null ? { questionProfileGen: saved.questionProfileGen } : {}) }
                  : undefined)
              }
              admittedIds.push(saved.id)
            }
          }
          const uniqueAdmitted = [...new Set(admittedIds)]
          if (uniqueAdmitted.length > 0) {
            runtime.recordNoteRangeInTx?.({
              session, fromSeq, toSeq, turn, ids: uniqueAdmitted,
              assistant: assistantText,
              flush: flushNotes === true || effectiveKind === 'task',
            })
          }
        }
      }

      // On ANY terminal turn/end (completed, aborted, interrupted, error): clear open-turn staging & advance cursor.
      db.prepare('DELETE FROM owner_open_turn_sources WHERE session=? AND turn=?').run(session, turn)
      db.prepare('DELETE FROM owner_answer_sources WHERE session=? AND turn=?').run(session, String(turn))
      db.prepare('DELETE FROM owner_active_turns WHERE session=? AND turn=?').run(session, String(turn))
      const ts = now()
      db.prepare(`INSERT INTO owner_intake_cursors(session, next_seq, inherited_seq, session_kind, conversation, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(session) DO UPDATE SET
          next_seq=excluded.next_seq,
          inherited_seq=MAX(owner_intake_cursors.inherited_seq, excluded.inherited_seq),
          session_kind=excluded.session_kind,
          conversation=COALESCE(excluded.conversation, owner_intake_cursors.conversation),
          updated_at=excluded.updated_at`).run(
        session, toSeq, inheritedSeq, effectiveKind, effectiveConv, existingCursor?.created_at ?? ts, ts,
      )
      return { status: 'ok' as const, nextSeq: toSeq }
    })
    if (result.status === 'ok') runtime.finishTurn(session, reasonKind === 'completed')
    return result
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
        const payload = JSON.parse(item.payload!) as FileWritePayload | ManualFilePending | RememberPayload
        try {
          if ('remember' in payload) await completeRemember(item.id, payload.remember, () => !closed)
          else if ('manual' in payload) await completeManualFile(item.id, payload.manual)
          else if ('standaloneSession' in payload && payload.standaloneSession) await durableFileWrite(payload.command, payload.standaloneSession)
          else await handleHost(payload.command.method, payload.command.input)
        } catch (error) { if (operation(item.id)?.state !== 'failed') throw error }
      }
    } finally { replayingWrites = false }
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
    const sources = db.prepare(`SELECT source_id AS source FROM owner_open_turn_sources WHERE session=? AND turn=?
      UNION ALL SELECT source FROM owner_answer_sources WHERE session=? AND turn=?`)
      .all(session, Number(origin.foregroundTurn), session, origin.foregroundTurn)
      .map(row => String(row.source))
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
        db.prepare("UPDATE owner_operations SET state='failed',payload=? WHERE id=?").run(
          JSON.stringify({ code: error.code, ...(error.details ? { details: error.details } : {}) }), id,
        )
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
    if (previous?.state === 'failed') {
      const failure = JSON.parse(previous.payload!) as { code: MemoryDomainErrorCode, details?: unknown }
      throw new MemoryDomainError(failure.code, undefined, parseMemoryDomainErrorDetails(failure.details))
    }
    const plan = previous?.payload ? (JSON.parse(previous.payload) as ManualFilePending).manual : 'identity' in request
      ? { workspace: request.identity.workspace }
      : { workspace: runtime.manualFileWorkspace(project, context), context, ...(project ? { project } : {}) }
    if (!previous) db.prepare("INSERT INTO owner_operations VALUES (?,?,'running',?)")
      .run(id, fingerprint, JSON.stringify({ manual: plan } satisfies ManualFilePending))
    const receipt = await completeManualFile(id, plan, request)
    if (!receipt) throw new Error('Manual memory write missing its receipt')
    return receipt
  }

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
        ? raw.operationId : undefined
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
    }
    requireReady()
    switch (command.method) {
      case 'acceptQuestionAnswer': {
        const input = command.input, sourceId = input.operationId
        const existing = store.readSource(sourceId)
        if (existing) {
          if (existing.hash !== memoryHash(input.text) || existing.author !== 'answer' || existing.questionId !== input.questionId
            || existing.requestId !== input.requestId || existing.conversation !== input.conversation) {
            throw new MemoryDomainError('operation.conflict', 'Answer operation identity conflicts')
          }
          return { sourceId }
        }
        const { session, turn } = input
        const context = sessionContext(session)
        const activeTurn = db.prepare('SELECT turn FROM owner_active_turns WHERE session=?').get(session) as { turn: string } | undefined
        if (context.conversation !== input.conversation || context.project?.id !== input.project?.id
          || !activeTurn || activeTurn.turn !== String(turn)
          || db.prepare('SELECT 1 FROM memory_note_ranges WHERE session=? AND turn=?').get(session, turn)) {
          throw new MemoryDomainError('not.found', 'Answer context is unavailable')
        }
        const question = input.cards.find(card => card.id === input.questionId)
        if (!question || input.cards.some(card => [card.question, card.header,
          ...card.options.flatMap(option => [option.label, option.description ?? ''])].some(looksSecret))) {
          throw new MemoryDomainError('credentials', 'Question cannot be retained')
        }
        store.tx(() => {
          assertIntakeCurrent()
          const isHostTaskAnswer = Boolean(options.hostNamespace) && input.context?.kind === 'task'
          const answerOrigin = isHostTaskAnswer
            ? { ...context, context: { kind: 'user' as const }, sourceKind: 'task-question-answer' as const, profileEligible: true }
            : { ...context, context: input.context }
          runtime.accept(input.text, answerOrigin, sourceId,
            { question: question.question, requestId: input.requestId, questionId: input.questionId, custom: true,
              ...(input.questionAt !== undefined ? { questionAt: input.questionAt } : {}),
              ...(input.questionProfileGen !== undefined ? { questionProfileGen: input.questionProfileGen } : {}) },
            { deferAutomatic: true, at: now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          if (!runtime.sourceCurrent(sourceId)) throw new MemoryDomainError('credentials', 'Answer cannot be retained')
          db.prepare('INSERT INTO owner_answer_sources VALUES (?,?,?)').run(session, String(turn), sourceId)
        })
        return { sourceId }
      }
      case 'revision': return runtime.revision(...command.input.args)
      case 'epoch': return runtime.epoch(...command.input.args)
      case 'cleanupPending': return runtime.cleanupPending()
      case 'profilePage': {
        return { cleanupPending: runtime.cleanupPending(), revision: runtime.revision(), residentProfile: runtime.residentProfileIdentity() }
      }
      case 'dreamStatus': return runtime.dreamStatus(...command.input.args)
      case 'requestDream': return runtime.requestDream(...command.input.args)
      case 'listFiles': return runtime.listFilesAsync(command.input.args[0], signal)
      case 'readFile': return runtime.readFileAsync(command.input.args[0], signal)
      case 'createFile':
      case 'editFile': return durableManualFileWrite(command)
      case 'setFileEnabled':
      case 'forgetFile':
      case 'undoFile': return durableFileWrite(command)
      case 'rebuildIndexes': return runtime.rebuildIndexes(...command.input.args)
    }
    throw new Error('Unsupported host operation')
  }
  function reportContextUsed(input: { session: string, turn: number, pushed: Array<{ text: string, names: string[] }> }) {
    if (closed || !input.pushed.length) return
    options.onContextUsed?.({
      session: input.session,
      turn: input.turn,
      pushed: input.pushed,
      revision: store.revision(),
      conversation: sessionContext(input.session).conversation ?? null,
      at: Date.now(),
    })
  }
  function profileSnapshot() {
    return { epoch, revision: store.revision(), text: runtime.residentProfileText() }
  }
  const tempCleanup = new AbortController()
  void removeAbandonedMemoryTemps(store.fileRoot, tempCleanup.signal)
  return {
    runtime,
    bindIntakeSession,
    resolveIntakeScope,
    scopeMatches,
    intakeCursor,
    advanceIntakeCursor,
    beginTurn,
    stageOpenTurnSources,
    rememberSidecarFile,
    epoch,
    ready: () => state === 'ready' && !replayingWrites,
    status: () => state === 'ready' && replayingWrites ? 'recovering' as const : state,
    reportContextUsed,
    profileSnapshot,
    recover: (preserveActiveTurns = false) => observeDiagnosticAsync(options.diagnostics, 'memory.recover', () => recover(preserveActiveTurns), { stage: 'recovering', identities: { ownerEpoch: epoch } }),
    settleTurn: (input: SettleTurnInput, signal?: AbortSignal) => observeDiagnosticAsync(options.diagnostics, 'memory.daily', async () => settleTurn(input, signal), {
      stage: 'checkpoint', identities: { sessionId: input.sessionId, generation: input.turn }, metrics: { eventCursor: input.toSeq, count: input.sources.length, ok: input.reasonKind === 'completed' },
    }),
    sessionContext,
    handleHost,
    reconcileActiveTurns,
    rememberStandaloneFile: (...args: Parameters<typeof rememberStandaloneFile>) => observeDiagnosticAsync(options.diagnostics, 'memory.write', () => rememberStandaloneFile(...args), {
      identities: { sessionId: args[0], requestId: args[1].operationId },
    }),
    forgetStandaloneFile: (...args: Parameters<typeof forgetStandaloneFile>) => observeDiagnosticAsync(options.diagnostics, 'memory.forget', () => forgetStandaloneFile(...args), {
      identities: { sessionId: args[0], resourceId: args[1], requestId: args[2] },
    }),
    async close() {
      if (closed) return
      closed = true; state = 'unavailable'
      tempCleanup.abort()
      try { runtime.close() } finally { lock.close() }
    },
  }
}
