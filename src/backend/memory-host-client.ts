import { createVivaMemoryClient, type MemoryReadBatch } from './memory-client.ts'
import type { HostMemoryApi, HostMemoryCaller, HostMemoryMethod, MemoryOwnerState, MemoryHistoryOccurrence } from '../memory/contracts/host.ts'
const occurrence = (row: MemoryHistoryOccurrence): MemoryHistoryOccurrence => ({ segmentId: row.segmentId, role: row.role, text: row.text, ...(row.sourceId === undefined ? {} : { sourceId: row.sourceId }), ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }) })
/** Host identity mapping only. Every domain decision goes to the current owner. */
export function createMemoryHostClient(call: HostMemoryCaller, state: () => MemoryOwnerState | undefined, readBatch?: MemoryReadBatch) {
  const method = <M extends HostMemoryMethod>(name: M) => (...args: HostMemoryApi[M]['input'] extends { args: infer A extends unknown[] } ? A : never) =>
    call(name, { args } as unknown as HostMemoryApi[M]['input'])
  return {
    ...createVivaMemoryClient(call, readBatch), call,
    busy: () => state()?.state !== 'ready', epoch: () => state()?.coreEpoch ?? 0,
    bindProject: method('bindProject'), projectChanged: method('projectChanged'), allowsEvidence: method('allowsEvidence'),
    stale: method('stale'), allowsSession: method('allowsSession'), transferable: method('transferable'),
    transferStatus: method('transferStatus'), transfer: method('transfer'), canInherit: method('canInherit'), inherit: method('inherit'),
    allowsProjectHistory: (...[row, ...scope]: HostMemoryApi['allowsProjectHistory']['input']['args']) => call('allowsProjectHistory', { args: [occurrence(row), ...scope] }),
    useHistory: (session: string | undefined, row: MemoryHistoryOccurrence, crossProject?: boolean) =>
      call('useHistory', { args: crossProject === undefined ? [session, occurrence(row)] : [session, occurrence(row), crossProject] }), provenance: method('provenance'),
    recordSession: method('recordSession'), sessionProject: method('sessionProject'), recordSessionProject: method('recordSessionProject'),
    recordDeliveredSource: method('recordDeliveredSource'), isDerivedDelivery: method('isDerivedDelivery'), replaySources: method('replaySources'),
  }
}
export type MemoryHostClient = ReturnType<typeof createMemoryHostClient>
