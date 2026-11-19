import { parentPort, workerData } from 'node:worker_threads'
import path from 'node:path'
import { lockMemoryRoot } from '../../../../src/memory/node/owner-lock.ts'
import { eraseColdNativeCopies } from './maintenance.ts'
import type { SessionRootLeaseConfig } from './session-root-lease.ts'

if (!parentPort) throw new Error('Missing session lease parent')
const port = parentPort
const config = workerData as SessionRootLeaseConfig
const lease = lockMemoryRoot(path.join(config.sessionsRoot, '.viva-memory-host'))
let closing = false, preparing = true
function close() {
  try { lease.close() } finally { port.close() }
}
port.once('message', () => {
  closing = true
  if (!preparing) close()
})
try {
  await eraseColdNativeCopies({ ...config, hostNamespace: undefined, isCold: () => !closing,
    trace: { key: () => undefined, erase() { throw new Error('Standalone persistence does not own a Viva trace') } },
  })
} catch (error) {
  close()
  throw error
}
preparing = false
if (closing) close()
else port.postMessage('ready')
