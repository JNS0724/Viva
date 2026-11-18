import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDiagnosticsActions } from '../src/renderer/diagnostics-actions.ts'
import { initialDiagnostics } from '../src/renderer/diagnostics-state.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import type { IpcResults } from '../src/shared/ipc-results.ts'

const status: IpcResults['diagnostics:status'] = { state: 'ready', droppedCount: 7, queuedBytes: 0, activeCount: 0,
  exporting: false, cleanupPending: false, debugRemainingMs: 0 }
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
type Api = Parameters<typeof createDiagnosticsActions>[0]['api']
function harness(changes: Partial<Api> = {}) {
  let state: State = initialState
  const api: Api = { diagnosticsStatus: async () => status, exportDiagnostics: async () => ({ status: 'saved' }),
    openDiagnosticsFolder: async () => {}, clearDiagnostics: async () => ({ status: 'cleared' }), debugDiagnostics: async () => {}, ...changes }
  const dispatch = (action: Action) => { state = reduce(state, action) }
  return { actions: createDiagnosticsActions({ api, getState: () => state, dispatch }), view: () => state.diagnostics, state: () => state, dispatch }
}

test('diagnostic state is immutable and survives a conversation change without altering memory or drafts', () => {
  assert.ok(Object.isFrozen(initialDiagnostics))
  const first = reduce(initialState, { type: 'diagnostics_loaded', status: Object.freeze({ ...status }) })
  const busy = reduce(first, { type: 'diagnostics_busy', kind: 'clear' })
  const next = reduce(busy, { type: 'new_session' })
  assert.equal(first.diagnostics.busy, null)
  assert.equal(initialDiagnostics.status, null)
  assert.equal(next.diagnostics, busy.diagnostics)
  assert.equal(first.memory, initialState.memory)
})

test('a stale pending status cannot replace a new control result and repeated export clicks issue one request', async () => {
  const old = pending<IpcResults['diagnostics:status']>(), exported = pending<IpcResults['diagnostics:export']>()
  let reads = 0, exports = 0
  const f = harness({ diagnosticsStatus: () => ++reads === 1 ? old.promise : Promise.resolve(status),
    exportDiagnostics: () => { exports++; return exported.promise } })
  const loading = f.actions.refresh()
  const exporting = f.actions.export()
  await f.actions.export()
  assert.equal(exports, 1)
  exported.resolve({ status: 'saved' }); await exporting
  old.resolve({ ...status, cleanupPending: true, droppedCount: 999 }); await loading
  assert.equal(f.view().notice, 'saved')
  assert.equal(f.view().status?.droppedCount, 7)
  assert.equal(f.view().status?.cleanupPending, false)
})

test('status has a finite budget while Shell export and cleanup retry remain independent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0, clears = 0
  const never = new Promise<IpcResults['diagnostics:status']>(() => {})
  const f = harness({ diagnosticsStatus: () => ++reads === 1 ? never : Promise.resolve({ ...status, cleanupPending: clears === 1 }),
    clearDiagnostics: async () => ++clears === 1 ? { status: 'cleanup_pending' } : { status: 'cleared' } })
  const loading = f.actions.refresh()
  await Promise.resolve() // The IPC request must actually start before advancing its caller deadline.
  t.mock.timers.tick(2000); await loading
  assert.equal(f.view().failed, true)
  await f.actions.export(); assert.equal(f.view().notice, 'saved')
  await f.actions.clear(); assert.equal(f.view().notice, 'cleanup_pending'); assert.equal(f.view().status?.cleanupPending, true)
  await f.actions.clear(); assert.equal(f.view().notice, 'cleared'); assert.equal(f.view().status?.cleanupPending, false)
})

test('debug expires even if status refresh fails after enabling it, and failure never exposes a raw IPC error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let failed = false
  const f = harness({ diagnosticsStatus: async () => { if (failed) throw new Error('SECRET_IPC_BODY'); return status } })
  await f.actions.refresh()
  failed = true
  await f.actions.debug(true)
  assert.equal(f.view().status?.debugRemainingMs, 15 * 60_000)
  assert.equal(f.view().failed, true)
  t.mock.timers.tick(15 * 60_000)
  assert.equal(f.view().status?.debugRemainingMs, 0)
  assert.doesNotMatch(JSON.stringify(f.view()), /SECRET_IPC_BODY/)
  const broken = harness({ exportDiagnostics: async () => { throw new Error('SECRET_EXPORT_PATH') } })
  await broken.actions.export()
  assert.equal(broken.view().notice, 'failed')
  assert.equal(broken.view().busy, null)
  assert.doesNotMatch(JSON.stringify(broken.view()), /SECRET_EXPORT_PATH/)
})
