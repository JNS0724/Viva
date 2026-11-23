import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { openPluginOwner } from '../../plugins/memory/lib/standalone-owner.ts'
import { createRemoteMemoryOwner } from '../../plugins/memory/lib/remote-owner.ts'
import { objectOf } from '../../src/memory/contracts/unknown-value.ts'
import { memoryOwnerState } from '../../src/memory/contracts/host.ts'
import type { CommittedOutput } from '../../src/backend/assistant-stream.ts'

/** Core-window smoke uses a scripted ACP driver, but the real Viva memory owner/RPC. */
export async function startFakeMemoryOwner() {
  const at = process.argv.indexOf('--patch')
  if (!process.send || at < 0 || !process.argv[at + 1]) return null
  function dataRoot(value: unknown): string | undefined {
    if (Array.isArray(value)) return value.map(dataRoot).find(root => root !== undefined)
    const item = objectOf(value)
    if (!item) return undefined
    const config = objectOf(item.config)
    if (item.id === 'viva-memory' && typeof config?.dataRoot === 'string') return config.dataRoot
    return Object.values(item).map(dataRoot).find(root => root !== undefined)
  }
  const root = dataRoot(parse(readFileSync(process.argv[at + 1]!, 'utf8')))
  if (!root) return null
  const turns = new Map<string, { turn: number, step: number }>()
  const connection = openPluginOwner({ root, hostNamespace: 'viva', callbacks: {
    drainSends: (input): Promise<void> => owner.drainSends(input.epoch),
  } }, process)
  const owner = createRemoteMemoryOwner(connection, () => {})
  let reconciledEpoch: string | undefined
  const unsubscribe = connection.subscribe(event => {
    const parsed = memoryOwnerState.safeParse(event)
    if (!parsed.success) return
    const state = parsed.data
    const send = () => connection.reconciled?.(state.epoch, state.state === 'ready' && reconciledEpoch === state.epoch)
    if (state.state !== 'ready' || reconciledEpoch === state.epoch) { send(); return }
    void owner.inEpoch(state.epoch, async () => {
      await owner.call('reconcileActiveTurns', [[...turns].map(([sessionId, turn]) => ({ sessionId, turn: turn.turn }))])
      if (!owner.ready() || owner.epoch !== state.epoch) return
      reconciledEpoch = state.epoch
      send()
    }).catch(() => {})
  })
  await connection.start()
  process.channel?.unref()
  process.once('beforeExit', () => { unsubscribe(); void owner.close() })
  let ordinal = Date.now()
  return {
    async startOutput(sessionId: string) {
      const turn = turns.get(sessionId)
      if (!turn) throw new Error('A scripted output requires an admitted live turn')
      const epoch = owner.epoch
      const generation = await owner.contextGeneration(sessionId), seq = ++ordinal
      const output = { id: randomUUID(), session: sessionId, generation, turn: turn.turn, step: ++turn.step, floor: seq }
      const bodyDigest = createHash('sha256').update('scripted ACP fixture send').digest('hex')
      const permit = await owner.inEpoch(epoch, () => owner.acquireSend(randomUUID(), { session: sessionId, contextGeneration: generation, output }, bodyDigest))
      try { await permit.recordBody() } catch (error) { permit.settled(); throw error }
      let finished = false
      return {
        signal: permit.signal,
        async settle(blocks: CommittedOutput['blocks']): Promise<{ seq: number, digest: string }> {
          if (finished || permit.signal.aborted) throw new Error('The scripted output lease is no longer active')
          // This fixture has scripted stream events instead of a DSH provider log.
          // Bind the exact event body through the real owner before publishing its proof.
          const digest = createHash('sha256').update(JSON.stringify({ output, seq, blocks })).digest('hex')
          await owner.inEpoch(epoch, () => owner.call('finishNativeOutput', [output, { seq, kind: 'reply', digest }]))
          finished = true
          permit.settled()
          return { seq, digest }
        },
        async abandon() {
          if (finished) return
          try { await owner.inEpoch(epoch, () => owner.call('finishNativeOutput', [output])) }
          finally { finished = true; permit.settled() }
        },
      }
    },
    async receive(sessionId: string, text: string) {
      const turn = ++ordinal
      const receipt = await owner.receiveSource({ sessionId, messageId: randomUUID(), text, at: Date.now(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, turn, step: 1, admitted: true, inherited: false })
      turns.set(sessionId, { turn, step: 0 })
      return { turn, sourceIds: receipt.handledIntent ? [] : [receipt.sourceId] }
    },
    async complete(sessionId: string, turn: number, sourceIds: readonly string[], completed: boolean) {
      try {
        await owner.completeTurn({ sessionId, turn, sourceIds, assistant: '', completed, eventSeq: ++ordinal,
          at: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      } finally { turns.delete(sessionId) }
    },
  }
}
