import { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import type { NativeOutputTerminal } from '../../../../src/memory/node/native-output-attempts.ts'
import type { NativeToolResult } from '../../../../src/memory/node/native-tool-reads.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { nativeEventDigest } from './event-digest.ts'
import { inspectNativeOutputWindow } from './project-native-outputs.ts'
import { ptcResultMatches, ptcStartMatches } from './project-native-ptc.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>

/** Native bytes can commit before the callback saves its endpoint receipt.
 * A child may flush inherited output before its parent flushes that endpoint. */
export async function reconcileNativeReceipts(root: string, owner: Maintenance) {
  const { attempts, tools } = owner.unsettledReceipts()
  if (!attempts.length && !tools.length) return
  const outputs = new Map(attempts.map(item => [item.id, {
    origin: false, ambiguous: false, terminals: new Map<string, NativeOutputTerminal>(),
  }]))
  const results = new Map(tools.map(item => [item.id, new Map<string, NativeToolResult>()]))
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
        if (!(call.ptc ? ptcStartMatches(event, call) : event?.type === 'tool/call') || !event || nativeEventDigest(event) !== call.digest) continue
        for (const result of events) {
          if (!origin && result.seq >= inheritedEventCount) break
          if (call.ptc && event.type === 'tool/ptc-dispatch-start') {
            if (!ptcResultMatches(event, result)) continue
            const terminal = { seq: result.seq, digest: nativeEventDigest(result) }
            results.get(call.id)!.set(JSON.stringify(terminal), terminal)
            continue
          }
          if (result.type !== 'tool/result' || result.surfaceOp !== 'append' || result.data.turn !== call.turn
            || result.data.step !== call.step || result.data.message.toolCallId !== call.callId
            || result.sourceEventSeqs?.length !== 1 || result.sourceEventSeqs[0] !== call.seq) continue
          const terminal = { seq: result.seq, digest: nativeEventDigest(result) }
          results.get(call.id)!.set(JSON.stringify(terminal), terminal)
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
  for (const { result: _result, ...call } of tools) {
    const matches = results.get(call.id)!
    if (matches.size === 1) owner.finishRecoveredTool(call, matches.values().next().value!)
  }
}
