import { memoryHostFailure } from '../../src/memory/contracts/domain-error.ts'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { openMemoryOwner } from '../../src/memory/node/owner.ts'
import { objectOf } from '../../src/memory/contracts/unknown-value.ts'
import { MEMORY_HOST_PROTOCOL } from '../../src/memory/contracts/host.ts'
import type { CommittedOutput } from '../../src/backend/assistant-stream.ts'

/** Core-window smoke uses a scripted ACP driver, but the real standalone memory owner/RPC. */
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
  const send = (value: object) => { if (process.connected) process.send?.(value) }
  let lastState = ''
  let effectsRevision = 0
  const state = (force = false) => {
    const value = { type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch,
      state: owner.status(), revision: owner.runtime.revision(), coreEpoch: owner.runtime.epoch(), effectsRevision }
    const encoded = JSON.stringify(value)
    if (force || encoded !== lastState) { lastState = encoded; send(value) }
  }
  const owner = openMemoryOwner({ root, hostNamespace: 'viva', compute: () => null, route: () => null, dailyNotes: false,
    onContextUsed: notice => send({ type: 'memory_owner_context_used', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, ...notice }),
    onProjectionChanged: () => send({ type: 'memory_owner_projection', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, revision: owner.runtime.revision() }),
    quiesce: async () => {}, onChange: change => { state(); send({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, ...change }) }, onHostEffects: () => { effectsRevision++; state() } })
  process.on('message', raw => {
    const message = objectOf(raw)
    if (message?.type !== 'memory_host_request' || typeof message.requestId !== 'string') return
    void (async () => {
      if (message.protocol !== MEMORY_HOST_PROTOCOL || message.epoch !== owner.epoch) throw new Error('Owner protocol mismatch')
      const result = await owner.handleHost(message.method, message.input)
      state()
      send({ type: 'memory_host_result', epoch: owner.epoch, requestId: message.requestId, ok: true, result })
    })().catch(error => send({ type: 'memory_host_result', epoch: owner.epoch, requestId: message.requestId, ok: false,
      error: memoryHostFailure(error) }))
  })
  await owner.recover()
  state()
  process.channel?.unref()
  let closed = false
  process.once('beforeExit', () => { if (!closed) { closed = true; void owner.close() } })
  const turns = new Map<string, { turn: number, step: number }>()
  let ordinal = Date.now()
  return {
    startOutput(sessionId: string) {
      const turn = turns.get(sessionId)
      if (!turn) throw new Error('A scripted output requires an admitted live turn')
      const generation = owner.contextGeneration(sessionId), seq = ++ordinal
      const output = { id: randomUUID(), session: sessionId, generation, turn: turn.turn, step: ++turn.step, floor: seq }
      const permit = owner.acquireSend(randomUUID(), { session: sessionId, contextGeneration: generation, output }, 'scripted ACP fixture send')
      try {
        if (!permit.recordBody) throw new Error('The scripted send did not receive an owner output capability')
        permit.recordBody()
      } catch (error) { permit.settled(); throw error }
      let finished = false
      return {
        signal: permit.signal,
        settle(blocks: CommittedOutput['blocks']): NonNullable<CommittedOutput['native']> {
          if (finished || permit.signal.aborted) throw new Error('The scripted output lease is no longer active')
          // This fixture has scripted stream events instead of a DSH provider log.
          // Bind the exact event body through the real owner before publishing its proof.
          const digest = createHash('sha256').update(JSON.stringify({ output, seq, blocks })).digest('hex')
          owner.finishNativeOutput(output, { seq, kind: 'reply', digest })
          finished = true
          permit.settled()
          return { seq, digest }
        },
        abandon() {
          if (finished) return
          try { owner.finishNativeOutput(output) } finally { finished = true; permit.settled() }
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
