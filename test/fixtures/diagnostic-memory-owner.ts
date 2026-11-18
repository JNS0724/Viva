import path from 'node:path'
import { openMemoryOwner } from '../../src/memory/node/owner.ts'
import { MEMORY_HOST_PROTOCOL, parseHostMemoryCommand } from '../../src/memory/contracts/host.ts'
import { memoryHostFailure } from '../../src/memory/contracts/domain-error.ts'
import { parseDiagnosticContext, NO_DIAGNOSTICS } from '../../src/diagnostics/contracts.ts'
import { createNodeDiagnostics } from '../../src/diagnostics/node/logger.ts'
import { diagnosticPort, installDiagnosticPort, withRemoteOperation } from '../../src/diagnostics/node/context.ts'

const root = process.argv[2]
if (!root) throw new Error('Missing benchmark root')
const logger = createNodeDiagnostics({ directory: path.join(root, 'diagnostics'), component: 'memory', version: '0.4.0' })
const contextOnly = { emit: () => undefined }
installDiagnosticPort(NO_DIAGNOSTICS)
const owner = openMemoryOwner({ root: path.join(root, 'memory'), dailyNotes: true, diagnostics: diagnosticPort,
  route: () => null, compute: () => null, quiesce: async () => {} })
await owner.recover()
await logger.ready
process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return
  if (raw.type === 'benchmark.mode' && 'enabled' in raw) {
    installDiagnosticPort(raw.enabled === true ? 'contextOnly' in raw && raw.contextOnly === true ? contextOnly : logger : NO_DIAGNOSTICS)
    process.send?.({ type: 'benchmark.mode', stats: logger.snapshot().stats, cpu: process.cpuUsage() })
    return
  }
  if (raw.type === 'benchmark.close') {
    void (async () => { await owner.close(); await logger.close(); process.exit(0) })()
    return
  }
  if (raw.type !== 'memory_host_request' || !('requestId' in raw) || !('method' in raw) || !('input' in raw)) return
  const requestId = raw.requestId
  const context = parseDiagnosticContext('diagnostics' in raw ? raw.diagnostics : undefined)
  void withRemoteOperation(context, 'memory.owner', async () => {
    const command = parseHostMemoryCommand(raw.method, raw.input)
    const result = await owner.handleHost(command.method, command.input)
    process.send?.({ type: 'memory_host_result', requestId, epoch: owner.epoch, ok: true, result })
  }).catch(error => process.send?.({ type: 'memory_host_result', requestId, epoch: owner.epoch, ok: false, error: memoryHostFailure(error) }))
})
process.on('disconnect', () => { void owner.close().finally(() => logger.close()).finally(() => process.exit(0)) })
process.send?.({ type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, state: 'ready', revision: 0, coreEpoch: 0 })
