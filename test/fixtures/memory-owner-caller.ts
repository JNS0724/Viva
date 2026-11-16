import type { HostMemoryApi, HostMemoryCaller } from '../../src/memory/contracts/host.ts'
import type { openMemoryOwner } from '../../src/memory/node/owner.ts'
/** Transport-free trusted peer for coordinator tests; the actual owner validates every command. */
export function memoryOwnerCaller(owner: ReturnType<typeof openMemoryOwner>, before?: (method: keyof HostMemoryApi) => void): HostMemoryCaller {
  return async (method, input) => {
    before?.(method)
    return await owner.handleHost(method, input) as HostMemoryApi[typeof method]['output']
  }
}
