import { memoryHostFailure } from '../../src/memory/contracts/domain-error.ts'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { openMemoryOwner } from '../../src/memory/node/owner.ts'
import { objectOf } from '../../src/memory/contracts/unknown-value.ts'
import { MEMORY_HOST_PROTOCOL } from '../../src/memory/contracts/host.ts'

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
  return {
    async receive(sessionId: string, text: string) {
      const turn = Date.now()
      const receipt = await owner.receiveSource({ sessionId, messageId: randomUUID(), text, at: turn,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, turn, step: 1, admitted: true, inherited: false })
      return { turn, sourceIds: receipt.handledIntent ? [] : [receipt.sourceId] }
    },
    async complete(sessionId: string, turn: number, sourceIds: readonly string[], completed: boolean) {
      await owner.completeTurn({ sessionId, turn, sourceIds, assistant: '', completed, eventSeq: turn,
        at: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    },
  }
}
