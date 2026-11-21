import { t } from '../shared/i18n/translate.ts'
import type { ImageRef } from '../shared/images.ts'
import { answerText, type AnsweredQuestion, type QuestionAnswer } from '../shared/question-answer.ts'
import { isSilentReply } from '../shared/task-report.ts'
import { turnProblem } from '../shared/turn-outcome.ts'
import type { Conversation, HistoryMessageMutation } from './history-db.ts'
import { HistoryValidationError } from './history-schema.ts'

/**
 * Backend single-writer for the foreground conversation on screen. Mirrors the transcript rules of
 * renderer/conversation-state.ts, assistant-stream.ts and question-state.ts so history is persisted
 * incrementally in O(1) directly by the backend without renderer full-array write-backs.
 */

export interface ForegroundHistoryDeps {
  commit: (conversation: Conversation, ops: readonly HistoryMessageMutation[], options?: { sourceSession?: string | null }) => Conversation
  current: () => Conversation
  setCurrent: (conversation: Conversation) => void
  agentInfo: () => { mode?: string | null, model?: string | null }
  sourceSession: () => string | null
  streamCursor?: () => number
  checkpoint?: (conversationId: string, upToCursor?: number) => void
  markQuestionPersisted?: (conversationId: string, questionId: string) => void
  markPlainPersisted?: (conversationId: string, upToCursor?: number) => void
  delegatedDuringTurn?: (startedAt: number, endedAt: number) => boolean
  onError?: (error: unknown) => void
  now?: () => number
}

type RecordValue = Readonly<Record<string, unknown>>

interface Asked {
  conversationId: string
  questions: AnsweredQuestion[]
}

interface ActiveTurn {
  conversationId: string
  conversation: Conversation
  sessionId: string | null
  by: string | null
  startedAt: number
  tools: number
  thoughts: number
  toolIds: Set<string>
  thoughtKeys: Set<string>
  openPlainThought: boolean
  plainText: string | null
  pendingPlainSegments: string[]
  lastTurnMessage: { role: 'user' } | { role: 'assistant', text: string, key?: string } | null
  persistedStreamKeys: Set<string>
}

interface StreamBoundary {
  cursor?: number
}

interface PendingWrite {
  conversation: Conversation
  ops: HistoryMessageMutation[]
  session: string | null
  checkpointPending?: StreamBoundary
  plainPersistedPending?: StreamBoundary
  questionIds: string[]
}

const mergeBoundary = (a?: StreamBoundary, b?: StreamBoundary): StreamBoundary | undefined => {
  if (!a) return b
  if (!b) return a
  if (a.cursor === undefined || b.cursor === undefined) return { cursor: a.cursor ?? b.cursor }
  return { cursor: Math.max(a.cursor, b.cursor) }
}

const isRecord = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object'
const str = (value: unknown) => (typeof value === 'string' ? value : '')

function contentText(content: unknown): string {
  if (!isRecord(content)) return ''
  return content.type === 'text' ? str(content.text) : `[${str(content.type)}]`
}

function parseQuestions(raw: unknown): AnsweredQuestion[] | null {
  if (!Array.isArray(raw)) return null
  const items = raw.flatMap((item): AnsweredQuestion[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.question !== 'string') return []
    return [{ id: item.id, question: item.question, ...(typeof item.header === 'string' ? { header: item.header } : {}) }]
  })
  return items.length ? items : null
}

function parseAnswers(raw: unknown): QuestionAnswer[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): QuestionAnswer[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.selected)) return []
    const selected = item.selected.filter((label): label is string => typeof label === 'string')
    const custom = typeof item.custom === 'string' && item.custom.trim() ? item.custom.trim() : undefined
    return [{ id: item.id, selected, ...(custom ? { custom } : {}) }]
  })
}

function parseSourceIds(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, string> = Object.create(null)
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value) {
      out[key] = value
      count += 1
    }
  }
  return count ? out : undefined
}

export function createForegroundHistory({
  commit,
  current,
  setCurrent,
  agentInfo,
  sourceSession,
  streamCursor,
  checkpoint,
  markQuestionPersisted,
  markPlainPersisted,
  delegatedDuringTurn,
  onError = () => {},
  now = Date.now,
}: ForegroundHistoryDeps) {
  let active: ActiveTurn | null = null
  const pendingWrites = new Map<string, PendingWrite>()
  const pendingQuestions = new Map<string, Asked>()
  let retrying = false

  function newTurn(conversationId: string, by: string | null = null, sessionId: string | null = sourceSession()): ActiveTurn {
    return {
      conversationId,
      conversation: current(),
      sessionId,
      by,
      startedAt: now(),
      tools: 0,
      thoughts: 0,
      toolIds: new Set(),
      thoughtKeys: new Set(),
      openPlainThought: false,
      plainText: null,
      pendingPlainSegments: [],
      lastTurnMessage: null,
      persistedStreamKeys: new Set(),
    }
  }

  function ensureTurn(conversationId: string, sessionId: string | null = sourceSession()): ActiveTurn {
    if (!active || active.conversationId !== conversationId) active = newTurn(conversationId, null, sessionId)
    else if (sessionId) active.sessionId = sessionId
    return active
  }

  function closePlain(turn: ActiveTurn) {
    if (turn.plainText === null) return
    const text = turn.plainText
    turn.plainText = null
    if (!text) return
    turn.pendingPlainSegments.push(text)
    turn.lastTurnMessage = { role: 'assistant', text }
  }

  function drainPlainOps(turn: ActiveTurn): HistoryMessageMutation[] {
    closePlain(turn)
    if (!turn.pendingPlainSegments.length) return []
    const ops: HistoryMessageMutation[] = turn.pendingPlainSegments.map(text => ({
      kind: 'upsert_assistant',
      message: { role: 'assistant', text, receipt: null },
    }))
    turn.pendingPlainSegments = []
    return ops
  }

  function queuePending(
    conversation: Conversation,
    ops: readonly HistoryMessageMutation[],
    session: string | null,
    flags: { checkpointPending?: StreamBoundary, plainPersistedPending?: StreamBoundary, questionIds?: readonly string[] } = {},
  ) {
    const prior = pendingWrites.get(conversation.id)
    const questionIds = [...new Set([...(prior?.questionIds ?? []), ...(flags.questionIds ?? [])])]
    pendingWrites.set(conversation.id, {
      conversation,
      ops: prior ? [...prior.ops, ...ops] : [...ops],
      session: session ?? prior?.session ?? null,
      checkpointPending: mergeBoundary(prior?.checkpointPending, flags.checkpointPending),
      plainPersistedPending: mergeBoundary(prior?.plainPersistedPending, flags.plainPersistedPending),
      questionIds,
    })
  }

  function retryPending(excludeId?: string): boolean {
    if (retrying) return pendingWrites.size === 0
    retrying = true
    try {
      const selectedId = current().id
      // If a conversation switch happened while an active turn held buffered plain text, preserve it for its own conversation.
      if (active && active.conversationId !== selectedId) {
        const stale = active
        active = null
        const staleOps = drainPlainOps(stale)
        if (staleOps.length) queuePending(stale.conversation, staleOps, stale.sessionId, { plainPersistedPending: { cursor: streamCursor?.() } })
      }
      for (const [id, entry] of [...pendingWrites]) {
        if (id === excludeId) continue
        try {
          const saved = commit(entry.conversation, entry.ops, { sourceSession: entry.session })
          pendingWrites.delete(id)
          if (current().id === saved.id) setCurrent(saved)
          if (entry.plainPersistedPending) markPlainPersisted?.(saved.id, entry.plainPersistedPending.cursor)
          for (const questionId of entry.questionIds) markQuestionPersisted?.(saved.id, questionId)
          if (entry.checkpointPending) checkpoint?.(saved.id, entry.checkpointPending.cursor)
        } catch (error) {
          if (error instanceof HistoryValidationError) pendingWrites.delete(id)
          onError(error)
        }
      }
      return pendingWrites.size === 0
    } finally {
      retrying = false
    }
  }

  function persist(
    ops: readonly HistoryMessageMutation[],
    sessionOverride?: string | null,
    { plainPersisted = false, deferCheckpoint = false, questionIds = [] }: {
      plainPersisted?: boolean
      deferCheckpoint?: boolean
      questionIds?: readonly string[]
    } = {},
  ): { ok: boolean, saved: Conversation | null } {
    const base = current()
    // Best-effort retry any failed writes belonging to other conversations without dropping them.
    if (pendingWrites.size > 0) retryPending(base.id)
    const carried = pendingWrites.get(base.id)
    const allOps = carried ? [...carried.ops, ...ops] : [...ops]
    const allQuestionIds = [...new Set([...(carried?.questionIds ?? []), ...questionIds])]
    const boundary = (plainPersisted || deferCheckpoint) ? { cursor: streamCursor?.() } : undefined
    const plainBoundary = mergeBoundary(carried?.plainPersistedPending, plainPersisted ? boundary : undefined)
    const checkpointBoundary = mergeBoundary(carried?.checkpointPending, deferCheckpoint ? boundary : undefined)
    if (!allOps.length) {
      if (carried) pendingWrites.delete(base.id)
      if (plainBoundary) markPlainPersisted?.(base.id, plainBoundary.cursor)
      for (const questionId of allQuestionIds) markQuestionPersisted?.(base.id, questionId)
      if (checkpointBoundary) checkpoint?.(base.id, checkpointBoundary.cursor)
      return { ok: true, saved: null }
    }
    const { mode, model } = agentInfo()
    const target: Conversation = { ...base, mode: mode ?? base.mode, model: model ?? base.model }
    const session = sessionOverride !== undefined
      ? sessionOverride
      : carried?.session !== undefined
        ? carried.session
        : sourceSession()
    try {
      const saved = commit(target, allOps, { sourceSession: session })
      pendingWrites.delete(base.id)
      if (current().id === saved.id) setCurrent(saved)
      if (plainBoundary) markPlainPersisted?.(saved.id, plainBoundary.cursor)
      for (const questionId of allQuestionIds) markQuestionPersisted?.(saved.id, questionId)
      if (checkpointBoundary) checkpoint?.(saved.id, checkpointBoundary.cursor)
      return { ok: true, saved }
    } catch (error) {
      // Permanent validation errors must not poison pendingWrites and block subsequent turns in this conversation;
      // leave any prior transient carried writes intact and refuse to advance the checkpoint for this failed batch.
      if (!(error instanceof HistoryValidationError)) {
        pendingWrites.set(base.id, {
          conversation: target,
          ops: allOps,
          session,
          checkpointPending: checkpointBoundary,
          plainPersistedPending: plainBoundary,
          questionIds: allQuestionIds,
        })
      }
      onError(error)
      return { ok: false, saved: null }
    }
  }

  function userPrompt({ text, images, sourceId, advanceCheckpoint = false }: {
    text: string
    images?: readonly ImageRef[]
    sourceId?: string
    advanceCheckpoint?: boolean
  }) {
    const selected = current()
    const plain = active?.conversationId === selected.id ? drainPlainOps(active) : []
    const ops: HistoryMessageMutation[] = [
      ...plain,
      {
        kind: 'append_user',
        message: {
          role: 'user',
          text,
          receipt: null,
          ...(images?.length ? { images: [...images] } : {}),
          ...(sourceId ? { sourceId } : {}),
        },
      },
    ]
    const result = persist(ops, undefined, { plainPersisted: plain.length > 0, deferCheckpoint: advanceCheckpoint })
    return result.saved
  }

  function userSteer({ text, sourceId }: { text: string, sourceId?: string }) {
    const selected = current()
    const plain = active?.conversationId === selected.id ? drainPlainOps(active) : []
    if (active?.conversationId === selected.id) active.lastTurnMessage = { role: 'user' }
    const ops: HistoryMessageMutation[] = [
      ...plain,
      {
        kind: 'append_user',
        message: { role: 'user', text, receipt: null, ...(sourceId ? { sourceId } : {}) },
      },
    ]
    return persist(ops, undefined, { plainPersisted: plain.length > 0 }).saved
  }

  function eventContext(event: RecordValue): { conversationId: string, sessionId: string | null } | null {
    const raw = isRecord(event.context) ? event.context : null
    const conversationId = raw && typeof raw.conversationId === 'string' ? raw.conversationId : null
    if (!conversationId) return null
    const sessionId = raw && typeof raw.sessionId === 'string' ? raw.sessionId : null
    return { conversationId, sessionId }
  }

  function handleStream(turn: ActiveTurn, update: RecordValue, sessionId: string | null) {
    const key = str(update.key)
    if (!key) return
    if (update.kind !== 'settle') {
      if (update.blockType === 'reasoning' && str(update.text) && !turn.thoughtKeys.has(key)) {
        turn.thoughtKeys.add(key)
        turn.thoughts += 1
      }
      return
    }
    if (!Array.isArray(update.blocks)) return
    const blocks = update.blocks.filter(isRecord)
    const hasReasoning = blocks.some(block => block.type === 'reasoning' && Boolean(str(block.text)))
    if (hasReasoning && !turn.thoughtKeys.has(key)) {
      turn.thoughtKeys.add(key)
      turn.thoughts += 1
    } else if (!hasReasoning && turn.thoughtKeys.has(key)) {
      turn.thoughtKeys.delete(key)
      turn.thoughts = Math.max(0, turn.thoughts - 1)
    }
    const text = blocks.filter(block => block.type === 'text' && Boolean(str(block.text))).map(block => str(block.text)).join('')
    const beforeKey = isRecord(update.before) && str(update.before.text) ? str(update.before.text) : undefined
    if (text) {
      const plain = drainPlainOps(turn)
      const ops: HistoryMessageMutation[] = [
        ...plain,
        { kind: 'upsert_assistant', message: { role: 'assistant', text, receipt: null, key }, ...(beforeKey ? { beforeKey } : {}) },
      ]
      // Track the settled stream in the logical turn even if commit fails so retries and turn_end stay ordered.
      persist(ops, sessionId, { plainPersisted: plain.length > 0 })
      turn.persistedStreamKeys.add(key)
      if (!beforeKey || !turn.lastTurnMessage || (turn.lastTurnMessage.role === 'assistant' && turn.lastTurnMessage.key === key)) {
        turn.lastTurnMessage = { role: 'assistant', text, key }
      }
      return
    }
    if (turn.persistedStreamKeys.has(key)) {
      persist([{ kind: 'remove_stream', key }], sessionId)
      turn.persistedStreamKeys.delete(key)
      if (turn.lastTurnMessage?.role === 'assistant' && turn.lastTurnMessage.key === key) {
        const lastPlain = turn.pendingPlainSegments.at(-1)
        turn.lastTurnMessage = lastPlain !== undefined ? { role: 'assistant', text: lastPlain } : null
      }
    }
  }

  function handleUpdate(turn: ActiveTurn, update: unknown, sessionId: string | null) {
    if (!isRecord(update)) return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const chunk = contentText(update.content)
        if (!chunk) return
        turn.openPlainThought = false
        turn.plainText = (turn.plainText ?? '') + chunk
        turn.lastTurnMessage = { role: 'assistant', text: turn.plainText }
        return
      }
      case 'viva_stream':
        handleStream(turn, update, sessionId)
        return
      case 'agent_thought_chunk': {
        if (!contentText(update.content)) return
        closePlain(turn)
        if (!turn.openPlainThought) {
          turn.openPlainThought = true
          turn.thoughts += 1
        }
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = str(update.toolCallId)
        if (!id) return
        closePlain(turn)
        turn.openPlainThought = false
        if (!turn.toolIds.has(id)) {
          turn.toolIds.add(id)
          turn.tools += 1
        }
        return
      }
    }
  }

  function receive(raw: unknown) {
    if (!isRecord(raw) || typeof raw.type !== 'string') return
    const ctx = eventContext(raw)
    if (!ctx) return
    const selected = current()
    if (ctx.conversationId !== selected.id) return
    const session = ctx.sessionId ?? sourceSession()

    switch (raw.type) {
      case 'turn_started': {
        if (active?.conversationId === ctx.conversationId) {
          const left = drainPlainOps(active)
          if (left.length) persist(left, session, { plainPersisted: true })
        }
        active = newTurn(ctx.conversationId, typeof raw.by === 'string' ? raw.by : null, session)
        return
      }
      case 'permission': {
        if (active?.conversationId === ctx.conversationId) {
          closePlain(active)
          active.openPlainThought = false
        }
        return
      }
      case 'question': {
        const questionId = str(raw.questionId)
        const questions = parseQuestions(raw.questions)
        if (questionId && questions) pendingQuestions.set(questionId, { conversationId: ctx.conversationId, questions })
        if (active?.conversationId === ctx.conversationId) {
          closePlain(active)
          active.openPlainThought = false
        }
        return
      }
      case 'question_closed': {
        const questionId = str(raw.questionId)
        if (questionId) pendingQuestions.delete(questionId)
        return
      }
      case 'question_answered': {
        const questionId = str(raw.questionId)
        const asked = questionId ? pendingQuestions.get(questionId) : undefined
        if (!asked || asked.conversationId !== ctx.conversationId) return
        pendingQuestions.delete(questionId)
        const answers = parseAnswers(raw.answers)
        const sourceId = typeof raw.sourceId === 'string' && raw.sourceId ? raw.sourceId : undefined
        const sourceIds = parseSourceIds(raw.sourceIds)
        const replies: HistoryMessageMutation[] = sourceIds
          ? asked.questions.map(question => ({
            kind: 'append_user' as const,
            message: {
              role: 'user' as const,
              text: answerText([question], answers),
              receipt: null,
              ...(Object.hasOwn(sourceIds, question.id) ? { sourceId: sourceIds[question.id] } : {}),
            },
          }))
          : [{ kind: 'append_user' as const, message: { role: 'user' as const, text: answerText(asked.questions, answers), receipt: null, ...(sourceId ? { sourceId } : {}) } }]
        const plain = active?.conversationId === ctx.conversationId ? drainPlainOps(active) : []
        const ops: HistoryMessageMutation[] = [...plain, ...replies]
        if (active?.conversationId === ctx.conversationId) active.lastTurnMessage = { role: 'user' }
        persist(ops, session, { plainPersisted: plain.length > 0, questionIds: [questionId] })
        return
      }
      case 'update': {
        const turn = ensureTurn(ctx.conversationId, session)
        handleUpdate(turn, raw.update, session)
        return
      }
      case 'turn_end': {
        const turn = active?.conversationId === ctx.conversationId ? active : newTurn(ctx.conversationId, null, session)
        active = null
        closePlain(turn)
        const endedAt = now()
        const stopReason = typeof raw.stopReason === 'string' ? raw.stopReason : 'end_turn'
        const last = turn.lastTurnMessage
        const silentTask = stopReason === 'end_turn' && turn.by === 'task'
          && (!last || (last.role === 'assistant' && isSilentReply(last.text)))
        if (silentTask) {
          const ops: HistoryMessageMutation[] = []
          if (last?.role === 'assistant') {
            if (last.key) {
              ops.push(...drainPlainOps(turn))
              if (turn.persistedStreamKeys.has(last.key)) {
                ops.push({ kind: 'remove_last_assistant', key: last.key })
              }
            } else {
              // Drop only the trailing silent plain segment; preserve earlier plain segments from this turn.
              turn.pendingPlainSegments.pop()
              ops.push(...drainPlainOps(turn))
            }
          } else {
            ops.push(...drainPlainOps(turn))
          }
          persist(ops, session, { deferCheckpoint: true })
          return
        }
        const delegated = delegatedDuringTurn?.(turn.startedAt, endedAt) ?? false
        const finalReply = typeof raw.finalReply === 'boolean' ? raw.finalReply : undefined
        const reason = stopReason === 'end_turn' && finalReply === false && !delegated ? 'no_response' : stopReason
        const receipt = { ms: Math.max(0, endedAt - turn.startedAt), tools: turn.tools, thoughts: turn.thoughts, stopReason: reason }
        const ops: HistoryMessageMutation[] = drainPlainOps(turn)
        const problem = turnProblem(receipt.stopReason)
        if (!problem && receipt.stopReason !== 'cancelled' && last?.role === 'assistant') {
          ops.push({ kind: 'attach_receipt', receipt, ...(last.key ? { key: last.key } : {}) })
        } else {
          const text = problem ?? (receipt.stopReason === 'cancelled' ? t('state.this.turn.was.stopped') : t('state.no.text.response.this.turn'))
          ops.push({ kind: 'append_note', message: { role: 'note', text, receipt } })
        }
        persist(ops, session, { deferCheckpoint: true })
        return
      }
      case 'error': {
        let ops: HistoryMessageMutation[] = []
        if (active?.conversationId === ctx.conversationId) {
          const turn = active
          active = null
          ops = drainPlainOps(turn)
        }
        persist(ops, session, { deferCheckpoint: true })
      }
    }
  }

  function flush() {
    const selected = current()
    if (active) {
      const turn = active
      active = null
      const ops = drainPlainOps(turn)
      if (turn.conversationId === selected.id) {
        persist(ops, turn.sessionId, { plainPersisted: ops.length > 0 })
      } else if (ops.length) {
        queuePending(turn.conversation, ops, turn.sessionId, { plainPersistedPending: { cursor: streamCursor?.() } })
      }
    }
    return retryPending()
  }

  function reset() {
    active = null
    pendingQuestions.clear()
  }

  return { userPrompt, userSteer, receive, flush, retryPending, reset, hasPendingWrites: () => pendingWrites.size > 0 }
}
export type ForegroundHistory = ReturnType<typeof createForegroundHistory>
