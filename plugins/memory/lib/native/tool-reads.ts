import { createHash, randomUUID } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedToolSet, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { NativeToolCall, NativeToolResult } from '../../../../src/memory/node/native-tool-reads.ts'

type PendingCall = { event: SessionEvent<'tool/call'>, token?: ToolExecutionToken, active?: NativeToolCall }
type Assembly = { signal: AbortSignal, tools: ResolvedToolSet }
type Step = { turn: number, step: number, assembly: Assembly, calls: Map<string, PendingCall> }
export type NativeToolLease = { call: NativeToolCall, current(): boolean }

const digestEvent = (event: SessionEvent) => createHash('sha256').update(JSON.stringify(event)).digest('hex')

/** The native tool call event is published before the executor can start the body. */
export function trackNativeToolReads(finish: (call: NativeToolCall, result: NativeToolResult) => void) {
  const assembling = new WeakMap<Session, Assembly>()
  const sessions = new WeakMap<Session, Step>()
  function pending(session: Session, exec: ToolExecution) {
    const current = sessions.get(session)
    if (!current || exec.parent || exec.callId !== exec.rootCallId || exec.toolSet !== current.assembly.tools) return
    const call = current.calls.get(String(exec.callId))
    return call?.event.data.name === exec.name ? call : undefined
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
      if (event.type === 'tool/call') {
        if (event.data.turn !== step.turn || event.data.step !== step.step) return
        const id = String(event.data.callId)
        if (step.calls.has(id)) throw new Error('Native tool call ID repeats within an active step')
        step.calls.set(id, { event })
        return
      }
      if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return
      const id = String(event.data.message.toolCallId)
      const current = step.calls.get(id)
      if (!current) return
      step.calls.delete(id)
      if (!current.active) return
      if (event.data.turn !== current.active.turn || event.data.step !== current.active.step
        || event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== current.active.seq) {
        throw new Error('Native tool result does not match the call that read memory')
      }
      finish(current.active, { seq: event.seq, digest: digestEvent(event) })
    },
    bind(session: Session, exec: ToolExecution) {
      const call = pending(session, exec)
      if (call && exec.signal === sessions.get(session)?.assembly.signal && !call.token) call.token = exec.token
    },
    acquire(session: Session, exec: ToolExecution, generation: number): NativeToolLease | undefined {
      const current = pending(session, exec)
      if (!current || current.token !== exec.token || current.active) return
      const callId = String(exec.callId)
      const { turn, step } = current.event.data
      const call = { id: randomUUID(), session: String(session.id), callId, generation, turn, step,
        seq: current.event.seq, digest: digestEvent(current.event) }
      current.active = call
      return { call, current: () => sessions.get(session)?.calls.get(callId)?.active === call }
    },
  }
}
