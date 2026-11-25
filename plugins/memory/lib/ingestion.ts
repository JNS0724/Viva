import { SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { createRemoteMemoryOwner } from './remote-owner.ts'

type Owner = Pick<ReturnType<typeof createRemoteMemoryOwner>, 'epoch' | 'inEpoch' | 'receiveSource' | 'completeTurn'
  | 'intakeWatermark' | 'advanceIntake'>
type SnapshotEvents = ReturnType<Session['snapshotEvents']>
const DEFAULT_ALIAS_GRACE_MS = 1_500
const ALIAS_RETRY_INTERVAL_MS = 100

type Replay = {
  epoch: string | undefined
  session: Session
  nextSeq: number | null
  turn: number
  sources: Set<string>
  assistant: string[]
  receivedReport: boolean
  work: Promise<void>
  awaitingSince: Map<string, number>
  retryTimer: ReturnType<typeof setTimeout> | null
  released: boolean
  releaseDeadline: number | null
  inFlight: number
  pendingEvents: SnapshotEvents | null
}
const textOf = (message: { content: readonly { type: string, text?: string }[] }) =>
  message.content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function humanMessages(messages: readonly UserMessage[]) {
  return messages.filter(message => message.source.kind === 'user').map(message => ({ id: message.id, text: textOf(message) }))
}

/** The owner remembers committed turn boundaries. An interrupted scan can replay
 * incomplete work, with the native message ID identifying the same original. */
export function createSessionIngestion(
  owner: Owner,
  flush: (session: Session) => Promise<unknown>,
  { host = false, aliasGraceMs = DEFAULT_ALIAS_GRACE_MS, onError }: { host?: boolean, aliasGraceMs?: number, onError?: (error: unknown) => void } = {},
) {
  const sessions = new Map<string, Replay>()
  let closed = false

  function clearRetry(state: Replay) {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
  }

  const hasPendingWork = (state: Replay) => state.awaitingSince.size > 0 || Boolean(state.pendingEvents?.length)

  function settleReleased(state: Replay) {
    const sessionId = String(state.session.id)
    if (!state.released || state.inFlight > 0 || sessions.get(sessionId) !== state) return
    if (!hasPendingWork(state) || state.epoch !== owner.epoch) {
      clearRetry(state)
      state.releaseDeadline = null
      sessions.delete(sessionId)
      return
    }
    if (!closed && state.retryTimer === null && state.pendingEvents?.length) {
      const deadline = state.releaseDeadline ?? (Date.now() + aliasGraceMs)
      state.releaseDeadline = deadline
      scheduleResume(state, Math.min(ALIAS_RETRY_INTERVAL_MS, Math.max(10, deadline - Date.now())))
    }
  }

  function handleReleasedError(state: Replay, error: unknown) {
    const sessionId = String(state.session.id)
    const nowMs = Date.now()
    if (state.releaseDeadline === null) state.releaseDeadline = nowMs + aliasGraceMs
    const remaining = state.releaseDeadline - nowMs
    if (!closed && remaining > 0 && state.pendingEvents?.length && sessions.get(sessionId) === state) {
      scheduleResume(state, Math.min(ALIAS_RETRY_INTERVAL_MS, Math.max(10, remaining)))
    } else {
      state.awaitingSince.clear()
      state.pendingEvents = null
      onError?.(error)
    }
  }

  function enqueue(session: Session, action: (state: Replay) => Promise<void>) {
    const sessionId = String(session.id)
    let state = sessions.get(sessionId)
    if (!state || state.session !== session || state.epoch !== owner.epoch) {
      if (state) clearRetry(state)
      state = { epoch: owner.epoch, session, nextSeq: null, turn: 0, sources: new Set(),
        assistant: [], receivedReport: false, work: state?.work.catch(() => {}) ?? Promise.resolve(),
        awaitingSince: new Map(), retryTimer: null, released: false, releaseDeadline: null, inFlight: 0, pendingEvents: null }
      sessions.set(sessionId, state)
    }
    const entry = state
    entry.inFlight++
    entry.work = entry.work.catch(() => {}).then(() => owner.inEpoch(entry.epoch, () => action(entry)))
      .finally(() => {
        entry.inFlight = Math.max(0, entry.inFlight - 1)
        settleReleased(entry)
      })
    return entry.work
  }

  async function original(state: Replay, turn: number, message: UserMessage, at: number, live: boolean, deferMissingAlias = false) {
    if (message.source.kind !== 'user') return
    const text = textOf(message)
    if (!text.trim() && !message.content.some(part => part.type === 'image' || part.type === 'file')) return
    return owner.receiveSource({ sessionId: String(state.session.id), messageId: message.id, text, at, timezone: timezone(),
      turn, live, cwd: state.session.header.cwd, task: state.session.header.origin === 'subagent',
      derived: state.session.header.origin === 'subagent'
        && !('rpcId' in message.source && typeof message.source.rpcId === 'string'),
      ...(deferMissingAlias ? { deferMissingAlias: true } : {}) })
  }

  function scheduleResume(state: Replay, waitMs: number) {
    const sessionId = String(state.session.id)
    if (closed || sessions.get(sessionId) !== state) return
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      if (closed || sessions.get(sessionId) !== state) return
      if (state.released) void resumeReleased(state).catch(() => {})
      else void synchronize(state.session).catch(() => {})
    }, waitMs)
    state.retryTimer.unref?.()
  }

  async function processEvents(state: Replay, events: SnapshotEvents) {
    const session = String(state.session.id)
    for (let idx = 0; idx < events.length; idx++) {
      const event = events[idx]!
      try {
        if (event.type === 'turn/start') {
          state.turn = event.data.turn
          state.sources.clear()
          state.assistant = []
          state.receivedReport = false
        }
        if (event.type === 'user/message') {
          const kind: string = event.data.source.kind
          if (kind === 'viva-report') state.receivedReport = true
          const msgId = String(event.data.id)
          const nowMs = Date.now()
          let firstSeen = state.awaitingSince.get(msgId)
          const remaining = state.released && state.releaseDeadline !== null
            ? state.releaseDeadline - nowMs
            : firstSeen === undefined ? aliasGraceMs : aliasGraceMs - (nowMs - firstSeen)
          const canDefer = host && remaining > 0
          const receipt = await original(state, state.turn, event.data, event.time, false, canDefer)
          if (receipt?.awaitingAlias) {
            if (firstSeen === undefined) {
              firstSeen = nowMs
              state.awaitingSince.set(msgId, firstSeen)
            }
            // Stop right at this event, preserving previously folded turn state (sources, assistant, receivedReport).
            state.nextSeq = event.seq
            state.pendingEvents = events.slice(idx)
            const waitMs = Math.min(ALIAS_RETRY_INTERVAL_MS, Math.max(10, remaining))
            scheduleResume(state, waitMs)
            return
          }
          state.awaitingSince.delete(msgId)
          if (receipt && !receipt.handledIntent) state.sources.add(receipt.sourceId)
        }
        if (event.type === 'assistant/message' && !event.data.interrupted) state.assistant.push(textOf(event.data.message))
        if (event.type === 'turn/end') {
          await owner.completeTurn({ sessionId: session, turn: event.data.turn, eventSeq: event.seq,
            sourceIds: [...state.sources], assistant: state.receivedReport ? '' : state.assistant.join('\n'), completed: event.data.reason.kind === 'completed',
            at: event.time, timezone: timezone() })
        }
        state.nextSeq = event.seq + 1
      } catch (error) {
        state.nextSeq = event.seq
        state.pendingEvents = events.slice(idx)
        throw error
      }
    }
    state.pendingEvents = null
  }

  async function scan(state: Replay, end: SessionLogOffset, persisted: Promise<unknown>) {
    if (!state.released) {
      if (await persisted !== true) return
    } else {
      let ok = false
      try { ok = await persisted === true } catch { ok = false }
      if (!ok) {
        if (hasPendingWork(state) && state.pendingEvents?.length) {
          clearRetry(state)
          try { await processEvents(state, state.pendingEvents) }
          catch (error) { handleReleasedError(state, error) }
        }
        return
      }
    }
    clearRetry(state)
    const session = String(state.session.id)
    const inherited = state.session.inheritedEventCount
    if (state.nextSeq === null) {
      const { createdAt, nextSeq } = await owner.intakeWatermark(session)
      if (nextSeq === null) {
        const first = state.session.snapshotEvents(inherited, end).find(event => event.time >= createdAt)
        const start = first?.seq ?? end
        await owner.advanceIntake(session, start)
        state.nextSeq = start
      } else state.nextSeq = nextSeq
    }
    const from = Math.max(inherited, state.nextSeq)
    if (from >= end) return
    const events = state.session.snapshotEvents(SessionLogOffset(from), end)
    try {
      await processEvents(state, events)
    } catch (error) {
      if (state.released) handleReleasedError(state, error)
      else throw error
    }
  }

  function resumeReleased(state: Replay) {
    const sessionId = String(state.session.id)
    if (state.epoch !== owner.epoch) {
      clearRetry(state)
      if (sessions.get(sessionId) === state) sessions.delete(sessionId)
      return Promise.resolve()
    }
    state.inFlight++
    state.work = state.work.catch(() => {}).then(() => owner.inEpoch(state.epoch, async () => {
      if (sessions.get(sessionId) !== state) return
      clearRetry(state)
      const pending = state.pendingEvents
      if (!pending || pending.length === 0) {
        state.awaitingSince.clear()
        state.releaseDeadline = null
        return
      }
      try {
        await processEvents(state, pending)
      } catch (error) {
        handleReleasedError(state, error)
      }
    })).finally(() => {
      state.inFlight = Math.max(0, state.inFlight - 1)
      settleReleased(state)
    })
    return state.work
  }

  function synchronize(session: Session, current?: { messages: readonly UserMessage[], turn: number }) {
    const end = session.seq
    const persisted = flush(session)
    void persisted.catch(() => {})
    return enqueue(session, async state => {
      await scan(state, end, persisted)
      if (!current) return
      for (const message of current.messages) await original(state, current.turn, message, Date.now(), true)
    })
  }
  return {
    synchronize,
    receive(session: Session, messages: readonly UserMessage[], turn: number) {
      return synchronize(session, { messages, turn })
    },
    wakeIfAwaiting(sessionId: string) {
      if (closed) return
      const state = sessions.get(sessionId)
      if (!state || !hasPendingWork(state)) return
      if (state.released) void resumeReleased(state).catch(() => {})
      else void synchronize(state.session).catch(() => {})
    },
    release(session: Session) {
      const sessionId = String(session.id)
      const state = sessions.get(sessionId)
      if (state?.session !== session) return
      if (hasPendingWork(state) || state.inFlight > 0) {
        state.released = true
        if (state.releaseDeadline === null) {
          const anchor = state.awaitingSince.size > 0 ? Math.min(...state.awaitingSince.values()) : Date.now()
          state.releaseDeadline = anchor + aliasGraceMs
        }
        settleReleased(state)
        return
      }
      clearRetry(state)
      sessions.delete(sessionId)
    },
    async drain() {
      closed = true
      for (const state of sessions.values()) clearRetry(state)
      await Promise.allSettled([...sessions.values()].map(state => state.work))
    },
  }
}
