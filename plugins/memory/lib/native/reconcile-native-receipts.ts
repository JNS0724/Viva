import { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import type { NativeOutputTerminal } from '../../../../src/memory/node/native-output-attempts.ts'
import type { NativeToolResult } from '../../../../src/memory/node/native-tool-reads.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { nativeEventDigest } from './event-digest.ts'
import { inspectNativeOutputWindow } from './project-native-outputs.ts'
import { inspectPtcResultWindow, isNativeToolRepair, provesUnflushedPtcTail, ptcStartMatches } from './project-native-ptc.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>

/** Native bytes can commit before the callback saves its endpoint receipt.
 * A child may flush inherited output before its parent flushes that endpoint. */
export async function reconcileNativeReceipts(root: string, owner: Maintenance, settleAbsent = false) {
  const { attempts, tools } = owner.unsettledReceipts()
  if (!attempts.length && !tools.length) return
  const outputs = new Map(attempts.map(item => [item.id, {
    origin: false, ambiguous: false, terminals: new Map<string, NativeOutputTerminal>(),
  }]))
  const results = new Map(tools.map(item => [item.id, new Map<string, NativeToolResult>()]))
  const origins = new Set<string>(), ambiguous = new Set<string>()
  const unflushed = new Set<string>(), inheritedStarts = new Set<string>()
  const repairResults = new Map(tools.map(call => [call.id, new Set<string>()]))
  const originRepairs = new Map<string, NativeToolResult>()
  const catalog = new Context(), mounted = await catalog.plugin(jsonl, { root })
  try {
    await visitNativeSessionCatalog(root, catalog.sessionPersistence, ({ sessionId, inheritedEventCount, events }) => {
      for (const attempt of attempts) {
        const window = inspectNativeOutputWindow(events, sessionId, inheritedEventCount, attempt)
        if (!window.marker) continue
        const proof = outputs.get(attempt.id)!
        proof.origin ||= attempt.session === sessionId
        proof.ambiguous ||= window.ambiguous
        if (window.ambiguous || !window.event) continue
        const event = window.event
        const terminal = { seq: event.seq, kind: event.type === 'assistant/message' ? 'reply' as const : 'attempt' as const,
          digest: nativeEventDigest(event) }
        proof.terminals.set(JSON.stringify(terminal), terminal)
      }
      for (const call of tools) {
        const origin = call.session === sessionId
        if (!origin && call.seq >= inheritedEventCount) continue
        const event = events[call.seq]
        const missingTail = origin && provesUnflushedPtcTail(events, call, owner.toolInputRootCuts(call), owner.nativeTransition)
        if (missingTail) unflushed.add(call.id)
        const proven = event && (nativeEventDigest(event) === call.digest
          || owner.nativeTransition({ seq: call.seq, before: call.digest, after: nativeEventDigest(event) }))
        if (origin && event && !proven && !missingTail) ambiguous.add(call.id)
        if (!(call.ptc ? ptcStartMatches(event, call) : event?.type === 'tool/call') || !event || !proven) continue
        if (origin) origins.add(call.id)
        if (call.ptc) {
          const window = inspectPtcResultWindow(events, call, origin ? events.length : inheritedEventCount)
          if (!window) { ambiguous.add(call.id); continue }
          if (!origin) inheritedStarts.add(call.id)
          for (const result of window.results) {
            const terminal = { seq: result.seq, digest: nativeEventDigest(result) }
            results.get(call.id)!.set(JSON.stringify(terminal), terminal)
          }
          continue
        }
        for (const result of events) {
          if (!origin && result.seq >= inheritedEventCount) break
          if (result.type !== 'tool/result' || result.surfaceOp !== 'append' || result.data.turn !== call.turn
            || result.data.step !== call.step || result.data.message.toolCallId !== call.callId
            || result.sourceEventSeqs?.length !== 1 || result.sourceEventSeqs[0] !== call.seq) continue
          const terminal = { seq: result.seq, digest: nativeEventDigest(result) }
          const key = JSON.stringify(terminal)
          results.get(call.id)!.set(key, terminal)
          if (isNativeToolRepair(events, result)) {
            repairResults.get(call.id)!.add(key)
            if (origin) originRepairs.set(call.id, terminal)
          }
        }
      }
    })
  } finally { await mounted.dispose() }
  // Only the complete physical catalog can establish that no copy has output.
  for (const { result: _result, ...attempt } of attempts) {
    const proof = outputs.get(attempt.id)!
    if (proof.ambiguous || proof.terminals.size > 1 || !proof.terminals.size && !proof.origin) continue
    owner.finishRecoveredOutput(attempt, proof.terminals.values().next().value)
  }
  for (const { result: _result, absent: _absent, ...call } of tools) {
    const matches = results.get(call.id)!
    if (ambiguous.has(call.id)) continue
    const outputs = [...matches].filter(([key]) => !repairResults.get(call.id)!.has(key)).map(([, terminal]) => terminal)
    if (outputs.length === 1) owner.finishRecoveredTool(call, outputs[0]!)
    else if (!outputs.length && matches.size) {
      const repair = originRepairs.get(call.id) ?? (matches.size === 1 ? matches.values().next().value : undefined)
      if (repair) owner.finishRecoveredTool(call, repair)
    }
    else if (!matches.size && settleAbsent && (origins.has(call.id) || unflushed.has(call.id) && inheritedStarts.has(call.id))
      && !owner.toolSpillsPending(call)) owner.finishAbsentTool(call)
  }
}
