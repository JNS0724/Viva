import { isDeepStrictEqual } from 'node:util'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { NativeOutputAttempt } from '../../../../src/memory/node/native-output-attempts.ts'
import { NATIVE_OUTPUT_MARKER } from './output-attempts.ts'
import { withdrawnToolCall } from './native-output-tool-group.ts'

type OutputEvent = SessionEvent<'assistant/message' | 'assistant/attempt'>

/** A copied marker and its settlement must both be in the child's inherited prefix. */
export function inspectNativeOutputWindow(events: readonly SessionEvent[], sessionId: string, inheritedEventCount: number, attempt: NativeOutputAttempt) {
  const limit = sessionId === attempt.session ? events.length : inheritedEventCount
  const prefix = attempt.floor > 0 && attempt.floor <= limit ? events[attempt.floor - 1] : undefined
  const marker = prefix && pluginRecordOf(prefix)
  const { id, generation, turn, step } = attempt
  if (marker?.type !== NATIVE_OUTPUT_MARKER || marker.seq !== attempt.floor - 1 || !isDeepStrictEqual(marker.data, { id, generation, turn, step })) {
    return { marker: false as const }
  }

  let found: OutputEvent | undefined
  for (let seq = attempt.floor; seq < limit; seq++) {
    const event = events[seq]!
    if (event.type === 'session/end-seed' || event.type === 'step/end' || event.type === 'turn/end'
      || pluginRecordOf(event)?.type === NATIVE_OUTPUT_MARKER) break
    if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message') continue
    if (found || event.data.turn !== turn || event.data.step !== step) return { marker: true as const, ambiguous: true as const }
    found = event
  }
  return { marker: true as const, ambiguous: false as const, event: found }
}

/** Preserve the native envelope and accounting while removing the output payload. */
export function projectNativeOutput(event: OutputEvent): OutputEvent | undefined {
  if (event.type === 'assistant/attempt') return { ...event, data: { ...event.data, stream: [] } }
  const { message, usage } = event.data
  const content = message.content.flatMap(block => block.type === 'tool-call' ? [withdrawnToolCall(block)] : [])
  const { replayState: _retired, ...source } = message.source
  const stream = content.map(({ id, name, arguments: argumentsDelta }, index) => ({ type: 'chunk' as const, time: event.time,
    chunk: { type: 'tool-call-delta' as const, index, id, name, argumentsDelta } }))
  return { ...event, data: {
    ...event.data,
    message: { ...message, source, content },
    stream: usage === undefined ? stream : [...stream, { type: 'chunk', time: event.time, chunk: { type: 'usage', usage } }],
  } }
}
