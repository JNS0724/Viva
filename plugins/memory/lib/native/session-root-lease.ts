import { Worker } from 'node:worker_threads'
import { mkdir, realpath } from 'node:fs/promises'
import { createRequestBudget, DEFAULT_TOOL_TIMEOUT_MS, INITIALIZATION_BUDGET_MS } from '../../../../src/shared/request-budget.ts'

export type SessionRootLeaseConfig = { sessionsRoot: string, memoryRoot: string, storageRoot: string }
// SQLite's OS lock excludes other processes. Workers in one process also need a canonical root reservation.
const localRoots = new Set<string>()

/** Keep the session-root lease through disposal of the stock JSONL provider and its consumers. */
export function acquireSessionRootLease(config: SessionRootLeaseConfig, onLost: () => void) {
  const entry = new URL(import.meta.url.endsWith('.ts') ? './session-root-lease-worker.ts' : './session-root-lease-worker.js', import.meta.url)
  const startup = createRequestBudget(INITIALIZATION_BUDGET_MS)
  let worker: Worker | undefined, exited: Promise<void> | undefined
  let reserved: string | undefined, stopped = false
  let acquired = false, closing = false, cleanup: Promise<void> | undefined

  const ready = startup.run(async () => {
    await mkdir(config.sessionsRoot, { recursive: true })
    const root = await realpath(config.sessionsRoot)
    startup.signal.throwIfAborted()
    if (localRoots.has(root)) throw new Error('Memory root already has an active owner')
    const thread = new Worker(entry, { workerData: { ...config, sessionsRoot: root }, execArgv: [] })
    worker = thread
    reserved = root
    localRoots.add(root)
    exited = new Promise<void>(resolve => thread.once('exit', () => {
      stopped = true
      if (closing || !acquired) localRoots.delete(root)
      resolve()
      if (acquired && !closing) onLost()
    }))
    await new Promise<void>((resolve, reject) => {
      thread.once('message', () => { acquired = true; resolve() })
      thread.on('error', reject)
      void exited!.then(() => reject(new Error('Native session root lease exited during startup')))
    })
  }).catch(error => {
    if (worker && !closing) void worker.terminate().catch(() => {})
    throw error
  }).finally(() => startup.close())

  function close() {
    closing = true
    startup.cancel(new Error('Native session root lease is closing'))
    const thread = worker
    if (stopped && acquired && reserved) localRoots.delete(reserved)
    if (!thread || !exited || stopped) return Promise.resolve()
    thread.postMessage('close')
    const grace = createRequestBudget(DEFAULT_TOOL_TIMEOUT_MS)
    return grace.run(() => exited).catch(() => {
      // A blocked filesystem call can outlive termination. Keep the local reservation
      // until the worker actually exits, without trapping disposal of the host.
      thread.unref()
      void thread.terminate().catch(() => {})
    }).finally(() => grace.close())
  }
  return { ready, close: () => cleanup ??= close() }
}
