import { randomUUID } from 'node:crypto'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { appendPluginRecord, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { NativeOutputAttempt, NativeOutputTerminal } from '../../../../src/memory/node/native-output-attempts.ts'
import { nativeEventDigest } from './event-digest.ts'

export const NATIVE_OUTPUT_MARKER = 'plugin:viva-memory/output-attempt'
type Marker = { id: string, generation: number, turn: number, step: number }
declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap { [NATIVE_OUTPUT_MARKER]: Marker }
}

type OutputEvent = SessionEvent<'assistant/message' | 'assistant/attempt'>
type Running = { attemptId: string, marker: Marker, attempt?: NativeOutputAttempt, events: Map<number, OutputEvent> }

/** Connects the live loop's own output attempt to its eventual durable event. */
export function trackNativeOutputAttempts(
  contextGeneration: (session: string) => number | undefined,
  finish: (attempt: NativeOutputAttempt, terminal?: NativeOutputTerminal) => void,
) {
  let attempts = new WeakMap<Session, Running>()
  return {
    reset() { attempts = new WeakMap() },
    current: (session: Session) => attempts.get(session)?.attempt,
    prepare(session: Session) {
      const current = attempts.get(session)
      if (!current || current.attempt) return current?.attempt
      // The loop has started streaming. If this write throws, it can settle the
      // failed attempt. The caller flushes this ignorable record before sending.
      const markerSeq = appendPluginRecord(session, NATIVE_OUTPUT_MARKER, current.marker)
      current.attempt = { ...current.marker, session: String(session.id), floor: markerSeq + 1 }
      return current.attempt
    },
    observe(session: Session, event: SessionEvent) {
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
      const current = attempts.get(session)
      if (current?.attempt && event.data.turn === current.attempt.turn && event.data.step === current.attempt.step) {
        current.events.set(event.seq, event)
      }
    },
    frame(session: Session, frame: AssistantStreamFrame) {
      if (frame.type === 'start') {
        const sessionId = String(session.id)
        const generation = contextGeneration(sessionId)
        if (generation === undefined) { attempts.delete(session); return }
        const marker = { id: randomUUID(), generation, turn: frame.turn, step: frame.step }
        attempts.set(session, { attemptId: frame.attemptId, marker, events: new Map() })
        return
      }
      if (frame.type !== 'end') return
      const current = attempts.get(session)
      if (!current || current.attemptId !== frame.attemptId) return
      attempts.delete(session)
      if (!current.attempt) return
      if (frame.outcome.kind === 'abandoned') { finish(current.attempt); return }
      const event = current.events.get(frame.outcome.seq)
      if (!event || event.type !== frame.outcome.eventType) {
        throw new Error('Native model output did not match its settlement')
      }
      finish(current.attempt, { seq: event.seq, kind: event.type === 'assistant/message' ? 'reply' : 'attempt',
        digest: nativeEventDigest(event) })
    },
  }
}
