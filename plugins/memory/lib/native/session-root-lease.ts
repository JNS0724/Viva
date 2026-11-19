import { Worker } from 'node:worker_threads'
import { mkdir, realpath } from 'node:fs/promises'

const LEASE_STARTUP_MS = 30_000
export type SessionRootLeaseConfig = { sessionsRoot: string, memoryRoot: string, storageRoot: string }
// SQLite's OS lock excludes other processes. Reserve canonical roots here too, as
// multiple workers in this process can otherwise acquire POSIX process-scoped locks.
const localRoots = new Set<string>()

/** Keep the session-root lease through disposal of the stock JSONL provider and its consumers. */
export function acquireSessionRootLease(config: SessionRootLeaseConfig, onLost: () => void) {
  const entry = new URL(import.meta.url.endsWith('.ts') ? './session-root-lease-worker.ts' : './session-root-lease-worker.js', import.meta.url)
  let worker: Worker | undefined, reserved: string | undefined
  let acquired = false, closing = false, exited: Promise<void> | undefined, cleanup: Promise<void> | undefined
  const ready = Promise.resolve().then(async () => {
    await mkdir(config.sessionsRoot, { recursive: true })
    const sessionsRoot = await realpath(config.sessionsRoot)
    if (closing) throw new Error('Native session root lease is closing')
    if (localRoots.has(sessionsRoot)) throw new Error('Memory root already has an active owner')
    localRoots.add(sessionsRoot)
    reserved = sessionsRoot
    const thread = worker = new Worker(entry, { workerData: { ...config, sessionsRoot }, execArgv: [] })
    exited = new Promise<void>(resolve => thread.once('exit', () => {
      resolve()
      if (acquired && !closing) onLost()
    }))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void thread.terminate()
        reject(new Error('Native session root lease did not become available'))
      }, LEASE_STARTUP_MS)
      thread.once('message', () => {
        clearTimeout(timer)
        acquired = true
        resolve()
      })
      thread.on('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      void exited!.then(() => {
        clearTimeout(timer)
        reject(new Error('Native session root lease exited during startup'))
      })
    })
  })
  return {
    ready,
    close() {
      if (!cleanup) {
        closing = true
        // Early close is queued until the worker has completed lock acquisition.
        worker?.postMessage('close')
        cleanup = ready.catch(() => {}).then(async () => {
          await exited
          if (reserved) localRoots.delete(reserved)
        })
      }
      return cleanup
    },
  }
}
