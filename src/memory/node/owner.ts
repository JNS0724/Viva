import { RequestTimeout } from '../../shared/request-budget.ts'
import type { DiagnosticOperation, DiagnosticPort } from '../../diagnostics/contracts.ts'
import { guardDiagnosticPort } from '../../diagnostics/contracts.ts'
import { observeDiagnosticAsync } from '../../diagnostics/operation.ts'
import { removeAbandonedMemoryTemps } from './memory-file-store.ts'
import { resolveMemoryProject, type MemoryProjectResolution } from './project-scope.ts'
import path from 'node:path'
import { createHash, createHmac, randomUUID } from 'node:crypto'
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
import {
  canonicalEligibleAnswersDigest,
  canonicalEligibleSelectionsDigest,
  hasUnsupportedSqliteChars,
} from './question-answer-memory.ts'

function deterministicOccurrenceUuid(session: string, sourceId: string, extra?: string): string {
  const parts = extra !== undefined ? ['occurrence', session, extra, sourceId] : ['occurrence', session, sourceId]
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

export type TurnSourceCandidate = {
  sourceId: string
  author: 'user' | 'answer' | 'agent' | 'assistant'
  sourceKind: MemorySourceKind
  profileEligible: boolean
  text: string
  conversation?: string | null
  eventSeq?: number
  at: number
  timezone: string
}

export type QuestionReceiptInput = {
  sessionId: string
  turn: number
  callSeq: number
  callIdHash: string
  conversationId: string
  answeredAt: number
  questionProfileGen: number | null
  answerProfileGen: number | null
  answerBatchDigest: string
  selectionBatchDigest?: string | null
}

export type TurnQuestionAnswerItem = {
  sourceId: string
  questionId: string
  question: string
  text: string
}

export type TurnQuestionSelectionItem = {
  sourceId: string
  questionId: string
  question: string
  selected: readonly string[]
  text: string
}

export type TurnQuestionAnswerCandidate = {
  callSeq: number
  callIdHash: string
  requestId: string
  questionAt: number
  answerBatchDigest: string
  selectionBatchDigest?: string | null
  timezone: string
  items: readonly TurnQuestionAnswerItem[]
  selectionItems?: readonly TurnQuestionSelectionItem[]
}

export type AdvanceIntakeCursorInput = {
  sessionId: string
  expectedNextSeq: number | null
  nextSeq: number
  inheritedSeq?: number
  sessionKind?: SessionKind
  conversation?: string | null
  thread?: string | null
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
  questionAnswers?: readonly TurnQuestionAnswerCandidate[]
}

export type SettleTurnInput = {
  sessionId: string
  cwd?: string | null
  sessionKind: SessionKind
  conversation?: string | null
  thread?: string | null
  hostDay?: string | null
  inheritedSeq: number
  expectedNextSeq: number | null
  fromSeq: number
  toSeq: number
  turn: number
  reasonKind: string
  sources: readonly TurnSourceCandidate[]
  questionAnswers?: readonly TurnQuestionAnswerCandidate[]
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
type CursorRow = { session: string, next_seq: number, inherited_seq: number, session_kind: string, conversation: string | null, thread: string | null, created_at: number, updated_at: number }
type QuestionReceiptRow = {
  session: string
  turn: number
  call_seq: number
  call_id_hash: string
  conversation_id: string
  answered_at: number
  question_profile_gen: number | null
  answer_profile_gen: number | null
  answer_batch_digest: string
  selection_batch_digest: string | null
  created_at: number
}
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
    CREATE TABLE IF NOT EXISTS owner_question_receipts(
      session TEXT NOT NULL,
      turn INTEGER NOT NULL,
      call_seq INTEGER NOT NULL,
      call_id_hash TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      answered_at INTEGER NOT NULL,
      question_profile_gen INTEGER,
      answer_profile_gen INTEGER,
      answer_batch_digest TEXT NOT NULL,
      selection_batch_digest TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(session, call_seq, call_id_hash)
    );
    CREATE TABLE IF NOT EXISTS owner_sessions(session TEXT PRIMARY KEY,conversation TEXT NOT NULL,context TEXT,project TEXT);
    CREATE TABLE IF NOT EXISTS owner_intake_cursors(
      session TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL,
      inherited_seq INTEGER NOT NULL DEFAULT 0,
      session_kind TEXT NOT NULL DEFAULT 'main',
      conversation TEXT,
      thread TEXT,
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
    readSessionRange: options.readSessionRange
      ? (input, signal) => {
          if (input.sessionKind) return options.readSessionRange!(input, signal)
          const row = db.prepare('SELECT session_kind FROM owner_intake_cursors WHERE session=?').get(input.sessionId) as { session_kind?: string } | undefined
          const cursorKind = row?.session_kind === 'main' || row?.session_kind === 'task' || row?.session_kind === 'unattended'
            ? row.session_kind as SessionKind : undefined
          return options.readSessionRange!({ ...input, ...(cursorKind ? { sessionKind: cursorKind } : {}) }, signal)
        }
      : undefined,
    diagnostics: options.diagnostics,
    ...(options.now ? { now: options.now } : {}),
    dailyNotes: options.dailyNotes ?? true,
    ...(options.embedding ? { embedder: createMemoryEmbedder(options.embedding) } : {}),
    changed: change => { options.onChange?.(change) },
    injected: (session, turn, pushed) => options.onContextUsed?.({
      session, turn, pushed, revision: store.revision(),
      conversation: sessionContext(session).conversation ?? null, at: Date.now(),
    }),
    canCommit: source => state === 'ready' && (!source.session || !db.prepare('SELECT 1 FROM owner_open_turn_sources WHERE session=? AND source_id=? LIMIT 1').get(source.session, source.id)),
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
      thread: row?.thread ?? null,
    }
  }

  function advanceIntakeCursor(input: AdvanceIntakeCursorInput): CursorResult {
    requireReady()
    const { sessionId: session, expectedNextSeq, nextSeq, inheritedSeq = 0, sessionKind = 'main', conversation = null, thread = null, cwd } = input
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
      const finalThread = options.hostNamespace ? (thread ?? existing?.thread ?? null) : null
      db.prepare(`INSERT INTO owner_intake_cursors(session, next_seq, inherited_seq, session_kind, conversation, thread, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(session) DO UPDATE SET
          next_seq=excluded.next_seq,
          inherited_seq=MAX(owner_intake_cursors.inherited_seq, excluded.inherited_seq),
          session_kind=excluded.session_kind,
          conversation=COALESCE(excluded.conversation, owner_intake_cursors.conversation),
          thread=COALESCE(excluded.thread, owner_intake_cursors.thread),
          updated_at=excluded.updated_at`).run(
        session, nextSeq, inheritedSeq, finalKind, finalConv, finalThread, existing?.created_at ?? ts, ts,
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

  function recordQuestionReceipt(input: QuestionReceiptInput) {
    requireReady()
    const { sessionId: session, turn, callSeq, callIdHash, conversationId, answeredAt, questionProfileGen, answerProfileGen, answerBatchDigest } = input
    const selectionBatchDigest = input.selectionBatchDigest ?? null
    if (!session || !Number.isSafeInteger(turn) || turn <= 0
      || !Number.isSafeInteger(callSeq) || callSeq < 0
      || !/^[0-9a-f]{64}$/u.test(callIdHash)
      || !conversationId.trim()
      || !Number.isSafeInteger(answeredAt) || answeredAt <= 0
      || !/^[0-9a-f]{64}$/u.test(answerBatchDigest)
      || (selectionBatchDigest !== null && !/^[0-9a-f]{64}$/u.test(selectionBatchDigest))) {
      throw new MemoryDomainError('invalid.text', 'Invalid question receipt')
    }
    store.tx(() => {
      const existing = db.prepare(
        'SELECT * FROM owner_question_receipts WHERE session=? AND call_seq=? AND call_id_hash=?',
      ).get(session, callSeq, callIdHash) as QuestionReceiptRow | undefined
      if (existing) {
        if (existing.turn !== turn
          || existing.conversation_id !== conversationId
          || existing.answer_batch_digest !== answerBatchDigest
          || (existing.selection_batch_digest ?? null) !== selectionBatchDigest) {
          throw new MemoryDomainError('operation.conflict', 'Question receipt conflicts with an earlier submission')
        }
        return
      }
      db.prepare(`INSERT INTO owner_question_receipts(
        session, turn, call_seq, call_id_hash, conversation_id, answered_at,
        question_profile_gen, answer_profile_gen, answer_batch_digest, selection_batch_digest, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        session, turn, callSeq, callIdHash, conversationId, answeredAt,
        questionProfileGen, answerProfileGen, answerBatchDigest, selectionBatchDigest, now(),
      )
    })
  }

  function retireSessionQuestionReceipts(session: string) {
    requireReady()
    store.tx(() => {
      db.prepare('DELETE FROM owner_question_receipts WHERE session=?').run(session)
      db.prepare('DELETE FROM owner_open_turn_sources WHERE session=?').run(session)
      db.prepare('DELETE FROM owner_active_turns WHERE session=?').run(session)
    })
  }

  function pruneExpiredQuestionReceipts(maxAgeMs = 30 * 24 * 60 * 60 * 1000, excludeSessions: readonly string[] = []) {
    requireReady()
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) return
    const cutoff = now() - maxAgeMs
    const excluded = [...new Set(excludeSessions.filter(id => id.length > 0))]
    if (excluded.length === 0) {
      db.prepare('DELETE FROM owner_question_receipts WHERE created_at<?').run(cutoff)
      return
    }
    const placeholders = excluded.map(() => '?').join(',')
    db.prepare(`DELETE FROM owner_question_receipts WHERE created_at<? AND session NOT IN (${placeholders})`).run(cutoff, ...excluded)
  }

  function admitQuestionAnswersInTx(
    session: string,
    turn: number,
    effectiveKind: SessionKind,
    questionAnswers: readonly TurnQuestionAnswerCandidate[],
    { deferAutomatic, includeSelections }: { deferAutomatic: boolean, includeSelections: boolean },
  ): { admittedIds: string[], eventSeqs: Record<string, number>, conversation?: string } {
    const admittedIds: string[] = []
    const eventSeqs: Record<string, number> = Object.create(null) as Record<string, number>
    let receiptConversation: string | undefined
    if (!questionAnswers.length) return { admittedIds, eventSeqs }
    const selectReceipt = db.prepare(
      'SELECT * FROM owner_question_receipts WHERE session=? AND turn=? AND call_seq=? AND call_id_hash=?',
    )
    const currentDelGen = runtime.profileDeletionGeneration()
    const customSourceKind: MemorySourceKind = effectiveKind === 'task' ? 'task-question-answer' : 'question-answer'
    const selectionSourceKind: MemorySourceKind = effectiveKind === 'task' ? 'task-question-selection' : 'question-selection'
    for (const candidate of questionAnswers) {
      const selectionItems = includeSelections ? (candidate.selectionItems ?? []) : []
      if (!candidate.items.length && !selectionItems.length) continue
      const row = selectReceipt.get(session, turn, candidate.callSeq, candidate.callIdHash) as QuestionReceiptRow | undefined
      if (!row) continue

      // 1. Independently verify custom `answer_batch_digest` (§3.2.2 Gate 3).
      if (candidate.items.length > 0 && row.answer_batch_digest === candidate.answerBatchDigest) {
        const computedDigest = canonicalEligibleAnswersDigest(candidate.items.map(item => ({
          id: item.questionId,
          question: item.question,
          custom: item.text,
        })))
        if (computedDigest === row.answer_batch_digest) {
          if (!receiptConversation && row.conversation_id) receiptConversation = row.conversation_id
          const answerProfileEligible = effectiveKind === 'task'
            ? false
            : (currentDelGen === 0 || (row.answer_profile_gen !== null && row.answer_profile_gen === currentDelGen))
          const origin = {
            conversation: row.conversation_id,
            session,
            scope: { kind: 'user' as const },
            context: { kind: 'user' as const },
            author: 'answer' as const,
            sourceKind: customSourceKind,
            profileEligible: answerProfileEligible,
          }
          for (const item of candidate.items) {
            const text = item.text.trim()
            if (!text || !item.questionId.trim() || !item.question.trim()) continue
            if (hasUnsupportedSqliteChars(item.questionId) || hasUnsupportedSqliteChars(item.question) || hasUnsupportedSqliteChars(text)) continue
            if (looksSecret(item.questionId) || looksSecret(item.question) || looksSecret(text)) continue
            const answerMeta = {
              question: item.question,
              requestId: candidate.requestId,
              questionId: item.questionId,
              custom: true as const,
              questionAt: candidate.questionAt,
              ...(row.question_profile_gen !== null ? { questionProfileGen: row.question_profile_gen } : {}),
            }
            const expectedHash = memoryHash(text)
            const existing = store.readSource(item.sourceId)
            if (existing) {
              if (existing.session !== session
                || existing.conversation !== origin.conversation
                || existing.author !== 'answer'
                || (existing.hash !== null && existing.hash !== expectedHash)
                || existing.requestId !== candidate.requestId
                || existing.questionId !== item.questionId) {
                continue
              }
              if (!deferAutomatic && existing.outcome === 'received') {
                runtime.accept(text, origin, item.sourceId, answerMeta, {
                  deferAutomatic: false, at: row.answered_at, timezone: candidate.timezone,
                })
              }
            } else {
              runtime.accept(text, origin, item.sourceId, answerMeta, {
                deferAutomatic, at: row.answered_at, timezone: candidate.timezone,
              })
            }
            const saved = store.readSource(item.sourceId)
            if (saved?.text
              && saved.session === session
              && saved.conversation === origin.conversation
              && saved.author === 'answer'
              && saved.hash === expectedHash
              && saved.text === text) {
              admittedIds.push(saved.id)
              eventSeqs[saved.id] = candidate.callSeq
            }
          }
        }
      }

      // 2. Independently verify option `selection_batch_digest` (§3.2.2 Gate 3).
      if (selectionItems.length > 0
        && row.selection_batch_digest
        && candidate.selectionBatchDigest
        && row.selection_batch_digest === candidate.selectionBatchDigest) {
        const computedSelDigest = canonicalEligibleSelectionsDigest(selectionItems.map(item => ({
          id: item.questionId,
          question: item.question,
          selected: [...item.selected],
        })))
        if (computedSelDigest === row.selection_batch_digest) {
          if (!receiptConversation && row.conversation_id) receiptConversation = row.conversation_id
          const selOrigin = {
            conversation: row.conversation_id,
            session,
            scope: { kind: 'user' as const },
            context: { kind: 'user' as const },
            author: 'selection' as const,
            sourceKind: selectionSourceKind,
            profileEligible: false,
          }
          for (const item of selectionItems) {
            if (!item.selected.length || !item.questionId.trim() || !item.question.trim()) continue
            if (item.selected.some(label => !label.trim() || hasUnsupportedSqliteChars(label) || looksSecret(label))) continue
            const text = item.selected.join('、').trim()
            if (!text || item.text.trim() !== text) continue
            if (hasUnsupportedSqliteChars(item.questionId) || hasUnsupportedSqliteChars(item.question) || hasUnsupportedSqliteChars(text)) continue
            if (looksSecret(item.questionId) || looksSecret(item.question) || looksSecret(text)) continue
            const selMeta = {
              question: item.question,
              requestId: candidate.requestId,
              questionId: item.questionId,
              selection: true as const,
              questionAt: candidate.questionAt,
              ...(row.question_profile_gen !== null ? { questionProfileGen: row.question_profile_gen } : {}),
            }
            const expectedHash = memoryHash(text)
            const existing = store.readSource(item.sourceId)
            if (existing) {
              if (existing.session !== session
                || existing.conversation !== selOrigin.conversation
                || existing.author !== 'selection'
                || (existing.hash !== null && existing.hash !== expectedHash)
                || existing.requestId !== candidate.requestId
                || existing.questionId !== item.questionId) {
                continue
              }
              if (!deferAutomatic && existing.outcome === 'received') {
                runtime.accept(text, selOrigin, item.sourceId, selMeta, {
                  deferAutomatic: false, at: row.answered_at, timezone: candidate.timezone,
                })
              }
            } else {
              runtime.accept(text, selOrigin, item.sourceId, selMeta, {
                deferAutomatic, at: row.answered_at, timezone: candidate.timezone,
              })
            }
            const saved = store.readSource(item.sourceId)
            if (saved?.text
              && saved.session === session
              && saved.conversation === selOrigin.conversation
              && saved.author === 'selection'
              && saved.hash === expectedHash
              && saved.text === text) {
              admittedIds.push(saved.id)
              eventSeqs[saved.id] = candidate.callSeq
            }
          }
        }
      }
    }
    return { admittedIds, eventSeqs, ...(receiptConversation ? { conversation: receiptConversation } : {}) }
  }

  /**
   * Resolve safe per-occurrence `sourceId` for `stageOpenTurnSources` and `settleTurn` (§3.3.2):
   * - Unedited rewind/fork resend reusing a prior segment/session's `sourceId` with identical
   *   `author` and `text` derives `deterministicOccurrenceUuid(session, candidate.sourceId)` so
   *   original `history.db` `sourceLink()` stays intact while the new session's turn settles cleanly.
   * - Forged or conflicting UUID collisions across sessions/conversations are rejected (`null`).
   */
  function resolveTurnSourceId(
    session: string,
    origin: ReturnType<typeof resolveCandidateOrigin>,
    candidate: TurnSourceCandidate,
  ): string | null {
    const isDenied = looksSecret(candidate.text)
    const expectedHash = isDenied ? null : memoryHash(candidate.text)
    const existing = store.readSource(candidate.sourceId)
    if (!existing) return candidate.sourceId
    if (existing.session === session && existing.conversation === origin.conversation) {
      if (existing.author !== origin.author) return null
      if (existing.hash === null) return isDenied ? candidate.sourceId : null
      return !isDenied && existing.hash === expectedHash && existing.text === candidate.text
        ? candidate.sourceId
        : null
    }
    if (isDenied || existing.author !== origin.author || existing.hash === null || existing.hash !== expectedHash || existing.text !== candidate.text) {
      return null
    }
    const derived = existing.session !== session
      ? deterministicOccurrenceUuid(session, candidate.sourceId)
      : deterministicOccurrenceUuid(session, candidate.sourceId, origin.conversation ?? '')
    const derivedExisting = store.readSource(derived)
    if (!derivedExisting) return derived
    return derivedExisting.session === session
      && derivedExisting.conversation === origin.conversation
      && derivedExisting.author === origin.author
      && derivedExisting.hash === expectedHash
      && derivedExisting.text === candidate.text
      ? derived
      : null
  }

  function stageOpenTurnSources(input: StageOpenTurnInput): { staged: string[] } {
    requireReady()
    const { sessionId: session, turn, sessionKind, conversation, cwd, sources, questionAnswers = [] } = input
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
        const targetSourceId = resolveTurnSourceId(session, origin, candidate)
        if (!targetSourceId) continue
        const expectedHash = memoryHash(candidate.text)
        const existing = store.readSource(targetSourceId)
        if (!existing) {
          runtime.accept(candidate.text, origin, targetSourceId, undefined, {
            deferAutomatic: true, at: candidate.at, timezone: candidate.timezone,
          })
        }
        const saved = store.readSource(targetSourceId)
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
      const admittedQuestions = admitQuestionAnswersInTx(session, turn, sessionKind, questionAnswers, { deferAutomatic: true, includeSelections: false })
      if (admittedQuestions.conversation && !conversation) {
        bindSession(session, resolved, admittedQuestions.conversation)
      }
      for (const answerSourceId of admittedQuestions.admittedIds) {
        db.prepare('INSERT OR IGNORE INTO owner_open_turn_sources(session, turn, source_id) VALUES (?,?,?)')
          .run(session, turn, answerSourceId)
        staged.push(answerSourceId)
      }
      return { staged: [...new Set(staged)] }
    })
  }

  function settleTurn(input: SettleTurnInput, signal?: AbortSignal): CursorResult {
    requireReady()
    signal?.throwIfAborted()
    const { sessionId: session, cwd, sessionKind, conversation, inheritedSeq, expectedNextSeq, fromSeq, toSeq, turn, reasonKind, sources, questionAnswers = [], assistantText, flushNotes } = input
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
      const effectiveKind: SessionKind = existingCursor && sessionKind === 'main' && existingCursor.session_kind !== 'main'
        ? existingCursor.session_kind as SessionKind : sessionKind
      let effectiveConv = conversation ?? existingCursor?.conversation ?? null
      const effectiveThread = options.hostNamespace && effectiveKind !== 'unattended'
        ? (input.thread ?? existingCursor?.thread ?? null)
        : null

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
          const sourceEventSeqs: Record<string, number> = Object.create(null) as Record<string, number>
          for (const candidate of sources) {
            if (!candidate.text.trim()) continue
            const origin = resolveCandidateOrigin(session, bound, candidate)
            const targetSourceId = resolveTurnSourceId(session, origin, candidate)
            if (!targetSourceId) continue
            const receipt = runtime.accept(candidate.text, origin, targetSourceId, undefined, {
              deferAutomatic: false, at: candidate.at, timezone: candidate.timezone,
            })
            const saved = store.readSource(receipt.sourceId)
            if (saved?.text && saved.session === session) {
              admittedIds.push(saved.id)
              if (candidate.eventSeq !== undefined) sourceEventSeqs[saved.id] = candidate.eventSeq
            }
          }
          const admittedQuestions = admitQuestionAnswersInTx(session, turn, effectiveKind, questionAnswers, { deferAutomatic: false, includeSelections: true })
          if (admittedQuestions.conversation && !effectiveConv) {
            effectiveConv = admittedQuestions.conversation
            bindSession(session, resolved, effectiveConv)
          }
          for (const answerSourceId of admittedQuestions.admittedIds) {
            admittedIds.push(answerSourceId)
            if (admittedQuestions.eventSeqs[answerSourceId] !== undefined) {
              sourceEventSeqs[answerSourceId] = admittedQuestions.eventSeqs[answerSourceId]!
            }
          }
          const uniqueAdmitted = [...new Set(admittedIds)]
          if (uniqueAdmitted.length > 0) {
            runtime.recordNoteRangeInTx?.({
              session,
              groupKey: effectiveThread ?? session,
              sessionKind: effectiveKind,
              turnAt: input.at,
              hostDay: effectiveKind === 'task' ? (input.hostDay ?? null) : null,
              fromSeq,
              toSeq,
              turn,
              ids: uniqueAdmitted,
              assistant: assistantText,
              sourceEventSeqs,
              flush: flushNotes === true || effectiveKind === 'task',
            })
          }
        }
      }

      // On ANY terminal turn/end (completed, aborted, interrupted, error): clear open-turn staging,
      // retire question receipts up to this turn/seq (covering lost PTC tails closed by repair.ts), and advance cursor.
      db.prepare('DELETE FROM owner_open_turn_sources WHERE session=? AND turn=?').run(session, turn)
      db.prepare('DELETE FROM owner_question_receipts WHERE session=? AND (turn<=? OR call_seq<?)').run(session, turn, toSeq)
      db.prepare('DELETE FROM owner_active_turns WHERE session=? AND turn=?').run(session, String(turn))
      const ts = now()
      db.prepare(`INSERT INTO owner_intake_cursors(session, next_seq, inherited_seq, session_kind, conversation, thread, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(session) DO UPDATE SET
          next_seq=excluded.next_seq,
          inherited_seq=MAX(owner_intake_cursors.inherited_seq, excluded.inherited_seq),
          session_kind=excluded.session_kind,
          conversation=COALESCE(excluded.conversation, owner_intake_cursors.conversation),
          thread=COALESCE(excluded.thread, owner_intake_cursors.thread),
          updated_at=excluded.updated_at`).run(
        session, toSeq, inheritedSeq, effectiveKind, effectiveConv, effectiveThread, existingCursor?.created_at ?? ts, ts,
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
    const sources = db.prepare('SELECT source_id AS source FROM owner_open_turn_sources WHERE session=? AND turn=?')
      .all(session, Number(origin.foregroundTurn))
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
    signal?.throwIfAborted()
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new RequestTimeout()
    switch (command.method) {
      case 'getOperation': { const item = operation(command.input.operationId); return item ? outcome(item) : null }
    }
    requireReady()
    switch (command.method) {
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
    recordQuestionReceipt,
    retireSessionQuestionReceipts,
    pruneExpiredQuestionReceipts,
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
