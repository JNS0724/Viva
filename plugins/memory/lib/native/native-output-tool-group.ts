import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import { ToolCallRecovery, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { nativeToolResultCopies, projectNativeToolResult, type NativeToolResultEvent } from './project-native-tools.ts'
import { projectNativePtc, ptcResultMatches, type NativePtcEvent, type NativePtcStart } from './project-native-ptc.ts'

type ToolCallEvent = SessionEvent<'tool/call'>
type ToolCompanion = ToolCallEvent | NativeToolResultEvent | NativePtcEvent

export const withdrawnToolCall = <T extends ToolCallBlock>(call: T): T => ({ ...call, arguments: '{}' })

export function projectToolCompanion(event: ToolCompanion): ToolCompanion | undefined {
  if (event.type === 'tool/call') return { ...event, data: { ...event.data, arguments: '{}' } }
  if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') return projectNativePtc(event, true)
  return projectNativeToolResult(event)
}

function hasTrustedRepair(announcement: SessionEvent<'assistant/message'>, call: ToolCallEvent | undefined, result: NativeToolResultEvent) {
  const { error, message, meta } = result.data
  const expected = call ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED
  if (error?.code !== expected || meta !== undefined) return false
  const cause = message.id.startsWith('forked-tool-result-') ? 'forked' : 'interrupted'
  const recovery = new ToolCallRecovery({ kind: cause })
  recovery.observe(announcement)
  if (call) recovery.observe(call)
  const fixed = recovery.results().find(candidate => candidate.type === 'tool/result' && candidate.data.message.toolCallId === message.toolCallId)
  return fixed?.type === 'tool/result' && JSON.stringify(fixed.data.error) === JSON.stringify(error)
    && JSON.stringify(fixed.data.message.content) === JSON.stringify(message.content)
}

/** Follow only the native tools advertised by this exact assistant event. */
export function inspectNativeToolCompanions(events: readonly SessionEvent[], announcement: SessionEvent<'assistant/message'>) {
  const { turn, step } = announcement.data
  const advertised = new Map(announcement.data.message.content.flatMap(block => block.type === 'tool-call' ? [[block.id, block] as const] : []))
  const companions = new Map<number, ToolCompanion>()
  const calls = new Map<string, ToolCallEvent>(), results = new Map<string, NativeToolResultEvent>()
  const starts = new Map<string, NativePtcStart>(), settled = new Set<string>()
  for (let seq = announcement.seq + 1; seq < events.length; seq++) {
    const event = events[seq]!
    if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'assistant/message') break
    if (event.type === 'tool/call') {
      const id = event.data.callId, block = advertised.get(id)
      if (!block) continue
      if (calls.has(id) || event.data.turn !== turn || event.data.step !== step || event.data.name !== block.name
        || event.data.arguments !== block.arguments) return
      calls.set(id, event)
      companions.set(event.seq, event)
    } else if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const id = event.data.message.toolCallId
      if (!advertised.has(id)) continue
      const call = calls.get(id)
      if (results.has(id) || event.data.turn !== turn || event.data.step !== step) return
      results.set(id, event)
      if (hasTrustedRepair(announcement, call, event)) continue
      if (!call || event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== call.seq) return
      const copies = nativeToolResultCopies(events, event)
      if (!copies) return
      for (const [seq, result] of copies) companions.set(seq, result)
    } else if (event.type === 'tool/ptc-dispatch-start' && advertised.has(event.data.rootCallId)) {
      const { subCallId, parentCallId, rootCallId } = event.data
      const parent = starts.get(parentCallId)
      if (!calls.has(rootCallId) || results.has(rootCallId) || starts.has(subCallId)
        || parentCallId !== rootCallId && (!parent || parent.data.rootCallId !== rootCallId || settled.has(parentCallId))) return
      starts.set(subCallId, event)
      companions.set(event.seq, event)
    } else if (event.type === 'tool/ptc-dispatch' && advertised.has(event.data.rootCallId)) {
      const start = starts.get(event.data.subCallId)
      if (!start || settled.has(event.data.subCallId) || results.has(event.data.rootCallId) || !ptcResultMatches(start, event)) return
      settled.add(event.data.subCallId)
      companions.set(event.seq, event)
    }
  }
  return companions
}
