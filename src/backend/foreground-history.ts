import { t } from '../shared/i18n/translate.ts'
import type { ImageRef } from '../shared/images.ts'
import { answerText, type AnsweredQuestion, type QuestionAnswer } from '../shared/question-answer.ts'
import { isSilentReply } from '../shared/task-report.ts'
import { turnProblem } from '../shared/turn-outcome.ts'
import type { Conversation, HistoryMessageMutation } from './history-db.ts'

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
  checkpoint?: (conversationId: string) => void
  markLatestPersisted?: (conversationId: string, type: string) => void
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
  by: string | null
  startedAt: number
  tools: number
  thoughts: number
  toolIds: Set<string>
  thoughtKeys: Set<string>
  openPlainThought: boolean
  plainText: string | null
  pendingPlainSegments: string[]
  hadAssistant: boolean
  lastAssistantKey?: string
  lastAssistantText?: string
  persistedStreamKeys: Set<string>
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
  checkpoint,
  markLatestPersisted,
  delegatedDuringTurn,
  onError = () => {},
  now = Date.now,
}: ForegroundHistoryDeps) {
  let active: ActiveTurn | null = null
  const pendingQuestions = new Map<string, Asked>()

  function newTurn(conversationId: string, by: string | null = null): ActiveTurn {
    return {
      conversationId,
      by,
      startedAt: now(),
      tools: 0,
      thoughts: 0,
      toolIds: new Set(),
      thoughtKeys: new Set(),
      openPlainThought: false,
      plainText: null,
      pendingPlainSegments: [],
      hadAssistant: false,
      persistedStreamKeys: new Set(),
    }
  }

  function ensureTurn(conversationId: string): ActiveTurn {
    if (!active || active.conversationId !== conversationId) active = newTurn(conversationId)
    return active
  }

  function closePlain(turn: ActiveTurn) {
    if (turn.plainText === null) return
    const text = turn.plainText
    turn.plainText = null
    if (!text) return
    turn.pendingPlainSegments.push(text)
    turn.hadAssistant = true
    turn.lastAssistantKey = undefined
    turn.lastAssistantText = text
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

  function persist(ops: readonly HistoryMessageMutation[], sessionOverride?: string | null): Conversation | null {
    if (!ops.length) return null
    try {
      const base = current()
      const { mode, model } = agentInfo()
      const saved = commit(
        { ...base, mode: mode ?? base.mode, model: model ?? base.model },
        ops,
        { sourceSession: sessionOverride !== undefined ? sessionOverride : sourceSession() },
      )
      if (current().id === saved.id) setCurrent(saved)
      return saved
    } catch (error) {
      onError(error)
      return null
    }
  }

  function userPrompt({ text, images, sourceId, advanceCheckpoint = false }: {
    text: string
    images?: readonly ImageRef[]
    sourceId?: string
    advanceCheckpoint?: boolean
  }) {
    const selected = current()
    const ops: HistoryMessageMutation[] = []
    if (active?.conversationId === selected.id) ops.push(...drainPlainOps(active))
    ops.push({
      kind: 'append_user',
      message: {
        role: 'user',
        text,
        receipt: null,
        ...(images?.length ? { images: [...images] } : {}),
        ...(sourceId ? { sourceId } : {}),
      },
    })
    const saved = persist(ops)
    if (saved && advanceCheckpoint) checkpoint?.(saved.id)
    return saved
  }

  function userSteer({ text, sourceId }: { text: string, sourceId?: string }) {
    const selected = current()
    const ops: HistoryMessageMutation[] = []
    if (active?.conversationId === selected.id) ops.push(...drainPlainOps(active))
    ops.push({
      kind: 'append_user',
      message: { role: 'user', text, receipt: null, ...(sourceId ? { sourceId } : {}) },
    })
    return persist(ops)
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
      const ops: HistoryMessageMutation[] = [
        ...drainPlainOps(turn),
        { kind: 'upsert_assistant', message: { role: 'assistant', text, receipt: null, key }, ...(beforeKey ? { beforeKey } : {}) },
      ]
      if (persist(ops, sessionId)) {
        turn.persistedStreamKeys.add(key)
        turn.hadAssistant = true
        if (!beforeKey || !turn.lastAssistantKey) {
          turn.lastAssistantKey = key
          turn.lastAssistantText = text
        }
      }
      return
    }
    if (turn.persistedStreamKeys.has(key)) {
      persist([{ kind: 'remove_stream', key }], sessionId)
      turn.persistedStreamKeys.delete(key)
      if (turn.lastAssistantKey === key) {
        turn.lastAssistantKey = undefined
        turn.lastAssistantText = undefined
        turn.hadAssistant = turn.persistedStreamKeys.size > 0 || turn.pendingPlainSegments.length > 0 || turn.plainText !== null
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
        turn.hadAssistant = true
        turn.lastAssistantKey = undefined
        turn.lastAssistantText = turn.plainText
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
          if (left.length) persist(left, session)
        }
        active = newTurn(ctx.conversationId, typeof raw.by === 'string' ? raw.by : null)
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
        const ops: HistoryMessageMutation[] = [
          ...(active?.conversationId === ctx.conversationId ? drainPlainOps(active) : []),
          ...replies,
        ]
        if (persist(ops, session)) markLatestPersisted?.(ctx.conversationId, 'question_answered')
        return
      }
      case 'update': {
        const turn = ensureTurn(ctx.conversationId)
        handleUpdate(turn, raw.update, session)
        return
      }
      case 'turn_end': {
        const turn = active?.conversationId === ctx.conversationId ? active : newTurn(ctx.conversationId)
        active = null
        closePlain(turn)
        const endedAt = now()
        const stopReason = typeof raw.stopReason === 'string' ? raw.stopReason : 'end_turn'
        const silentTask = stopReason === 'end_turn' && turn.by === 'task'
          && (!turn.hadAssistant || (turn.lastAssistantText !== undefined && isSilentReply(turn.lastAssistantText)))
        if (silentTask) {
          if (turn.lastAssistantKey && turn.persistedStreamKeys.has(turn.lastAssistantKey)) {
            persist([{ kind: 'remove_last_assistant', key: turn.lastAssistantKey }], session)
          }
          checkpoint?.(ctx.conversationId)
          return
        }
        const delegated = delegatedDuringTurn?.(turn.startedAt, endedAt) ?? false
        const finalReply = typeof raw.finalReply === 'boolean' ? raw.finalReply : undefined
        const reason = stopReason === 'end_turn' && finalReply === false && !delegated ? 'no_response' : stopReason
        const receipt = { ms: Math.max(0, endedAt - turn.startedAt), tools: turn.tools, thoughts: turn.thoughts, stopReason: reason }
        const ops: HistoryMessageMutation[] = drainPlainOps(turn)
        const problem = turnProblem(receipt.stopReason)
        if (!problem && receipt.stopReason !== 'cancelled' && turn.hadAssistant) {
          ops.push({ kind: 'attach_receipt', receipt, ...(turn.lastAssistantKey ? { key: turn.lastAssistantKey } : {}) })
        } else {
          const text = problem ?? (receipt.stopReason === 'cancelled' ? t('state.this.turn.was.stopped') : t('state.no.text.response.this.turn'))
          ops.push({ kind: 'append_note', message: { role: 'note', text, receipt } })
        }
        persist(ops, session)
        checkpoint?.(ctx.conversationId)
        return
      }
      case 'error': {
        if (active?.conversationId === ctx.conversationId) {
          const turn = active
          active = null
          const ops = drainPlainOps(turn)
          if (ops.length) persist(ops, session)
        }
        checkpoint?.(ctx.conversationId)
      }
    }
  }

  function flush() {
    if (!active) return
    const turn = active
    active = null
    if (turn.conversationId !== current().id) return
    const ops = drainPlainOps(turn)
    if (ops.length) persist(ops)
  }

  function reset() {
    active = null
    pendingQuestions.clear()
  }

  return { userPrompt, userSteer, receive, flush, reset }
}
export type ForegroundHistory = ReturnType<typeof createForegroundHistory>
