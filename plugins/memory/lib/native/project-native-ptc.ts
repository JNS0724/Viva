import { isDeepStrictEqual } from 'node:util'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { NativeToolCall } from '../../../../src/memory/node/native-tool-reads.ts'

export type NativePtcStart = SessionEvent<'tool/ptc-dispatch-start'>
export type NativePtcResult = SessionEvent<'tool/ptc-dispatch'>
export type NativePtcEvent = NativePtcStart | NativePtcResult

export function ptcStartMatches(event: SessionEvent | undefined, call: NativeToolCall): event is NativePtcStart {
  return event?.type === 'tool/ptc-dispatch-start' && event.data.subCallId === call.callId
    && event.data.rootCallId === call.ptc?.rootCallId && event.data.parentCallId === call.ptc.parentCallId
}

export function ptcResultMatches(start: NativePtcStart, event: SessionEvent | undefined): event is NativePtcResult {
  return event?.type === 'tool/ptc-dispatch' && event.seq > start.seq && event.data.subCallId === start.data.subCallId
    && event.data.rootCallId === start.data.rootCallId && event.data.parentCallId === start.data.parentCallId
    && event.data.name === start.data.name && isDeepStrictEqual(event.data.arguments, start.data.arguments)
}

/** Retain pairing/outcome; arguments are withdrawn only with the root request's proven readset. */
export function projectNativePtc(event: NativePtcEvent, argumentsToo = false): NativePtcEvent | undefined {
  if (event.type === 'tool/ptc-dispatch-start') return argumentsToo ? { ...event, data: { ...event.data, arguments: {} } } : event
  if (event.data.content.some(block => block.type !== 'text')) return
  const { meta: _private, error, ...data } = event.data
  return { ...event, data: { ...data, ...(argumentsToo ? { arguments: {} } : {}), content: [],
    ...(error ? { error: { name: error.name, code: error.code } } : {}) } }
}
