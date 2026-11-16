import { isDeepStrictEqual } from 'node:util'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import { interruptedTurnClosers, ToolCallRecovery, TOOL_OUTCOME_UNKNOWN, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { NativeToolCall, NativeToolReadCut } from '../../../../src/memory/node/native-tool-reads.ts'
import { nativeEventDigest } from './event-digest.ts'

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

/** PTC IDs restart for each root program. Never borrow a later step's identical subcall. */
export function inspectPtcResultWindow(events: readonly SessionEvent[], call: NativeToolCall, limit = events.length) {
  const start = events[call.seq]
  if (!ptcStartMatches(start, call)) return
  let root = -1
  for (let seq = start.seq - 1; seq >= 0; seq--) {
    const event = events[seq]!
    if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'step/start') break
    if (event.type === 'tool/call' && event.data.callId === call.ptc!.rootCallId && event.data.turn === call.turn && event.data.step === call.step) {
      root = seq
      break
    }
  }
  if (root < 0 || call.seq >= limit) return
  const results: NativePtcResult[] = []
  for (let seq = root + 1; seq < limit; seq++) {
    const event = events[seq]!
    if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'step/start'
      || event.type === 'assistant/message' || event.type === 'session/end-seed'
      || event.type === 'tool/result' && event.data.message.toolCallId === call.ptc!.rootCallId) break
    if (ptcResultMatches(start, event)) results.push(event)
  }
  return { start, results }
}

/** An inherited start can flush before its parent's tail. Authenticate the
 * parent's still-open root and durable pre-start read cut, never a missing origin. */
export function provesUnflushedPtcTail(events: readonly SessionEvent[], call: NativeToolCall,
  roots: readonly { call: NativeToolCall, cut: NativeToolReadCut }[], transition: (proof: { seq: number, before: string, after: string }) => boolean,
  position = call.seq) {
  return roots.some(({ call: root, cut }) => {
    if (root.session !== call.session || root.generation !== call.generation || root.turn !== call.turn || root.step !== call.step
      || root.callId !== (call.ptc?.rootCallId ?? call.callId) || root.seq > cut.seq || cut.seq >= position) return false
    const begin = events[root.seq], boundary = events[cut.seq]
    const proves = (seq: number, before: string, event: SessionEvent | undefined) => event && (nativeEventDigest(event) === before
      || transition({ seq, before, after: nativeEventDigest(event) }))
    if (begin?.type !== 'tool/call' || begin.data.callId !== root.callId || !proves(root.seq, root.digest, begin)
      || !proves(cut.seq, cut.digest, boundary)) return false
    const closed = events.slice(root.seq + 1).some(event => event.type === 'step/end' || event.type === 'turn/end'
      || event.type === 'step/start' || event.type === 'assistant/message' || event.type === 'session/end-seed'
      || event.type === 'tool/result' && event.data.message.toolCallId === root.callId)
    const start = events[call.seq]
    const sameStart = !start || proves(call.seq, call.digest, start)
    if (!closed) return sameStart && position >= events.length
    // A normal cold resume may have filled the unflushed coordinates with the
    // SDK's exact interruption repair. Authenticate its complete closing batch;
    // later turns have separate readsets and do not invalidate this old proof.
    for (let pivot = cut.seq + 1; pivot <= Math.min(position, events.length); pivot++) {
      if (!sameStart && call.seq < pivot) continue
      const closers = interruptedTurnClosers(events.slice(0, pivot))
      if (!closers.some(event => event.type === 'tool/result' && event.data.message.toolCallId === root.callId
        && event.data.error?.code === TOOL_OUTCOME_UNKNOWN)) continue
      const tail = events.slice(pivot)
      if (tail.length < closers.length) continue
      if (closers.every((expected, index) => {
        const actual = tail[index]
        return actual && (nativeEventDigest(actual) === nativeEventDigest(expected)
          || transition({ seq: expected.seq, before: nativeEventDigest(expected), after: nativeEventDigest(actual) }))
      })) return true
    }
    return false
  })
}

/** Machine repair is independent of the lost program result; preserve it. The
 * live append seam supplies a fresh time, while all other fields stay exact. */
export function isNativeToolRepair(events: readonly SessionEvent[], result: SessionEvent<'tool/result'>) {
  for (const kind of ['interrupted', 'forked'] as const) {
    const recovery = new ToolCallRecovery({ kind })
    for (const event of events.slice(0, result.seq)) recovery.observe(event)
    if (recovery.results().some(expected => isDeepStrictEqual({ ...expected, time: result.time }, result))) return true
  }
  return false
}

/** Retain pairing/outcome; arguments are withdrawn only with the root request's proven readset. */
export function projectNativePtc(event: NativePtcEvent, argumentsToo = false): NativePtcEvent | undefined {
  if (event.type === 'tool/ptc-dispatch-start') return argumentsToo ? { ...event, data: { ...event.data, arguments: {} } } : event
  if (event.data.content.some(block => block.type !== 'text')) return
  const { meta: _private, error, ...data } = event.data
  return { ...event, data: { ...data, ...(argumentsToo ? { arguments: {} } : {}), content: [],
    ...(error ? { error: { name: error.name, code: error.code } } : {}) } }
}
