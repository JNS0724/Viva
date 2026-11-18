import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { DIAGNOSTIC_LIMITS, safeDiagnosticReason } from '../contracts.ts'
import type { DiagnosticQuota, ExportPin } from './quota.ts'
import type { DiagnosticBundleRequest } from './bundle.ts'
export type DiagnosticExportResult = { status: 'saved' | 'failed' | 'busy'; reason?: string }

/** One export and one watchdog. Unconfirmed cleanup prevents another child/pin allocation. */
export function createDiagnosticExporter({ quota, snapshots = async () => [], timeoutMs = DIAGNOSTIC_LIMITS.exportMs }: { quota: DiagnosticQuota; snapshots?: () => Promise<unknown>; timeoutMs?: number }) {
  let state: 'idle' | 'exporting' | 'cleanup_pending' = 'idle'
  let running: Promise<DiagnosticExportResult> | undefined
  let cleanupFiles: { temporary: string, pin?: ExportPin } | undefined
  let cleaning: Promise<boolean> | undefined
  function releaseFiles(): Promise<boolean> {
    const files = cleanupFiles
    if (!files) return Promise.resolve(state === 'idle')
    cleaning ??= (async () => {
      try {
        await unlink(files.temporary).catch(error => { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error })
        if (files.pin) await quota.release(files.pin)
        cleanupFiles = undefined
        state = 'idle'
        return true
      } catch { return false }
    })().finally(() => { cleaning = undefined })
    return cleaning
  }
  async function ensureIdle() {
    if (state === 'idle') return true
    // Never replace a live child, an unconfirmed acquisition, or an outstanding cleanup I/O.
    if (!cleanupFiles || cleaning) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([releaseFiles(), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), DIAGNOSTIC_LIMITS.snapshotMs) })])
    } finally { clearTimeout(timer) }
  }
  let snapshotInFlight = false
  function boundedSnapshots(): Promise<unknown> {
    if (snapshotInFlight) return Promise.resolve([])
    snapshotInFlight = true
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve([]), DIAGNOSTIC_LIMITS.snapshotMs)
      void Promise.resolve().then(snapshots).then(value => { snapshotInFlight = false; clearTimeout(timer); resolve(value) }, () => { snapshotInFlight = false; clearTimeout(timer); resolve([]) })
    })
  }
  function start(destination: string): Promise<DiagnosticExportResult> {
    state = 'exporting'
    return new Promise<DiagnosticExportResult>(resolve => {
      const exportId = randomUUID()
      const temporary = `${destination}.${exportId}.partial`
      const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './export-worker.ts' : './export-worker.js', import.meta.url))
      let child: ChildProcess
      try { child = fork(entry, [], { execPath: process.execPath, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) }
      catch (error) { state = 'idle'; resolve({ status: 'failed', reason: safeDiagnosticReason(error) }); return }
      let pin: ExportPin | undefined, acquiring = true, exited = false, settled = false
      let reply: DiagnosticExportResult = { status: 'failed', reason: 'unknown_error' }
      const finish = (result: DiagnosticExportResult) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(result) } }
      let handedOff = false
      const cleanup = async () => {
        if (!exited || acquiring || handedOff) return
        handedOff = true
        state = 'cleanup_pending'
        cleanupFiles = { temporary, pin }
        await releaseFiles()
      }
      const deadline = setTimeout(() => {
        state = 'cleanup_pending'
        child.kill('SIGKILL')
        finish({ status: 'failed', reason: 'timeout' })
      }, timeoutMs)
      const snapshot = boundedSnapshots()
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'diagnostic-export-result') return
        reply = 'ok' in raw && raw.ok === true ? { status: 'saved' } : { status: 'failed', reason: 'unknown_error' }
      })
      child.once('error', error => {
        reply = { status: 'failed', reason: safeDiagnosticReason(error) }; state = 'cleanup_pending'
        if (!child.pid) exited = true
        void cleanup()
        finish(reply)
      })
      child.once('exit', () => {
        exited = true; state = 'cleanup_pending'
        void cleanup().finally(() => finish(reply))
      })
      void (async () => {
        try {
          const selected = await quota.pin(child.pid ?? process.pid, { id: exportId, temporary })
          pin = selected.pin; acquiring = false
          if (settled || exited) { await cleanup(); return }
          const request: DiagnosticBundleRequest = { directory: quota.directory, destination, temporary, files: selected.files, snapshots: await snapshot }
          if (settled || exited) { await cleanup(); return }
          child.send(request)
        } catch (error) {
          acquiring = false
          const reason = safeDiagnosticReason(error)
          reply = { status: reason === 'busy' ? 'busy' : 'failed', reason }
          state = 'cleanup_pending'; child.kill('SIGKILL')
          if (exited) await cleanup()
        }
      })()
    })
  }
  function exportBundle(destination: string): Promise<DiagnosticExportResult> {
    if (running) return running
    const task = state === 'idle' ? start(destination) : ensureIdle().then((idle): DiagnosticExportResult | Promise<DiagnosticExportResult> =>
      idle ? start(destination) : { status: 'busy', reason: 'cleanup_pending' })
    running = task.finally(() => { running = undefined })
    return running
  }
  return { exportBundle, ensureIdle, state: () => state }
}
