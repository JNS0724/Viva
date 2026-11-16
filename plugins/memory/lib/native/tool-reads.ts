import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import { pluginRecordOf, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedToolSet, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { NativeToolCall, NativeToolResult } from '../../../../src/memory/node/native-tool-reads.ts'
import { nativeEventDigest } from './event-digest.ts'
import { NATIVE_OUTPUT_MARKER } from './output-attempts.ts'
import { objectOf } from '../../../../src/memory/contracts/unknown-value.ts'

type CallEvent = SessionEvent<'tool/call' | 'tool/ptc-dispatch-start'>
type PendingCall = { event: CallEvent, token?: ToolExecutionToken, active?: NativeToolCall, parent?: PendingCall }
type Assembly = { signal: AbortSignal, tools: ResolvedToolSet }
type Step = { turn: number, step: number, assembly: Assembly, calls: Map<string, PendingCall>, outputAttempt?: string }
export type NativeToolLease = { call: NativeToolCall, calls: readonly NativeToolCall[], current(): boolean }

/** The native tool call event is published before the executor can start the body. */
export function trackNativeToolReads(finish: (call: NativeToolCall, result: NativeToolResult) => void) {
  const assembling = new WeakMap<Session, Assembly>()
  const sessions = new WeakMap<Session, Step>()
  function pending(session: Session, exec: ToolExecution) {
    const current = sessions.get(session)
    if (!current || exec.toolSet !== current.assembly.tools) return
    const call = current.calls.get(String(exec.callId))
    if (!call || call.event.data.name !== exec.name) return
    if (call.event.type === 'tool/call') return !exec.parent && exec.callId === exec.rootCallId ? call : undefined
    return exec.parent && call.parent?.token === exec.parent && call.event.data.rootCallId === exec.rootCallId
      && isDeepStrictEqual(call.event.data.arguments, exec.arguments) ? call : undefined
  }
  return {
    assembly(session: Session, signal: AbortSignal, tools: ResolvedToolSet) {
      assembling.set(session, { signal, tools })
    },
    step(session: Session, turn: number, step: number, signal: AbortSignal) {
      const assembly = assembling.get(session)
      assembling.delete(session)
      sessions.delete(session)
      if (assembly?.signal === signal) sessions.set(session, { turn, step, assembly, calls: new Map() })
    },
    observe(session: Session, event: SessionEvent) {
      if (event.type === 'turn/end') { sessions.delete(session); return }
      const step = sessions.get(session)
      if (!step) return
      const marker = pluginRecordOf(event)
      const data = marker && objectOf(marker.data)
      if (marker?.type === NATIVE_OUTPUT_MARKER && data?.turn === step.turn && data.step === step.step && typeof data.id === 'string') step.outputAttempt = data.id
      if (event.type === 'tool/call') {
        if (event.data.turn !== step.turn || event.data.step !== step.step) return
        const id = String(event.data.callId)
        if (step.calls.has(id)) throw new Error('Native tool call ID repeats within an active step')
        step.calls.set(id, { event })
        return
      }
      if (event.type === 'tool/ptc-dispatch-start') {
        const id = String(event.data.subCallId), parent = step.calls.get(String(event.data.parentCallId))
        const root = step.calls.get(String(event.data.rootCallId))
        if (!parent?.token || !root?.token || parent.active?.generation !== root.active?.generation || step.calls.has(id)) return
        step.calls.set(id, { event, parent })
        return
      }
      if (event.type !== 'tool/ptc-dispatch' && (event.type !== 'tool/result' || event.surfaceOp !== 'append')) return
      const id = event.type === 'tool/result' ? String(event.data.message.toolCallId) : String(event.data.subCallId)
      const current = step.calls.get(id)
      if (!current) return
      if (!current.active) return
      if (event.type === 'tool/ptc-dispatch') {
        if (current.event.type !== 'tool/ptc-dispatch-start' || event.data.rootCallId !== current.event.data.rootCallId
          || event.data.parentCallId !== current.event.data.parentCallId || event.data.name !== current.event.data.name
          || !isDeepStrictEqual(event.data.arguments, current.event.data.arguments)) throw new Error('Native PTC result changed its execution identity')
      } else if (event.data.turn !== current.active.turn || event.data.step !== current.active.step
        || event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== current.active.seq) {
        throw new Error('Native tool result does not match the call that read memory')
      }
      finish(current.active, { seq: event.seq, digest: nativeEventDigest(event) })
      current.token = undefined
    },
    bind(session: Session, exec: ToolExecution) {
      const call = pending(session, exec)
      if (call && (call.parent || exec.signal === sessions.get(session)?.assembly.signal) && !call.token) call.token = exec.token
    },
    acquire(session: Session, exec: ToolExecution, generation: number): NativeToolLease | undefined {
      const current = pending(session, exec)
      if (!current || current.token !== exec.token || current.active) return
      const callId = String(exec.callId)
      const { turn, step, outputAttempt } = sessions.get(session)!
      const call = { id: randomUUID(), session: String(session.id), callId, generation, turn, step,
        seq: current.event.seq, digest: nativeEventDigest(current.event),
        ...(outputAttempt ? { outputAttempt } : {}),
        ...(current.event.type === 'tool/ptc-dispatch-start' ? { ptc: {
          rootCallId: String(current.event.data.rootCallId), parentCallId: String(current.event.data.parentCallId) } } : {}) }
      current.active = call
      const chain: PendingCall[] = []
      for (let node: PendingCall | undefined = current; node; node = node.parent) chain.push(node)
      const calls = chain.flatMap(node => node.active?.generation === generation ? [node.active] : [])
      if (calls.length !== chain.length) return
      return { call, calls, current: () => sessions.get(session)?.calls.get(callId) === current
        && chain.every(node => Boolean(node.token) && node.active?.generation === generation) }
    },
    spill(session: Session, callId: string, name: string): NativeToolCall | undefined {
      const call = sessions.get(session)?.calls.get(callId)
      return call?.token && call.event.data.name === name ? call.active : undefined
    },
  }
}
