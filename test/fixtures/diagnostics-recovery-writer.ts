import { createNodeDiagnostics } from '../../src/diagnostics/node/logger.ts'
import { eventually } from './eventually.ts'

const directory = process.argv[2]
if (!directory) throw new Error('Missing owned diagnostic directory')
const logger = createNodeDiagnostics({ directory, component: 'memory' })
await logger.ready
const context = { version: 1 as const, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
logger.emit({ event: 'operation.start', operation: 'memory.write', stage: 'running' }, context)
logger.emit({ event: 'operation.progress', operation: 'memory.write', stage: 'checkpoint', identities: { resourceId: 'SECRET_PRIOR_BODY' } }, context)
if (!await eventually(() => logger.snapshot().stats.queuedBytes === 0 && logger.snapshot().stats.writtenBytes > 0, { timeoutMs: 2000, intervalMs: 5 })) throw new Error('Diagnostic fixture did not persist')
process.send?.({ type: 'persisted' })
process.on('disconnect', () => { void logger.close().finally(() => process.exit(0)) })
