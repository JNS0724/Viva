import { MEMORY_HOST_PROTOCOL } from '../../src/memory/contracts/host.ts'
import { createVivaMemoryClient } from '../../src/backend/memory-client.ts'
import { createRemoteMemoryChannel } from '../../src/backend/remote-memory-channel.ts'
import type { openMemoryOwner } from '../../src/memory/node/owner.ts'
/** Exercise exactly the JSON process boundary without starting a model. */
export function ownerClient(owner: ReturnType<typeof openMemoryOwner>) {
  const channel = createRemoteMemoryChannel({ send(raw) {
    const message = JSON.parse(JSON.stringify(raw)) as { requestId: string, epoch: string, method: string, input: unknown }
    void owner.handleHost(message.method, message.input).then(result => channel.receive({ type: 'memory_host_result', requestId: message.requestId, epoch: owner.epoch, ok: true, result }),
      error => channel.receive({ type: 'memory_host_result', requestId: message.requestId, epoch: owner.epoch, ok: false, error: { code: 'invalid-input', reason: error instanceof Error ? error.message : String(error) } }))
  } })
  channel.receive({ type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, state: 'ready', revision: owner.runtime.revision(), coreEpoch: owner.runtime.epoch() })
  return createVivaMemoryClient(channel.call)
}
