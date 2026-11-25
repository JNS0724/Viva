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
  let ordinal = 0
  const seqBySession = new Map<string, number>()
  const pendingByTurn = new Map<string, { sourceId: string, text: string, at: number }>()
  return {
    async receive(sessionId: string, text: string) {
      const turn = ++ordinal
      const sourceId = randomUUID()
      const at = Date.now()
      pendingByTurn.set(`${sessionId}:${turn}`, { sourceId, text, at })
      await owner.stageOpenTurnSources({
        sessionId,
        turn,
        sessionKind: 'main',
        conversation: sessionId,
        cwd: process.cwd(),
        sources: [{ sourceId, author: 'user', sourceKind: 'main-human', profileEligible: true, text, conversation: sessionId, at, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }],
      })
      return { turn, sourceIds: [sourceId] }
    },
    async complete(sessionId: string, turn: number, _sourceIds: readonly string[], completed: boolean) {
      const key = `${sessionId}:${turn}`
      const saved = pendingByTurn.get(key)
      pendingByTurn.delete(key)
      const prev = seqBySession.get(sessionId) ?? null
      const fromSeq = prev ?? 0
      const toSeq = fromSeq + 3
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      await owner.settleTurn({
        sessionId,
        cwd: process.cwd(),
        sessionKind: 'main',
        conversation: sessionId,
        inheritedSeq: 0,
        expectedNextSeq: prev,
        fromSeq,
        toSeq,
        turn,
        reasonKind: completed ? 'completed' : 'aborted',
        sources: saved ? [{ sourceId: saved.sourceId, author: 'user', sourceKind: 'main-human', profileEligible: true, text: saved.text, conversation: sessionId, at: saved.at, timezone: tz }] : [],
        assistantText: '',
        at: Date.now(),
        timezone: tz,
      })
      seqBySession.set(sessionId, toSeq)
    },
  }
}
