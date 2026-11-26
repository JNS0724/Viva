/**
 * viva-questions: when the model asks the user something (dsh's ask_user_question tool, enabled in the app's
 * profile next to this plugin), the question goes to the app's window and the tool waits for the answer.
 * dsh's ACP front end has no way to ask, so this plugin answers dsh's `user-questions/request` itself and
 * hands the question over the IPC channel the app opened when it started dsh (lib/channel.ts).
 * Loaded by the app's dsh profile (src/backend/dsh-profile.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// What dsh adds to the context: user-questions/request, tools/execute, and session/event.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import { createQuestionChannel, type HumanQuestionReceipt, type QuestionOccurrence } from './lib/channel.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** In-process synchronous notification from viva-questions to viva-memory before resolving ask(). */
    'viva-questions/human-answer-receipt'(receipt: HumanQuestionReceipt): void
    /** In-process synchronous probe letting viva-questions sample cached profileDeletionGen at start-event time. */
    'viva-memory/read-profile-deletion-gen'(probe: { value: number | null }): void
  }
}

export type { HumanQuestionReceipt, QuestionOccurrence }

export const name = 'viva-questions'
export const inject = ['agents']
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: questions are left to other answerers')
    return
  }
  // Per-session FIFO map of unclaimed ask_user_question start events, keyed by callId/subCallId.
  const pendingStarts = new Map<string, Map<string, QuestionOccurrence[]>>()
  const executionScope = new AsyncLocalStorage<QuestionOccurrence | null>()

  const pushStart = (sessionId: string, occurrence: QuestionOccurrence) => {
    let byCall = pendingStarts.get(sessionId)
    if (!byCall) {
      byCall = new Map()
      pendingStarts.set(sessionId, byCall)
    }
    const list = byCall.get(occurrence.callId)
    if (list) list.push(occurrence)
    else byCall.set(occurrence.callId, [occurrence])
  }

  const shiftStart = (sessionId: string, callId: string): QuestionOccurrence | undefined => {
    const byCall = pendingStarts.get(sessionId)
    const list = byCall?.get(callId)
    if (!list || list.length === 0) return undefined
    const claimed = list.shift()
    if (list.length === 0) byCall!.delete(callId)
    if (byCall!.size === 0) pendingStarts.delete(sessionId)
    return claimed
  }

  const sampleOpeningProfileGen = (): number | null => {
    const probe: { value: number | null } = { value: null }
    try {
      ctx.emit('viva-memory/read-profile-deletion-gen', probe)
    } catch {
      return null
    }
    return typeof probe.value === 'number' && Number.isSafeInteger(probe.value) && probe.value >= 0
      ? probe.value
      : null
  }

  const channel = createQuestionChannel(
    { send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) },
    log,
    receipt => { ctx.emit('viva-questions/human-answer-receipt', receipt) },
  )
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.effect(() => () => {
    pendingStarts.clear()
    channel.close()
  }, 'questions channel')

  ctx.on('session/disposed', session => {
    pendingStarts.delete(String(session.id))
  })

  ctx.on('session/event', (session, event) => {
    const sid = String(session.id)
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
      const turn = typeof event.data.turn === 'number' && Number.isSafeInteger(event.data.turn) && event.data.turn > 0
        ? event.data.turn
        : 0
      pushStart(sid, {
        callSeq: Number(event.seq),
        callId: String(event.data.callId),
        turn,
        kind: 'native',
        openingProfileGen: sampleOpeningProfileGen(),
      })
      return
    }
    if ((event.type as string) === 'tool/ptc-dispatch-start') {
      const data = event.data as { name?: unknown, subCallId?: unknown, parentCallId?: unknown, rootCallId?: unknown }
      if (data?.name === 'ask_user_question' && typeof data.subCallId === 'string' && data.subCallId.length > 0) {
        const boundary = ctx.agents.turnBoundaryOf(session)
        const turn = boundary?.openTurnStartSeq != null && Number.isSafeInteger(boundary.lastTurn) && boundary.lastTurn > 0
          ? boundary.lastTurn
          : 0
        pushStart(sid, {
          callSeq: Number(event.seq),
          callId: data.subCallId,
          turn,
          kind: 'ptc',
          ...(typeof data.parentCallId === 'string' ? { parentCallId: data.parentCallId } : {}),
          ...(typeof data.rootCallId === 'string' ? { rootCallId: data.rootCallId } : {}),
          openingProfileGen: sampleOpeningProfileGen(),
        })
      }
      return
    }
    if (event.type === 'tool/result') {
      shiftStart(sid, String(event.data.message.toolCallId))
      return
    }
    if ((event.type as string) === 'tool/ptc-dispatch') {
      const data = event.data as { name?: unknown, subCallId?: unknown }
      if (data?.name === 'ask_user_question' && typeof data.subCallId === 'string') {
        shiftStart(sid, data.subCallId)
      }
      return
    }
    if (event.type === 'step/end' || event.type === 'turn/end') {
      pendingStarts.delete(sid)
    }
  })

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'ask_user_question' || !exec.agent?.session) return next()
    const session = exec.agent.session
    const claimed = shiftStart(String(session.id), String(exec.callId))
    let occurrence: QuestionOccurrence | null = null
    if (claimed) {
      let turn = claimed.turn
      if (!Number.isSafeInteger(turn) || turn <= 0) {
        const boundary = ctx.agents.turnBoundaryOf(session)
        turn = boundary?.openTurnStartSeq != null && Number.isSafeInteger(boundary.lastTurn) && boundary.lastTurn > 0
          ? boundary.lastTurn
          : 0
      }
      if (turn > 0) occurrence = { ...claimed, turn }
    }
    return executionScope.run(occurrence, next)
  })

  ctx.on('user-questions/request', request => {
    const boundary = request.agent && ctx.agents.turnBoundaryOf(request.agent.session)
    const turn = boundary?.openTurnStartSeq != null ? boundary.lastTurn : undefined
    const occurrence = executionScope.getStore() ?? undefined
    return channel.ask(request, turn, occurrence)
  })
}
