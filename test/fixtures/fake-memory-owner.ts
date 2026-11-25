import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { attachHostMemoryRelay } from '../../plugins/memory/lib/host-relay.ts'
import { openPluginOwner } from '../../plugins/memory/lib/standalone-owner.ts'
import { createRemoteMemoryOwner } from '../../plugins/memory/lib/remote-owner.ts'
import { objectOf } from '../../src/memory/contracts/unknown-value.ts'
import { memoryOwnerChange, memoryOwnerContextUsed, memoryOwnerState } from '../../src/memory/contracts/host.ts'

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
  const lifetime = new AbortController()
  const connection = openPluginOwner({ root, hostNamespace: 'viva' }, process)
  const owner = createRemoteMemoryOwner(connection)
  const relay = attachHostMemoryRelay({
    connection,
    port: process,
    signal: lifetime.signal,
    getEpoch: () => owner.epoch,
    enabled: true,
  })
  const unsubscribe = connection.subscribe(event => {
    const state = memoryOwnerState.safeParse(event)
    if (state.success) { relay.sendParent(state.data); return }
    const change = memoryOwnerChange.safeParse(event)
    if (change.success) { relay.sendParent(change.data); return }
    const used = memoryOwnerContextUsed.safeParse(event)
    if (used.success) { relay.sendParent(used.data); return }
  })
  await connection.start()
  process.channel?.unref()
  process.once('beforeExit', () => { lifetime.abort(); relay.close(); unsubscribe(); void owner.close() })
  let ordinal = Date.now()
  return {
    async receive(sessionId: string, text: string) {
      const turn = ++ordinal
      const receipt = await owner.receiveSource({ sessionId, messageId: randomUUID(), text, at: Date.now(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, turn, cwd: process.cwd() })
      return { turn, sourceIds: receipt.handledIntent ? [] : [receipt.sourceId] }
    },
    async complete(sessionId: string, turn: number, sourceIds: readonly string[], completed: boolean) {
      await owner.completeTurn({ sessionId, turn, sourceIds, assistant: '', completed, eventSeq: ++ordinal,
        at: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    },
  }
}
