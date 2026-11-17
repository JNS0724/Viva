import { randomUUID } from 'node:crypto'
import { DIAGNOSTIC_LIMITS } from '../contracts.ts'
import type { DiagnosticHub } from './hub.ts'
import type { DiagnosticQuota } from './quota.ts'
import { replaceDiagnosticIdentity } from './identity.ts'

export type DiagnosticClearResult = { status: 'cleared' | 'cleanup_pending' | 'busy' }
/** Actual I/O remains single-flight after a caller deadline. Retrying never allocates another hung job. */
export function createDiagnosticClearer({ quota, hub, idle, timeoutMs = DIAGNOSTIC_LIMITS.snapshotMs }: {
  quota: DiagnosticQuota, hub: Pick<DiagnosticHub, 'prepare' | 'resume'>, idle: () => boolean, timeoutMs?: number,
}) {
  let actual: Promise<DiagnosticClearResult> | undefined
  let stage: { clearId: string, runId?: string } | undefined
  async function perform(): Promise<DiagnosticClearResult> {
    if (!idle()) return { status: 'busy' }
    if (!stage) { const state = await quota.clearState(); stage = { clearId: state.clearId ?? randomUUID() } }
    if (!stage.runId) {
      if (!await quota.beginClear(stage.clearId)) { stage = undefined; return { status: 'busy' } }
      if (!await hub.prepare(stage.clearId) || !await quota.clearClosed()) return { status: 'cleanup_pending' }
      const identity = await replaceDiagnosticIdentity(quota.directory)
      // Remember rotation before awaiting any other I/O: a retry must only resume this generation.
      stage.runId = identity.runId
      if (!await quota.finishClear(stage.clearId, stage.runId)) return { status: 'cleanup_pending' }
    } else {
      const state = await quota.clearState()
      if (state.clearId && !await quota.finishClear(stage.clearId, stage.runId)) return { status: 'cleanup_pending' }
    }
    if (!await hub.resume(stage.clearId, stage.runId)) return { status: 'cleanup_pending' }
    stage = undefined
    return { status: 'cleared' }
  }
  return {
    clear(): Promise<DiagnosticClearResult> {
      actual ??= perform().catch((): DiagnosticClearResult => ({ status: 'cleanup_pending' })).finally(() => { actual = undefined })
      const work = actual
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve({ status: 'cleanup_pending' }), timeoutMs)
        void work.then(result => { clearTimeout(timer); resolve(result) })
      })
    },
    pending: () => Boolean(actual || stage),
  }
}
