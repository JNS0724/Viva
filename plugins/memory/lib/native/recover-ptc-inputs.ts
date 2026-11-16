import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { openNativeOriginalMaintenance } from '../../../../src/memory/node/native-original-maintenance.ts'
import { visitNativeSessionCatalog } from './discover-native-replicas.ts'
import { nativeEventDigest } from './event-digest.ts'

type Maintenance = NonNullable<ReturnType<typeof openNativeOriginalMaintenance>>

/** The body-read transaction archived the root's exact event cut before bytes
 * reached its program. A later start is recoverable even when prepare never ran. */
export async function recoverNativePtcInputs(root: string, owner: Maintenance) {
  const cuts = owner.ptcInputCuts()
  if (!cuts.length) return
  const context = new Context(), mounted = await context.plugin(jsonl, { root })
  try {
    await visitNativeSessionCatalog(root, context.sessionPersistence, ({ sessionId, inheritedEventCount, events }) => {
      for (const { call, cut, evidence } of cuts) {
        const origin = sessionId === call.session, limit = origin ? events.length : inheritedEventCount
        if (call.seq >= limit || cut.seq >= limit) continue
        const event = events[call.seq], boundary = events[cut.seq]
        if (event?.type !== 'tool/call' || event.data.callId !== call.callId || event.data.turn !== call.turn || event.data.step !== call.step) continue
        const proves = (seq: number, before: string, actual: typeof event | typeof boundary) => actual && (nativeEventDigest(actual) === before
          || owner.nativeTransition({ seq, before, after: nativeEventDigest(actual) }))
        if (!proves(call.seq, call.digest, event) || !proves(cut.seq, cut.digest, boundary)) {
          if (origin) throw new Error('Native PTC read cut changed before input recovery')
          continue
        }
        for (let seq = call.seq + 1; seq < limit; seq++) {
          const candidate = events[seq]!
          if (candidate.type === 'step/end' || candidate.type === 'turn/end' || candidate.type === 'step/start'
            || candidate.type === 'assistant/message' || candidate.type === 'session/end-seed'
            || candidate.type === 'tool/result' && candidate.data.message.toolCallId === call.callId) break
          if (seq <= cut.seq || candidate.type !== 'tool/ptc-dispatch-start' || candidate.data.rootCallId !== call.callId) continue
          owner.recoverPtcInput({ id: randomUUID(), session: call.session, generation: call.generation, turn: call.turn, step: call.step,
            seq: candidate.seq, digest: nativeEventDigest(candidate), callId: String(candidate.data.subCallId), inputDerived: true,
            ...(call.outputAttempt ? { outputAttempt: call.outputAttempt } : {}),
            ptc: { rootCallId: String(candidate.data.rootCallId), parentCallId: String(candidate.data.parentCallId) } }, evidence)
        }
      }
    })
  } finally { await mounted.dispose() }
}
