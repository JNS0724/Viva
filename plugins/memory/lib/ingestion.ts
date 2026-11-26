import { createHash } from 'node:crypto'
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ReadSessionRangeResult } from '../../../src/memory/core/ports/notes.ts'
import type { QuestionReceiptInput, TurnQuestionAnswerCandidate, TurnSourceCandidate } from '../../../src/memory/node/owner.ts'
import { looksSecret } from '../../../src/memory/core/memory-sensitive.ts'
import {
  canonicalEligibleAnswersDigest,
  eligibleQuestionAnswers,
  questionAnswerSourceId,
  questionCallIdHash,
  questionOccurrenceRequestId,
  type RawQuestionAnswer,
  type RawQuestionCard,
  type RawQuestionOption,
} from '../../../src/memory/node/question-answer-memory.ts'
import { requestsIn } from '../../../src/shared/request-routing/header.ts'
import { leadingTaskRequestId, stripLeadingTaskHeader, withoutTaskHeaders } from '../../../src/shared/request-routing/task-header.ts'
import {
  extractHumanSpans,
  parseProvenanceHeader,
  readLiftedProvenance,
  validateHumanSpans,
  type SessionKind,
  type VivaProvenanceHeader,
} from '../../../src/shared/request-routing/provenance.ts'
import type { createRemoteMemoryOwner } from './remote-owner.ts'
import type {} from './source.ts'

type Owner = Pick<
  ReturnType<typeof createRemoteMemoryOwner>,
  'epoch' | 'inEpoch' | 'intakeCursor' | 'advanceIntakeCursor' | 'beginTurn' | 'stageOpenTurnSources' | 'settleTurn'
> & Partial<Pick<
  ReturnType<typeof createRemoteMemoryOwner>,
  'recordQuestionReceipt' | 'retireSessionQuestionReceipts' | 'pruneExpiredQuestionReceipts'
>>

type PersistenceLike = Pick<SessionPersistence, 'open' | 'list'>
type SessionsLike = {
  flush(session: Session): Promise<boolean>
  get?(id: SessionId): Session | undefined
  list?(): readonly Session[]
}

const READ_CHUNK_SIZE = 512
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const COLD_RETRY_BASE_MS = 100
const COLD_RETRY_MAX_MS = 5_000

const textOf = (message: { content: readonly { type: string, text?: string }[] }) =>
  message.content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionPersistenceNotFoundError'
}

export function deterministicSourceUuid(namespace: string, ...parts: readonly (string | number)[]): string {
  const digest = createHash('sha256').update(JSON.stringify([namespace, ...parts])).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function normalizeSourceId(raw: string | undefined, sessionId: string, fallbackKey: string): string {
  if (raw && UUID_RE.test(raw)) return raw
  return deterministicSourceUuid('msg', sessionId, raw ?? fallbackKey)
}

function extractCorrelationRequestId(text: string): string | undefined {
  const leadingTask = leadingTaskRequestId(text)
  if (leadingTask) return leadingTask
  const routed = requestsIn(text)
  if (routed.length > 0) return routed[routed.length - 1]!.id
  return undefined
}

export type ExtractedHumanMessage = {
  id: string
  text: string
  sourceId: string
  conversationId?: string
  sourceKind: 'main-human' | 'task-human-steer'
  sessionKind: 'main' | 'task'
  profileEligible: boolean
  requestId?: string
}

function resolveHostedProvenance(
  message: UserMessage,
  raw: string,
): { provenance: VivaProvenanceHeader, payload: string } | null {
  const src = message.source as Readonly<Record<string, unknown>>
  if ('vivaProvenance' in src) {
    const provenance = readLiftedProvenance(src, raw.length)
    return provenance ? { provenance, payload: raw } : null
  }
  if (src.kind === 'user') {
    return parseProvenanceHeader(raw)
  }
  return null
}

/**
 * Unified human-message extractor shared by `agent/pre-step` L3 automatic recall and session ingestion
 * (docs/memory-runtime-decoupling.md §5.4 item 1-2).
 *
 * Accepts:
 * - `'user'` (reading structured `source.vivaProvenance` after `liftProvenance`, with un-lifted header fallback
 *   in hosted mode, or raw text verbatim in standalone DSH when `host === false`),
 * - `'viva-main-human-steer'` (slicing payload-relative `humanSpans` without `unquote()`),
 * - `'viva-task-human-steer'` (stripping leading task header and slicing payload-relative `humanSpans`).
 *
 * Excludes `'viva-task-router-message'`, `'viva-task-brief'`, `'viva-report'`, `'viva-report-batch'`,
 * `'viva-memory'`, `'viva-unattended'`, and empty `humanSpans: []` (e.g. feed-only continuations).
 */
export function extractHumanMessages(
  messages: readonly UserMessage[],
  { host = false, sessionId = '' }: { host?: boolean, sessionId?: string } = {},
): ExtractedHumanMessage[] {
  const extracted: ExtractedHumanMessage[] = []
  for (const message of messages) {
    const raw = textOf(message)
    const kind = message.source.kind as string
    if (!host) {
      // Standalone DSH preserves user text verbatim and never interprets Viva provenance headers (§5.4).
      if (kind !== 'user' || !raw.trim()) continue
      extracted.push({
        id: String(message.id),
        text: raw,
        sourceId: normalizeSourceId(String(message.id), sessionId, String(message.id)),
        sourceKind: 'main-human',
        sessionKind: 'main',
        profileEligible: true,
        requestId: extractCorrelationRequestId(raw),
      })
      continue
    }
    if (kind === 'viva-main-human-steer') {
      const src = message.source as { sourceId?: string, conversationId?: string, humanSpans?: Array<{ start: number, end: number }> }
      const spans = src.humanSpans ? validateHumanSpans(src.humanSpans, raw.length) : null
      if (!spans) continue
      const text = extractHumanSpans(raw, spans)
      if (!text || !text.trim()) continue
      extracted.push({
        id: String(message.id),
        text,
        sourceId: normalizeSourceId(src.sourceId, sessionId, String(message.id)),
        ...(src.conversationId ? { conversationId: src.conversationId } : {}),
        sourceKind: 'main-human',
        sessionKind: 'main',
        profileEligible: true,
        requestId: extractCorrelationRequestId(raw),
      })
      continue
    }
    if (kind === 'viva-task-human-steer') {
      const src = message.source as { sourceId?: string, conversationId?: string, humanSpans?: Array<{ start: number, end: number }> }
      const stripped = stripLeadingTaskHeader(raw)
      const payload = stripped ? stripped.payload : raw
      const spans = src.humanSpans ? validateHumanSpans(src.humanSpans, payload.length) : null
      if (!spans) continue
      const text = extractHumanSpans(payload, spans)
      if (!text || !text.trim()) continue
      extracted.push({
        id: String(message.id),
        text,
        sourceId: normalizeSourceId(src.sourceId, sessionId, String(message.id)),
        ...(src.conversationId ? { conversationId: src.conversationId } : {}),
        sourceKind: 'task-human-steer',
        sessionKind: 'task',
        profileEligible: true,
        requestId: stripped?.requestId ?? leadingTaskRequestId(raw),
      })
      continue
    }
    if (kind !== 'user') continue

    const resolved = resolveHostedProvenance(message, raw)
    if (!resolved) continue
    const { provenance, payload } = resolved
    if (provenance.origin !== 'human') continue
    if (provenance.sourceKind === 'viva-report' || provenance.sourceKind === 'viva-report-batch' || provenance.sourceKind === 'unattended') continue
    if (!provenance.humanSpans) continue
    const text = extractHumanSpans(payload, provenance.humanSpans)
    if (!text || !text.trim()) continue
    const isTask = provenance.sourceKind === 'task-human-steer' || provenance.sessionKind === 'task'
    extracted.push({
      id: String(message.id),
      text,
      sourceId: normalizeSourceId(provenance.sourceId, sessionId, String(message.id)),
      ...(provenance.conversationId ? { conversationId: provenance.conversationId } : {}),
      sourceKind: isTask ? 'task-human-steer' : 'main-human',
      sessionKind: isTask ? 'task' : 'main',
      profileEligible: true,
      requestId: extractCorrelationRequestId(payload),
    })
  }
  return extracted
}

/**
 * Read-only L3 automatic recall query extractor used by `agent/pre-step` in `adapter.ts`.
 * Uses `extractHumanMessages` as the single source of truth for human messages, and additionally
 * permits read-only L3 lookups for hosted ACP `viva-task-brief` prompts so background tasks can consult
 * global user memory without ever entering human `memory_sources`.
 * Unattended prompts (`viva-unattended`, `origin: 'unattended'`, empty `humanSpans`) NEVER trigger L3 recall (§5.4).
 */
export function extractRecallQueries(
  messages: readonly UserMessage[],
  options: { host?: boolean, sessionId?: string } = {},
): Array<{ id: string, text: string, requestId?: string }> {
  const queries: Array<{ id: string, text: string, requestId?: string }> = []
  for (const message of messages) {
    const human = extractHumanMessages([message], options)
    if (human.length > 0) {
      const item = human[0]!
      queries.push({ id: item.id, text: item.text, ...(item.requestId ? { requestId: item.requestId } : {}) })
      continue
    }
    if (!options.host) continue
    const kind = message.source.kind as string
    if (kind !== 'viva-task-brief' && kind !== 'user') continue
    const raw = textOf(message)
    const resolved = resolveHostedProvenance(message, raw)
    if (!resolved) continue
    const { provenance, payload } = resolved
    if (provenance.origin === 'router' && provenance.sourceKind === 'task-brief') {
      const queryText = provenance.humanSpans && provenance.humanSpans.length > 0
        ? extractHumanSpans(payload, provenance.humanSpans)
        : withoutTaskHeaders(payload)
      if (!queryText || !queryText.trim()) continue
      const requestId = extractCorrelationRequestId(payload)
      queries.push({ id: String(message.id), text: queryText, ...(requestId ? { requestId } : {}) })
    }
  }
  return queries
}

/**
 * Backward-compatible alias for tests/callers inspecting extracted human messages.
 */
export const humanMessages = (messages: readonly UserMessage[], options?: { host?: boolean, sessionId?: string }) =>
  extractHumanMessages(messages, options)

export type DurableSliceResult =
  | { ok: true, events: readonly SessionEvent[] }
  | { ok: false, reason: 'flush-failed' | 'not-found' | 'short-read' | 'io-error' }

/**
 * Single verified persistence boundary (§5.2 item 1):
 * Await `sessions.flush(session) === true`, open a short-lived read handle (closed in `finally`),
 * and read the actual persisted `[fromSeq, endSeq)` events directly from disk.
 * Closes the pinned-DSH no-writer loophole where `flush()` returns `true` while `open('read')` throws
 * `SessionPersistenceNotFoundError`.
 */
export async function readVerifiedDurableSlice(
  sessions: Pick<SessionsLike, 'flush'>,
  sessionPersistence: Pick<PersistenceLike, 'open'>,
  session: Session,
  fromSeq: number,
  endSeq: number,
): Promise<DurableSliceResult> {
  if (endSeq <= fromSeq) return { ok: true, events: [] }
  let flushed = false
  try {
    flushed = (await sessions.flush(session)) === true
  } catch {
    return { ok: false, reason: 'flush-failed' }
  }
  if (!flushed) return { ok: false, reason: 'flush-failed' }

  let handle
  try {
    handle = await sessionPersistence.open(session.id, 'read')
  } catch (error) {
    if (isNotFoundError(error)) return { ok: false, reason: 'not-found' }
    return { ok: false, reason: 'io-error' }
  }
  try {
    const events: SessionEvent[] = []
    let offset = fromSeq
    while (offset < endSeq) {
      const limit = Math.min(READ_CHUNK_SIZE, endSeq - offset)
      const batch = await handle.read(offset, limit)
      if (!batch.events.length) break
      const capped = batch.events.slice(0, limit)
      for (const event of capped) events.push(event)
      offset += capped.length
    }
    if (events.length < endSeq - fromSeq) return { ok: false, reason: 'short-read' }
    return { ok: true, events }
  } catch (error) {
    if (isNotFoundError(error)) return { ok: false, reason: 'not-found' }
    return { ok: false, reason: 'io-error' }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function readHandleRange(
  sessionPersistence: Pick<PersistenceLike, 'open'>,
  sessionId: string,
  fromSeq: number,
  toSeq: number,
): Promise<{ status: 'ok', events: SessionEvent[] } | { status: 'deleted' } | { status: 'unavailable' }> {
  let handle
  try {
    handle = await sessionPersistence.open(SessionId(sessionId), 'read')
  } catch (error) {
    return isNotFoundError(error) ? { status: 'deleted' } : { status: 'unavailable' }
  }
  try {
    const events: SessionEvent[] = []
    let offset = fromSeq
    while (offset < toSeq) {
      const limit = Math.min(READ_CHUNK_SIZE, toSeq - offset)
      const batch = await handle.read(offset, limit)
      if (!batch.events.length) break
      const capped = batch.events.slice(0, limit)
      for (const event of capped) events.push(event)
      offset += capped.length
    }
    if (events.length < toSeq - fromSeq) return { status: 'unavailable' }
    return { status: 'ok', events }
  } catch (error) {
    return isNotFoundError(error) ? { status: 'deleted' } : { status: 'unavailable' }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Shared host-aware assistant text selection for both turn settlement and on-demand
 * `readPersistedSessionRange` reads (ensuring stored `assistant_digest` and range reads
 * always interpret persisted events identically).
 */
export function selectTurnAssistantText(
  events: readonly SessionEvent[],
  host: boolean,
  initialSessionKind: SessionKind = 'main',
): string {
  let sessionKind: SessionKind = initialSessionKind
  let hasReport = false
  const assistantParts: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (host) {
        const kind = event.data.source.kind as string
        if (kind === 'viva-report' || kind === 'viva-report-batch') {
          hasReport = true
        } else if (kind === 'viva-unattended') {
          sessionKind = 'unattended'
        } else if (kind === 'viva-task-brief' || kind === 'viva-task-human-steer' || kind === 'viva-task-router-message') {
          sessionKind = 'task'
        } else if (kind === 'user') {
          const resolved = resolveHostedProvenance(event.data, textOf(event.data))
          if (resolved) {
            const { provenance } = resolved
            if (provenance.origin === 'unattended' || provenance.sourceKind === 'unattended' || provenance.sessionKind === 'unattended') {
              sessionKind = 'unattended'
            } else if (provenance.sourceKind === 'viva-report-batch' || provenance.sourceKind === 'viva-report') {
              hasReport = true
            } else if (provenance.sessionKind === 'task' || provenance.sourceKind === 'task-brief' || provenance.sourceKind === 'task-human-steer') {
              sessionKind = 'task'
            }
          }
        }
      }
    } else if (event.type === 'assistant/message' && !event.data.interrupted) {
      assistantParts.push(textOf(event.data.message))
    }
  }
  if (hasReport || sessionKind === 'unattended') return ''
  if (sessionKind === 'task') {
    return [...assistantParts].reverse().find(part => part.trim().length > 0) ?? ''
  }
  return assistantParts.join('\n')
}

/**
 * On-demand range read for `WRITE_NOTE` (§5.2 item 4):
 * Distinguishes confirmed deletion (`SessionPersistenceNotFoundError` from `open()` or `read()`)
 * from transient I/O errors or short reads (rechecking once with a fresh handle before returning `unavailable`).
 */
export async function readPersistedSessionRange(
  sessionPersistence: Pick<PersistenceLike, 'open'>,
  sessionId: string,
  fromSeq: number,
  toSeq: number,
  { host = false, initialSessionKind = 'main' }: { host?: boolean, initialSessionKind?: SessionKind } = {},
): Promise<ReadSessionRangeResult> {
  if (toSeq <= fromSeq) return { status: 'ok', assistant: '' }
  let attempt = await readHandleRange(sessionPersistence, sessionId, fromSeq, toSeq)
  if (attempt.status === 'unavailable') {
    attempt = await readHandleRange(sessionPersistence, sessionId, fromSeq, toSeq)
  }
  if (attempt.status !== 'ok') return attempt
  const assistant = selectTurnAssistantText(attempt.events, host, initialSessionKind)
  return { status: 'ok', assistant: looksSecret(assistant) ? '' : assistant }
}

function parseRawQuestionCards(rawArgs: unknown): RawQuestionCard[] | null {
  let obj: unknown = rawArgs
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return null }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const questions = (obj as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const cards: RawQuestionCard[] = []
  for (const item of questions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== 'string' || typeof rec.question !== 'string') return null
    let options: RawQuestionOption[] | undefined
    if (rec.options !== undefined) {
      if (!Array.isArray(rec.options)) return null
      options = []
      for (const opt of rec.options) {
        if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return null
        const o = opt as Record<string, unknown>
        if (typeof o.label !== 'string') return null
        if (o.description !== undefined && typeof o.description !== 'string') return null
        options.push({ label: o.label, ...(o.description !== undefined ? { description: o.description } : {}) })
      }
    }
    if (rec.header !== undefined && typeof rec.header !== 'string') return null
    const multiSelect = typeof rec.multiSelect === 'boolean'
      ? rec.multiSelect
      : typeof rec.multi_select === 'boolean'
        ? rec.multi_select
        : undefined
    cards.push({
      id: rec.id,
      question: rec.question,
      ...(rec.header !== undefined ? { header: rec.header } : {}),
      ...(multiSelect !== undefined ? { multiSelect } : {}),
      ...(options !== undefined ? { options } : {}),
    })
  }
  return cards
}

function parseLegacyQuestionAnswers(content: unknown): RawQuestionAnswer[] | null {
  if (!Array.isArray(content) || content.length === 0) return null
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text' || typeof (block as { text?: unknown }).text !== 'string') {
      return null
    }
    text += (block as { text: string }).text
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  if (rec.pending === true || !Array.isArray(rec.answers)) return null
  const answers: RawQuestionAnswer[] = []
  for (const item of rec.answers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const a = item as Record<string, unknown>
    if (typeof a.id !== 'string' || !Array.isArray(a.selected) || !a.selected.every(s => typeof s === 'string')) return null
    if (a.custom !== undefined && typeof a.custom !== 'string') return null
    answers.push({ id: a.id, selected: a.selected, ...(a.custom !== undefined ? { custom: a.custom } : {}) })
  }
  return answers
}

type FoldedQuestionStart = {
  callSeq: number
  callId: string
  questionAt: number
  cards: RawQuestionCard[]
}

/**
 * Deterministically fold blocking native (`tool/call` + `tool/result`) and PTC
 * (`tool/ptc-dispatch-start` + `tool/ptc-dispatch`) `ask_user_question` occurrences in one turn slice.
 * Naturally fails closed on compaction replacements, errors, `TOOL_OUTCOME_UNKNOWN`,
 * `dsh-spill` previews, `pending` results, selected-only items, and `user-question-reply`.
 */
export function foldQuestionAnswersForTurn(
  turnEvents: readonly SessionEvent[],
  sessionId: string,
  tz: string,
): TurnQuestionAnswerCandidate[] {
  const nativeStarts = new Map<number, FoldedQuestionStart>()
  const ptcStarts = new Map<string, FoldedQuestionStart | 'ambiguous'>()
  const settledKeys = new Set<string>()
  const candidates: TurnQuestionAnswerCandidate[] = []

  const admitMatch = (start: FoldedQuestionStart, content: unknown) => {
    const callIdHash = questionCallIdHash(start.callId)
    const key = `${start.callSeq}:${callIdHash}`
    if (settledKeys.has(key)) return
    const answers = parseLegacyQuestionAnswers(content)
    if (!answers) return
    const eligible = eligibleQuestionAnswers(start.cards, answers)
    if (eligible.length === 0) return
    settledKeys.add(key)
    const requestId = questionOccurrenceRequestId(start.callSeq, callIdHash)
    candidates.push({
      callSeq: start.callSeq,
      callIdHash,
      requestId,
      questionAt: start.questionAt,
      answerBatchDigest: canonicalEligibleAnswersDigest(eligible),
      timezone: tz,
      items: eligible.map(item => ({
        sourceId: questionAnswerSourceId(sessionId, start.callSeq, start.callId, item.id),
        questionId: item.id,
        question: item.question,
        text: item.custom,
      })),
    })
  }

  for (const event of turnEvents) {
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
      const cards = parseRawQuestionCards(event.data.arguments)
      if (cards && typeof event.data.callId === 'string' && event.data.callId.length > 0) {
        nativeStarts.set(Number(event.seq), {
          callSeq: Number(event.seq),
          callId: String(event.data.callId),
          questionAt: event.time,
          cards,
        })
      }
      continue
    }
    if ((event.type as string) === 'tool/ptc-dispatch-start') {
      const data = event.data as { name?: unknown, subCallId?: unknown, parentCallId?: unknown, rootCallId?: unknown, arguments?: unknown }
      if (data?.name === 'ask_user_question'
        && typeof data.subCallId === 'string' && data.subCallId.length > 0
        && typeof data.parentCallId === 'string' && data.parentCallId.length > 0
        && typeof data.rootCallId === 'string' && data.rootCallId.length > 0) {
        const ptcKey = `${data.subCallId}\0${data.parentCallId}\0${data.rootCallId}`
        const cards = parseRawQuestionCards(data.arguments)
        if (!cards || ptcStarts.has(ptcKey)) {
          ptcStarts.set(ptcKey, 'ambiguous')
        } else {
          ptcStarts.set(ptcKey, {
            callSeq: Number(event.seq),
            callId: data.subCallId,
            questionAt: event.time,
            cards,
          })
        }
      }
      continue
    }
    if (event.type === 'tool/result') {
      if (event.surfaceOp !== 'append') continue
      if (event.data.message.isError === true || event.data.error !== undefined) continue
      const refs = event.sourceEventSeqs
      if (!Array.isArray(refs) || refs.length === 0) continue
      const callId = String(event.data.message.toolCallId)
      const matches: FoldedQuestionStart[] = []
      for (const ref of refs) {
        const start = nativeStarts.get(Number(ref))
        if (start && start.callId === callId) matches.push(start)
      }
      if (matches.length !== 1) continue
      admitMatch(matches[0]!, event.data.message.content)
      continue
    }
    if ((event.type as string) === 'tool/ptc-dispatch') {
      const data = event.data as {
        name?: unknown, subCallId?: unknown, parentCallId?: unknown, rootCallId?: unknown,
        isError?: unknown, error?: unknown, content?: unknown,
      }
      if (data?.name !== 'ask_user_question' || data.isError === true || data.error !== undefined) continue
      if (typeof data.subCallId !== 'string' || typeof data.parentCallId !== 'string' || typeof data.rootCallId !== 'string') continue
      const ptcKey = `${data.subCallId}\0${data.parentCallId}\0${data.rootCallId}`
      const start = ptcStarts.get(ptcKey)
      if (!start || start === 'ambiguous') continue
      admitMatch(start, data.content)
    }
  }

  candidates.sort((a, b) => a.callSeq - b.callSeq)
  return candidates
}

type TurnClassification = {
  sessionKind: SessionKind
  conversation?: string
  hasReport: boolean
  sources: TurnSourceCandidate[]
  assistantParts: string[]
}

function classifyUserMessageForTurn(
  message: UserMessage,
  eventSeq: number,
  at: number,
  tz: string,
  sessionId: string,
  host: boolean,
  acc: TurnClassification,
) {
  const raw = textOf(message)
  const kind = message.source.kind as string
  if (host && (kind === 'viva-report' || kind === 'viva-report-batch')) {
    acc.hasReport = true
    const resolved = resolveHostedProvenance(message, raw)
    if (resolved?.provenance.conversationId) acc.conversation = resolved.provenance.conversationId
    return
  }
  if (host && kind === 'viva-unattended') {
    acc.sessionKind = 'unattended'
    return
  }
  if (host && kind === 'viva-task-brief') {
    acc.sessionKind = 'task'
    const resolved = resolveHostedProvenance(message, raw)
    const provenance = resolved?.provenance
    const payload = resolved?.payload ?? raw
    if (provenance?.conversationId) acc.conversation = provenance.conversationId
    const briefText = provenance?.humanSpans
      ? extractHumanSpans(payload, provenance.humanSpans)
      : withoutTaskHeaders(payload)
    if (briefText && briefText.trim()) {
      acc.sources.push({
        sourceId: normalizeSourceId(provenance?.sourceId, sessionId, String(message.id)),
        author: 'agent',
        sourceKind: 'task-brief',
        profileEligible: false,
        text: briefText,
        conversation: provenance?.conversationId ?? acc.conversation,
        eventSeq,
        at,
        timezone: tz,
      })
    }
    return
  }
  if (host && kind === 'viva-task-router-message') {
    const src = message.source as { conversationId?: string }
    acc.sessionKind = 'task'
    if (src.conversationId) acc.conversation = src.conversationId
    const body = withoutTaskHeaders(raw)
    if (body.trim()) {
      acc.sources.push({
        sourceId: normalizeSourceId(String(message.id), sessionId, String(message.id)),
        author: 'agent',
        sourceKind: 'task-brief',
        profileEligible: false,
        text: body,
        conversation: src.conversationId ?? acc.conversation,
        eventSeq,
        at,
        timezone: tz,
      })
    }
    return
  }
  const human = extractHumanMessages([message], { host, sessionId })
  if (human.length > 0) {
    const item = human[0]!
    if (item.sessionKind === 'task') acc.sessionKind = 'task'
    if (item.conversationId) acc.conversation = item.conversationId
    acc.sources.push({
      sourceId: item.sourceId,
      author: 'user',
      sourceKind: item.sourceKind,
      profileEligible: item.profileEligible,
      text: item.text,
      conversation: item.conversationId ?? acc.conversation,
      eventSeq,
      at,
      timezone: tz,
    })
    return
  }
  if (!host) return
  if (kind === 'user') {
    const resolved = resolveHostedProvenance(message, raw)
    if (!resolved) return
    const { provenance, payload } = resolved
    if (provenance.origin === 'unattended' || provenance.sourceKind === 'unattended' || provenance.sessionKind === 'unattended') {
      acc.sessionKind = 'unattended'
      return
    }
    if (provenance.sourceKind === 'viva-report-batch' || provenance.sourceKind === 'viva-report') {
      acc.hasReport = true
      if (provenance.conversationId) acc.conversation = provenance.conversationId
      return
    }
    if (provenance.origin === 'router' && provenance.sourceKind === 'task-brief') {
      acc.sessionKind = 'task'
      if (provenance.conversationId) acc.conversation = provenance.conversationId
      const briefText = provenance.humanSpans
        ? extractHumanSpans(payload, provenance.humanSpans)
        : withoutTaskHeaders(payload)
      if (briefText && briefText.trim()) {
        acc.sources.push({
          sourceId: normalizeSourceId(provenance.sourceId, sessionId, String(message.id)),
          author: 'agent',
          sourceKind: 'task-brief',
          profileEligible: false,
          text: briefText,
          conversation: provenance.conversationId ?? acc.conversation,
          eventSeq,
          at,
          timezone: tz,
        })
      }
    }
  }
}

function detectTurnMetaFromMessages(messages: readonly UserMessage[], host: boolean): { sessionKind: SessionKind, conversation?: string } {
  if (!host) return { sessionKind: 'main' }
  let sessionKind: SessionKind = 'main'
  let conversation: string | undefined
  for (const message of messages) {
    const kind = message.source.kind as string
    if (kind === 'viva-main-human-steer') {
      const src = message.source as { conversationId?: string }
      if (src.conversationId) conversation = src.conversationId
    } else if (kind === 'viva-task-human-steer' || kind === 'viva-task-router-message') {
      sessionKind = 'task'
      const src = message.source as { conversationId?: string }
      if (src.conversationId) conversation = src.conversationId
    } else if (kind === 'viva-task-brief') {
      sessionKind = 'task'
      const resolved = resolveHostedProvenance(message, textOf(message))
      if (resolved?.provenance.conversationId) conversation = resolved.provenance.conversationId
    } else if (kind === 'viva-unattended') {
      sessionKind = 'unattended'
    } else if (kind === 'viva-report-batch') {
      const resolved = resolveHostedProvenance(message, textOf(message))
      if (resolved?.provenance.conversationId) conversation = resolved.provenance.conversationId
    } else if (kind === 'user') {
      const resolved = resolveHostedProvenance(message, textOf(message))
      if (resolved) {
        sessionKind = resolved.provenance.sessionKind
        if (resolved.provenance.conversationId) conversation = resolved.provenance.conversationId
      }
    }
  }
  return { sessionKind, conversation }
}

type SessionQueue = {
  epoch: string | undefined
  work: Promise<void>
  coldRetryTimer: ReturnType<typeof setTimeout> | null
  coldFailures: number
  liveRetryTimer: ReturnType<typeof setTimeout> | null
  liveFailures: number
  needsCatchup: boolean
  lastSyncedSeq: number
}

/**
 * Single-source-of-truth DSH session-persistence ingestion (§5.2-§5.4, §5.6):
 * - All live turns and mid-turn `memory_remember` staging consume ONLY `readVerifiedDurableSlice`.
 * - Read-only cold catch-up enumerates `sessionPersistence.list()` with backoff and reads closed
 *   turns strictly via `open(id, 'read')` (never acquiring write leases).
 * - Live and cold paths share one per-sessionId serialization queue.
 */
export function createSessionIngestion(
  owner: Owner,
  sessions: SessionsLike,
  sessionPersistence: PersistenceLike | (() => PersistenceLike | undefined) | undefined,
  { host = false, onError }: { host?: boolean, onError?: (error: unknown) => void } = {},
) {
  const getPersistence = (): PersistenceLike | undefined =>
    typeof sessionPersistence === 'function' ? sessionPersistence() : sessionPersistence
  const queues = new Map<string, SessionQueue>()
  // Monotonic per-session live epoch retained across release/disposal so an in-flight
  // scanCold cannot race a session that opened (and possibly closed) mid-read (§5.5).
  const liveEpoch = new Map<string, number>()
  const markLive = (sessionId: string) => {
    liveEpoch.set(sessionId, (liveEpoch.get(sessionId) ?? 0) + 1)
  }
  let closed = false
  let listRetryTimer: ReturnType<typeof setTimeout> | null = null
  let listEpoch: string | undefined
  let listFailures = 0

  function clearListRetry() {
    if (listRetryTimer !== null) {
      clearTimeout(listRetryTimer)
      listRetryTimer = null
    }
  }

  function clearColdRetry(entry: SessionQueue) {
    if (entry.coldRetryTimer !== null) {
      clearTimeout(entry.coldRetryTimer)
      entry.coldRetryTimer = null
    }
  }

  function clearLiveRetry(entry: SessionQueue) {
    if (entry.liveRetryTimer !== null) {
      clearTimeout(entry.liveRetryTimer)
      entry.liveRetryTimer = null
    }
  }

  function enqueue(sessionId: string, action: () => Promise<void>) {
    let entry = queues.get(sessionId)
    if (!entry || entry.epoch !== owner.epoch) {
      if (entry) {
        clearColdRetry(entry)
        clearLiveRetry(entry)
      }
      entry = {
        epoch: owner.epoch,
        work: entry?.work.catch(() => {}) ?? Promise.resolve(),
        coldRetryTimer: null,
        coldFailures: 0,
        liveRetryTimer: null,
        liveFailures: 0,
        needsCatchup: false,
        lastSyncedSeq: 0,
      }
      queues.set(sessionId, entry)
    }
    const targetEpoch = entry.epoch
    entry.work = entry.work.catch(() => {}).then(() => owner.inEpoch(targetEpoch, action))
    return entry.work
  }

  /**
   * Process a contiguous persisted event slice `[fromSeq, endSeq)` using gap-free CAS settlement.
   * Only closed turns (`turn/start ... turn/end`) advance `next_seq` past the turn; any unclosed
   * trailing turn leaves `next_seq` right at its `turn/start.seq`.
   * Returns any open trailing turn's verified human sources if `collectOpenTurn` is true.
   */
  async function ingestPersistedEvents(input: {
    sessionId: string
    cwd?: string | null
    inheritedSeq: number
    createdAt: number
    cursorNextSeq: number | null
    sessionKind: SessionKind
    conversation: string | null
    events: readonly SessionEvent[]
    sliceFromSeq: number
    sliceEndSeq: number
    collectOpenTurn?: boolean
  }): Promise<{
    openTurn?: {
      turn: number
      sessionKind: SessionKind
      conversation: string | null
      sources: TurnSourceCandidate[]
      questionAnswers: TurnQuestionAnswerCandidate[]
    }
    casRetry?: boolean
  }> {
    const { sessionId, cwd, inheritedSeq, createdAt, events, sliceFromSeq, sliceEndSeq, collectOpenTurn = false } = input
    let expectedNextSeq = input.cursorNextSeq
    let currentSeq = sliceFromSeq
    let sessionKind: SessionKind = input.sessionKind
    let conversation: string | null = input.conversation
    const tz = timezone()

    // Skip events strictly before memory.db `created_at` when initializing a brand-new cursor.
    let idx = 0
    if (expectedNextSeq === null) {
      let skipToSeq: number | null = null
      let openStartSeq: number | null = null
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!
        if (ev.type === 'turn/start') openStartSeq = ev.seq
        if (ev.time >= createdAt) {
          const target = openStartSeq !== null ? openStartSeq : ev.seq
          if (target > sliceFromSeq) skipToSeq = target
          idx = events.findIndex(item => item.seq === target)
          if (idx < 0) idx = i
          break
        }
        if (ev.type === 'turn/end') {
          openStartSeq = null
          if (i === events.length - 1) {
            skipToSeq = ev.seq + 1
            idx = events.length
          }
        } else if (i === events.length - 1) {
          skipToSeq = openStartSeq !== null ? openStartSeq : sliceEndSeq
          idx = openStartSeq !== null ? events.findIndex(item => item.seq === openStartSeq) : events.length
          if (idx < 0) idx = events.length
        }
      }
      if (skipToSeq !== null && skipToSeq > sliceFromSeq) {
        const res = await owner.advanceIntakeCursor({
          sessionId, expectedNextSeq: null, nextSeq: skipToSeq, inheritedSeq, sessionKind, conversation, cwd,
        })
        if (res.status === 'cas_mismatch') return { casRetry: true }
        expectedNextSeq = res.nextSeq
        currentSeq = res.nextSeq
      }
    }

    let inTurn = false
    let turnNumber = 0
    let turnStartSeq = currentSeq
    let turnStartSessionKind: SessionKind = sessionKind
    let turnEvents: SessionEvent[] = []
    let acc: TurnClassification = { sessionKind, conversation: conversation ?? undefined, hasReport: false, sources: [], assistantParts: [] }

    for (; idx < events.length; idx++) {
      const event = events[idx]!
      if (event.seq < currentSeq) continue

      if (event.type === 'turn/start') {
        inTurn = true
        turnNumber = event.data.turn
        turnStartSeq = currentSeq
        turnStartSessionKind = sessionKind
        turnEvents = [event]
        acc = { sessionKind, conversation: conversation ?? undefined, hasReport: false, sources: [], assistantParts: [] }
        continue
      }
      turnEvents.push(event)
      if (event.type === 'user/message') {
        classifyUserMessageForTurn(event.data, Number(event.seq), event.time, tz, sessionId, host, acc)
        if (acc.sessionKind !== 'main') sessionKind = acc.sessionKind
        if (acc.conversation) conversation = acc.conversation
        continue
      }
      if (event.type === 'assistant/message' && !event.data.interrupted) {
        acc.assistantParts.push(textOf(event.data.message))
        continue
      }
      if (event.type === 'turn/end') {
        const toSeq = event.seq + 1
        const reasonKind = event.data.reason.kind
        // Share the exact same host + sessionKind assistant selector as readPersistedSessionRange
        // so stored assistant_digest and on-demand range reads always agree (including task goal turns).
        const assistantText = selectTurnAssistantText(turnEvents, host, turnStartSessionKind)
        const turnSources = [...acc.sources]
        const questionAnswers = host && reasonKind === 'completed' && acc.sessionKind !== 'unattended'
          ? foldQuestionAnswersForTurn(turnEvents, sessionId, tz)
          : []
        if (reasonKind === 'completed' && acc.sessionKind === 'task' && assistantText.trim() && !looksSecret(assistantText)) {
          turnSources.push({
            sourceId: deterministicSourceUuid('task-assistant', sessionId, event.seq),
            author: 'assistant',
            sourceKind: 'task-assistant',
            profileEligible: false,
            text: assistantText,
            conversation: acc.conversation ?? conversation,
            eventSeq: Number(event.seq),
            at: event.time,
            timezone: tz,
          })
        }
        const res = await owner.settleTurn({
          sessionId,
          cwd,
          sessionKind: acc.sessionKind,
          conversation: acc.conversation ?? conversation,
          inheritedSeq,
          expectedNextSeq,
          fromSeq: inTurn ? turnStartSeq : currentSeq,
          toSeq,
          turn: event.data.turn,
          reasonKind,
          sources: turnSources,
          ...(questionAnswers.length > 0 ? { questionAnswers } : {}),
          assistantText: reasonKind === 'completed' ? assistantText : '',
          at: event.time,
          timezone: tz,
          flushNotes: acc.sessionKind === 'task',
        })
        if (res.status === 'cas_mismatch') return { casRetry: true }
        if (res.status === 'scope_unavailable') throw new Error('Memory intake project scope temporarily unavailable')
        expectedNextSeq = res.nextSeq
        currentSeq = res.nextSeq
        inTurn = false
        turnNumber = 0
        continue
      }
    }

    if (inTurn) {
      // Unclosed trailing turn: NEVER advance next_seq past turn/start.
      if (collectOpenTurn && turnNumber > 0) {
        return {
          openTurn: {
            turn: turnNumber,
            sessionKind: acc.sessionKind,
            conversation: acc.conversation ?? conversation,
            sources: acc.sources.filter(src => src.author === 'user' || src.author === 'answer'),
            questionAnswers: host && acc.sessionKind !== 'unattended'
              ? foldQuestionAnswersForTurn(turnEvents, sessionId, tz)
              : [],
          },
        }
      }
      return {}
    }

    // Leave trailing post-turn non-turn events (e.g. model/selection on session reopen)
    // for the next turn's gap-free [fromSeq, toSeq) settlement rather than issuing an extra RPC.
    return {}
  }

  function scheduleLiveSessionRetry(session: Session) {
    if (closed) return
    const sessionId = String(session.id)
    const entry = queues.get(sessionId)
    if (!entry || entry.epoch !== owner.epoch) return
    if (sessions.get && sessions.get(session.id) !== session) return
    entry.needsCatchup = true
    clearLiveRetry(entry)
    entry.liveFailures++
    const delayMs = Math.min(COLD_RETRY_MAX_MS, COLD_RETRY_BASE_MS * 2 ** Math.min(entry.liveFailures - 1, 6))
    entry.liveRetryTimer = setTimeout(() => {
      entry.liveRetryTimer = null
      if (closed || entry.epoch !== owner.epoch) return
      if (sessions.get && sessions.get(session.id) !== session) return
      const targetEndSeq = Number(session.seq)
      void enqueue(sessionId, () => scanLive(session, false, targetEndSeq)).catch(err => {
        onError?.(err)
        scheduleLiveSessionRetry(session)
      })
    }, delayMs)
    entry.liveRetryTimer.unref?.()
  }

  async function scanLive(session: Session, stageOpenTurn: boolean, maxEndSeq: number): Promise<void> {
    const sessionId = String(session.id)
    const inherited = session.inheritedEventCount
    // Bound each live scan to the enqueue-time seq so an earlier queued scan never
    // swallows a later turn/end appended after a subsequent queued receipt slot (§5.5).
    const end = Math.min(Number(session.seq), maxEndSeq)
    const entry = queues.get(sessionId)
    for (let attempt = 0; attempt < 2; attempt++) {
      let cursor
      try {
        cursor = await owner.intakeCursor(sessionId)
      } catch (error) {
        if (!stageOpenTurn) scheduleLiveSessionRetry(session)
        throw error
      }
      const fromSeq = cursor.nextSeq === null ? inherited : Math.max(inherited, cursor.nextSeq)
      if (fromSeq >= end) {
        if (entry) {
          entry.needsCatchup = false
          entry.liveFailures = 0
          entry.lastSyncedSeq = Math.max(entry.lastSyncedSeq, end)
          clearLiveRetry(entry)
        }
        return
      }
      const persistence = getPersistence()
      if (!persistence) {
        if (stageOpenTurn) throw new Error('Memory durability verification failed: persistence-unavailable')
        if (entry) entry.needsCatchup = true
        return
      }
      const slice = await readVerifiedDurableSlice(sessions, persistence, session, fromSeq, end)
      if (!slice.ok) {
        if (stageOpenTurn) {
          throw new Error(`Memory durability verification failed: ${slice.reason}`)
        }
        if (slice.reason !== 'not-found') {
          scheduleLiveSessionRetry(session)
        }
        return
      }
      let outcome
      try {
        outcome = await ingestPersistedEvents({
          sessionId,
          cwd: session.header.cwd,
          inheritedSeq: inherited,
          createdAt: cursor.createdAt,
          cursorNextSeq: cursor.nextSeq,
          sessionKind: cursor.sessionKind,
          conversation: cursor.conversation,
          events: slice.events,
          sliceFromSeq: fromSeq,
          sliceEndSeq: end,
          collectOpenTurn: stageOpenTurn,
        })
      } catch (error) {
        if (!stageOpenTurn) scheduleLiveSessionRetry(session)
        throw error
      }
      if (outcome.casRetry) continue
      if (stageOpenTurn && outcome.openTurn) {
        await owner.stageOpenTurnSources({
          sessionId,
          turn: outcome.openTurn.turn,
          sessionKind: outcome.openTurn.sessionKind,
          conversation: outcome.openTurn.conversation,
          cwd: session.header.cwd,
          sources: outcome.openTurn.sources,
          ...(outcome.openTurn.questionAnswers.length > 0 ? { questionAnswers: outcome.openTurn.questionAnswers } : {}),
        })
      }
      if (entry) {
        entry.needsCatchup = false
        entry.liveFailures = 0
        entry.lastSyncedSeq = Math.max(entry.lastSyncedSeq, end)
        clearLiveRetry(entry)
      }
      return
    }
  }

  function scheduleColdSessionRetry(sessionId: string, header: SessionHeader) {
    if (closed) return
    const entry = queues.get(sessionId)
    if (!entry || entry.epoch !== owner.epoch) return
    if (sessions.get?.(SessionId(sessionId))) return
    clearColdRetry(entry)
    entry.coldFailures++
    const delayMs = Math.min(COLD_RETRY_MAX_MS, COLD_RETRY_BASE_MS * 2 ** Math.min(entry.coldFailures - 1, 6))
    entry.coldRetryTimer = setTimeout(() => {
      entry.coldRetryTimer = null
      if (closed || entry.epoch !== owner.epoch) return
      if (sessions.get?.(SessionId(sessionId))) return
      void scanCold(sessionId, header).catch(err => {
        onError?.(err)
        scheduleColdSessionRetry(sessionId, header)
      })
    }, delayMs)
    entry.coldRetryTimer.unref?.()
  }

  async function readAllPersistedFrom(sessionId: string, cursorNextSeq: number | null): Promise<
    | { status: 'ok', events: SessionEvent[], inheritedSeq: number, fromSeq: number, endSeq: number }
    | { status: 'not-found' }
    | { status: 'error', error: unknown }
  > {
    const persistence = getPersistence()
    if (!persistence) return { status: 'not-found' }
    let handle
    try {
      handle = await persistence.open(SessionId(sessionId), 'read')
    } catch (error) {
      if (isNotFoundError(error)) return { status: 'not-found' }
      return { status: 'error', error }
    }
    try {
      const inheritedSeq = Number(handle.inheritedEventCount ?? 0)
      const fromSeq = cursorNextSeq === null ? inheritedSeq : Math.max(inheritedSeq, cursorNextSeq)
      const events: SessionEvent[] = []
      let offset = fromSeq
      for (;;) {
        const batch = await handle.read(offset, READ_CHUNK_SIZE)
        if (!batch.events.length) break
        for (const ev of batch.events) events.push(ev)
        offset += batch.events.length
      }
      return { status: 'ok', events, inheritedSeq, fromSeq, endSeq: offset }
    } catch (error) {
      if (isNotFoundError(error)) return { status: 'not-found' }
      return { status: 'error', error }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  function scanCold(sessionId: string, header: SessionHeader, onTransientError?: () => void): Promise<void> {
    // Capture liveEpoch once at entry (before enqueue/cursor/read) so any session opening
    // (and even closing again) while this cold scan waits or reads supersedes it cleanly.
    const startEpoch = liveEpoch.get(sessionId) ?? 0
    const stale = () => closed || Boolean(sessions.get?.(SessionId(sessionId))) || (liveEpoch.get(sessionId) ?? 0) !== startEpoch
    const work = enqueue(sessionId, async () => {
      if (stale()) return
      for (let attempt = 0; attempt < 2; attempt++) {
        if (stale()) return
        const cursor = await owner.intakeCursor(sessionId)
        if (stale()) return
        const read = await readAllPersistedFrom(sessionId, cursor.nextSeq)
        if (stale()) return
        if (read.status === 'not-found') {
          await owner.retireSessionQuestionReceipts?.(sessionId)
          return
        }
        if (read.status === 'error') {
          onTransientError?.()
          onError?.(read.error)
          scheduleColdSessionRetry(sessionId, header)
          return
        }
        if (read.events.length === 0) return
        const outcome = await ingestPersistedEvents({
          sessionId,
          cwd: header.cwd,
          inheritedSeq: read.inheritedSeq,
          createdAt: cursor.createdAt,
          cursorNextSeq: cursor.nextSeq,
          sessionKind: cursor.sessionKind,
          conversation: cursor.conversation,
          events: read.events,
          sliceFromSeq: read.fromSeq,
          sliceEndSeq: read.endSeq,
          collectOpenTurn: false,
        })
        if (outcome.casRetry) continue
        const entry = queues.get(sessionId)
        if (entry) {
          entry.coldFailures = 0
          entry.needsCatchup = false
          entry.lastSyncedSeq = Math.max(entry.lastSyncedSeq, read.endSeq)
        }
        return
      }
    })
    void work.then(() => {
      const entry = queues.get(sessionId)
      if (entry && entry.work === work && entry.coldRetryTimer === null && entry.liveRetryTimer === null
        && !sessions.get?.(SessionId(sessionId))) {
        queues.delete(sessionId)
      }
    }).catch(() => {})
    return work
  }

  function startColdCatchup() {
    const persistence = getPersistence()
    if (closed || !owner.epoch || !persistence) return
    clearListRetry()
    const targetEpoch = owner.epoch
    listEpoch = targetEpoch
    listFailures = 0

    const runList = async () => {
      if (closed || owner.epoch !== targetEpoch || listEpoch !== targetEpoch) return
      let snapshots
      try {
        snapshots = await persistence.list()
      } catch (error) {
        onError?.(error)
        if (closed || owner.epoch !== targetEpoch || listEpoch !== targetEpoch) return
        listFailures++
        const delayMs = Math.min(COLD_RETRY_MAX_MS, COLD_RETRY_BASE_MS * 2 ** Math.min(listFailures - 1, 6))
        listRetryTimer = setTimeout(() => {
          listRetryTimer = null
          void runList()
        }, delayMs)
        listRetryTimer.unref?.()
        return
      }
      if (closed || owner.epoch !== targetEpoch || listEpoch !== targetEpoch) return
      const activeIds = new Set((sessions.list?.() ?? []).map(session => String(session.id)))
      let hadTransientError = false
      const coldTasks: Promise<void>[] = []
      for (const snap of snapshots) {
        const sid = String(snap.header.id)
        if (activeIds.has(sid) || sessions.get?.(snap.header.id)) continue
        const task = scanCold(sid, snap.header, () => { hadTransientError = true }).catch(err => {
          hadTransientError = true
          onError?.(err)
          scheduleColdSessionRetry(sid, snap.header)
        })
        coldTasks.push(task)
      }
      await Promise.allSettled(coldTasks)
      if (!hadTransientError && !closed && owner.epoch === targetEpoch && listEpoch === targetEpoch) {
        void owner.pruneExpiredQuestionReceipts?.().catch(err => onError?.(err))
      }
    }
    void runList()
  }

  return {
    synchronize(session: Session) {
      const sessionId = String(session.id)
      markLive(sessionId)
      const targetEndSeq = Number(session.seq)
      const entry = queues.get(sessionId)
      if (entry) {
        clearColdRetry(entry)
        clearLiveRetry(entry)
      }
      return enqueue(sessionId, () => scanLive(session, false, targetEndSeq))
    },
    stageOpenTurn(session: Session) {
      const sessionId = String(session.id)
      markLive(sessionId)
      const targetEndSeq = Number(session.seq)
      const entry = queues.get(sessionId)
      if (entry) clearColdRetry(entry)
      return enqueue(sessionId, () => scanLive(session, true, targetEndSeq))
    },
    beginTurn(session: Session, turn: number, messages: readonly UserMessage[]) {
      const sessionId = String(session.id)
      markLive(sessionId)
      const { sessionKind, conversation } = detectTurnMetaFromMessages(messages, host)
      return enqueue(sessionId, () => owner.beginTurn({
        sessionId,
        turn,
        sessionKind,
        conversation: conversation ?? null,
        cwd: session.header.cwd,
      }))
    },
    enqueueQuestionReceipt(receipt: QuestionReceiptInput) {
      markLive(receipt.sessionId)
      return enqueue(receipt.sessionId, async () => {
        if (closed || !owner.recordQuestionReceipt) return
        try {
          await owner.recordQuestionReceipt(receipt)
        } catch (error) {
          onError?.(error)
        }
      })
    },
    scanCold,
    startColdCatchup,
    release(session: Session) {
      const sessionId = String(session.id)
      const entry = queues.get(sessionId)
      const header = session.header
      const targetSeq = session.seq
      const targetEpoch = entry?.epoch ?? owner.epoch
      if (entry) {
        clearColdRetry(entry)
        clearLiveRetry(entry)
      }
      const currentWork = entry?.work ?? Promise.resolve()
      void currentWork.finally(() => {
        // Recompute unresolved state AFTER the in-flight live scan finishes so a turn
        // that settled cleanly during disposal never triggers a redundant cold scan.
        const stillUnresolved = !closed
          && Boolean(targetEpoch)
          && owner.epoch === targetEpoch
          && !sessions.get?.(session.id)
          && Boolean(getPersistence())
          && (Boolean(entry?.needsCatchup) || (entry ? targetSeq > entry.lastSyncedSeq : targetSeq > 0))
        if (stillUnresolved) {
          void scanCold(sessionId, header).catch(err => {
            onError?.(err)
            scheduleColdSessionRetry(sessionId, header)
          })
          return
        }
        if (entry && queues.get(sessionId) === entry && entry.work === currentWork) {
          queues.delete(sessionId)
        }
      }).catch(() => {})
    },
    async drain() {
      closed = true
      clearListRetry()
      for (const entry of queues.values()) {
        clearColdRetry(entry)
        clearLiveRetry(entry)
      }
      await Promise.allSettled([...queues.values()].map(entry => entry.work))
    },
  }
}
