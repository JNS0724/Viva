import { createDiagnosticPeer } from '../../src/diagnostics/node/peer.ts'
import { START } from '../../src/backend/wire.ts'
import { createRpcServer } from '../../src/backend/rpc-server.ts'
import { createRemoteHost } from '../../src/backend/remote-host.ts'
import { createEnvelope } from '../../src/backend/envelope.ts'

process.once('message', async raw => {
  const start = START.parse(raw)
  const source = { snapshot: () => ({ stats: { state: 'unavailable' as const, queuedBytes: 0, peakQueuedBytes: 0, maxWriteDelayMs: 0, droppedCount: 0, writtenBytes: 0, activeCount: 0, untrackedCount: 0 }, active: [] }) }
  // Deliberately publishes health before readiness, as a real cold backend may.
  const peer = createDiagnosticPeer({ component: 'backend', source, send(message, settled) { process.send?.(message, settled) } })
  process.on('message', peer.receive)
  const remote = createRemoteHost({ start, secrets: createEnvelope({ key: null }) })
  const server = createRpcServer({ token: start.token, channels: new Map(), remote, since: () => [], image: () => new Response(null, { status: 404 }),
    controls: { close: () => { setTimeout(() => { peer.close(); void server.close().finally(() => process.exit(0)) }, 50) } } })
  const port = await server.listen()
  process.send?.({ type: 'ready', port, channels: [], locale: 'en' })
})
