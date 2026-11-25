import { memoryHostFailure } from '../../../src/memory/contracts/domain-error.ts'
import {
  MEMORY_HOST_PROTOCOL,
  memoryHostRead,
  parseHostMemoryCommand,
  type HostMemoryMethod,
} from '../../../src/memory/contracts/host.ts'
import { objectOf } from '../../../src/memory/contracts/unknown-value.ts'
import type { OwnerCallOptions } from '../../../src/memory/node/owner-adapter.ts'
import { parseDiagnosticContext } from '../../../src/diagnostics/contracts.ts'
import { withRemoteOperation } from '../../../src/diagnostics/node/context.ts'
import type { MemoryOwnerConnection } from './remote-owner.ts'

export type HostRelayPort = Pick<NodeJS.Process, 'on' | 'off' | 'connected' | 'send'>

export function attachHostMemoryRelay({
  connection,
  port,
  signal,
  getEpoch,
  enabled = true,
  onHostSuccess,
}: {
  connection: MemoryOwnerConnection
  port: HostRelayPort
  signal: AbortSignal
  getEpoch: () => string | undefined
  enabled?: boolean
  onHostSuccess?: (method: HostMemoryMethod, input: unknown) => void
}) {
  const hostRequests = new Map<string, { epoch: string, controller: AbortController }>()

  function sendParent(message: object) {
    if (!enabled || signal.aborted || !port.connected || typeof port.send !== 'function') return
    try { port.send(message, () => {}) } catch { /* parent disconnected */ }
  }

  const receiveHost = (raw: unknown) => {
    if (!enabled || signal.aborted || typeof port.send !== 'function') return
    const msg = objectOf(raw)
    if (!msg || msg.protocol !== MEMORY_HOST_PROTOCOL) return
    if (msg.type === 'memory_host_cancel') {
      if (typeof msg.requestId !== 'string' || typeof msg.epoch !== 'string') return
      const active = hostRequests.get(msg.requestId)
      if (active && active.epoch === msg.epoch) {
        active.controller.abort(new Error('Memory host request cancelled'))
      }
      return
    }
    if (msg.type !== 'memory_host_request') return
    if (typeof msg.requestId !== 'string' || typeof msg.epoch !== 'string') return
    const { requestId, epoch } = msg
    if (epoch !== getEpoch()) {
      sendParent({
        type: 'memory_host_result',
        protocol: MEMORY_HOST_PROTOCOL,
        requestId,
        epoch,
        ok: false,
        error: memoryHostFailure(new Error('Memory owner generation changed')),
      })
      return
    }
    let command: ReturnType<typeof parseHostMemoryCommand>
    try {
      command = parseHostMemoryCommand(msg.method, msg.input)
    } catch (error) {
      sendParent({
        type: 'memory_host_result',
        protocol: MEMORY_HOST_PROTOCOL,
        requestId,
        epoch,
        ok: false,
        error: memoryHostFailure(error),
      })
      return
    }
    const controller = new AbortController()
    hostRequests.set(requestId, { epoch, controller })
    const combinedSignal = AbortSignal.any([signal, controller.signal])
    const read = msg.read !== undefined ? memoryHostRead.safeParse(msg.read) : null
    const deadlineAt = typeof msg.deadlineAt === 'number' && Number.isFinite(msg.deadlineAt) ? msg.deadlineAt : undefined
    const callOptions: OwnerCallOptions = read?.success
      ? { signal: combinedSignal, budgetMs: read.data.budgetMs, waitForCompletion: true }
      : deadlineAt !== undefined
        ? { signal: combinedSignal, budgetMs: Math.max(1, deadlineAt - Date.now()), deadlineAt }
        : { signal: combinedSignal, budgetMs: 30_000 }
    const diagnostic = parseDiagnosticContext(msg.diagnostics)
    void withRemoteOperation(diagnostic, 'memory.owner', () => connection.callHost(command.method, command.input, callOptions), {
      identities: { requestId, ownerEpoch: epoch, methodId: command.method, ...(read?.success ? { readBatchId: read.data.readBatchId } : {}) },
    }).then(
      result => {
        sendParent({ type: 'memory_host_result', protocol: MEMORY_HOST_PROTOCOL, requestId, epoch, ok: true, result })
        onHostSuccess?.(command.method, command.input)
      },
      error => {
        sendParent({ type: 'memory_host_result', protocol: MEMORY_HOST_PROTOCOL, requestId, epoch, ok: false, error: memoryHostFailure(error) })
      },
    ).finally(() => {
      hostRequests.delete(requestId)
    })
  }

  if (enabled && typeof port.send === 'function') port.on('message', receiveHost)

  return {
    sendParent,
    close() {
      if (enabled) port.off('message', receiveHost)
      for (const active of hostRequests.values()) active.controller.abort(new Error('Memory adapter closed'))
      hostRequests.clear()
    },
  }
}
