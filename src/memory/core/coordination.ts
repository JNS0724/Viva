import { MemoryDispatchConflict, needsMemoryTransport } from './memory-dispatch.ts'
import type { MemoryProvenance } from './ports/store.ts'

export type MemoryProject = { kind: 'project', id: string }
/** Normalized saved occurrence; no host database rows or IPC objects cross this port. */
export type MemoryHistoryOccurrence = { segmentId: string, role: string, text: string, sourceId?: string | null, sessionId?: string | null }
type Admission = { allowed: false } | { allowed: true, deadline: number | null, evidence: MemoryProvenance, at: number }

/** Domain operations used by the coordinator. Host identities have already been resolved. */
export interface MemoryCoordinationRuntime {
  busy(): boolean
  sourceCurrent(id: string): boolean
  allowedHistory(occurrence: MemoryHistoryOccurrence): boolean
  staleSession(session: string): boolean
  sessionProject(session: string): string | undefined
  recordSessionProject(session: string, project: string): void
  projectAllows(evidence: Pick<MemoryProvenance, 'dependencies' | 'sources' | 'projects'>, project?: MemoryProject): boolean
  provisionalReadsCurrent(session: string, at?: number): boolean
  provisionalDeadline(session: string, at: number): number | undefined
  computeAdmission(job: string): { current(): boolean, deadline: number | null } | null
}

/** Dispatch storage/transport adaptation stays behind this port, including its in-flight wait. */
export interface MemoryCoordinationDispatch {
  snapshot(session: string): MemoryProvenance
  inherit(parent: string, child: string): void
  recordSource(session: string, source: string): void
  stale(session: string): boolean
  admission(session: string): Admission
  acquireSession(id: string, session: string, admission: Extract<Admission, { allowed: true }>, current: () => boolean): void
  acquire(id: string, current: () => boolean): void
  release(id: string): void
  sessionsOf(requests: readonly string[]): string[]
  whenIdle(requests: readonly string[]): Promise<void>
  transferable(evidence: MemoryProvenance): boolean
  attach(session: string, evidence: MemoryProvenance): void
}

export class MemoryCoordinationError extends Error {
  readonly code = 'mutation-pending'
  constructor() { super('A memory mutation is already in progress') }
}

/**
 * One owner coordinates mutation and existing dispatch leases. No host lifecycle, filesystem,
 * renderer or DSH state enters this module. P2's physical payload fence extends the dispatch port;
 * this extraction deliberately retains the currently shipped lease/rollback protocol.
 */
export function createMemoryCoordination({ runtime, dispatch, now = Date.now }: {
  runtime: () => MemoryCoordinationRuntime | undefined,
  dispatch: () => MemoryCoordinationDispatch | undefined,
  now?: () => number,
}) {
  let transition = false
  const blocked = new Set<string>()
  // A late transport acknowledgment belongs to the dispatcher that granted it, even after
  // composition replaced its owner. Keep old leases until their own transport reports completion.
  const acquired = new Map<string, MemoryCoordinationDispatch>()
  const busy = () => transition || Boolean(runtime()?.busy())
  const projectChanged = (session: string | null | undefined, project?: MemoryProject) => {
    const saved = session ? runtime()?.sessionProject(session) : undefined
    return saved !== undefined && saved !== (project?.id ?? '')
  }
  const allowsEvidence = (evidence: MemoryProvenance | null | undefined, project?: MemoryProject) =>
    !evidence || Boolean(runtime()?.projectAllows(evidence, project))
  function bindProject(session: string, project?: MemoryProject) {
    const owner = runtime()
    if (!owner || projectChanged(session, project)) return false
    if (owner.sessionProject(session) === undefined) owner.recordSessionProject(session, project?.id ?? '')
    return true
  }
  function stale(session: string | null | undefined, project?: MemoryProject) {
    if (!session) return false
    const owner = runtime()
    return !owner || owner.staleSession(session) || projectChanged(session, project)
      || Boolean(dispatch()?.stale(session)) || !owner.provisionalReadsCurrent(session)
  }
  function allowsSession(session: string, project?: MemoryProject) {
    return !busy() && !stale(session, project) && allowsEvidence(dispatch()?.snapshot(session), project)
  }
  const canTransferToModel = (session: string, transportReady: boolean) =>
    transportReady || !needsMemoryTransport(dispatch()?.snapshot(session))

  function allowsTransport(session: string, project: MemoryProject | undefined, transportReady: boolean, isTask: boolean) {
    if (!allowsSession(session, project)) return false
    if (transportReady) return true
    const evidence = dispatch()?.snapshot(session)
    if (isTask) return !needsMemoryTransport(evidence)
    const admission = dispatch()?.admission(session)
    return !evidence?.turnOnly && !evidence?.dependencies.length && (!admission || admission.allowed && admission.deadline === null)
  }

  function beginSession(id: string, session: string, project: MemoryProject | undefined, currentProject: () => MemoryProject | undefined) {
    const owner = runtime()
    const leases = dispatch()
    const at = now()
    if (acquired.has(id) || !owner || !leases || blocked.has(session) || owner.staleSession(session) || !owner.provisionalReadsCurrent(session, at)) return false
    const admission = leases.admission(session)
    if (!admission.allowed || !allowsEvidence(admission.evidence, project) || !bindProject(session, project)) return false
    const provisional = owner.provisionalDeadline(session, at)
    leases.acquireSession(id, session, admission, () => runtime() === owner && dispatch() === leases
      && !owner.staleSession(session) && owner.provisionalReadsCurrent(session, at)
      && !projectChanged(session, currentProject()) && allowsEvidence(admission.evidence, currentProject()))
    acquired.set(id, leases)
    return { allowed: true as const, deadline: provisional === undefined ? admission.deadline : Math.min(provisional, admission.deadline ?? Infinity) }
  }

  function beginJob(id: string, jobId: string) {
    if (busy() || acquired.has(id)) return false
    const owner = runtime()
    const leases = dispatch()
    const job = owner?.computeAdmission(jobId)
    if (!owner || !leases || !job) return false
    leases.acquire(id, () => runtime() === owner && dispatch() === leases && job.current())
    acquired.set(id, leases)
    return { allowed: true as const, deadline: job.deadline }
  }

  const transferable = (evidence: MemoryProvenance | null | undefined) => !evidence || Boolean(dispatch()?.transferable(evidence))
  function transferStatus(evidence: MemoryProvenance | null | undefined, project: MemoryProject | undefined, transportReady: boolean): 'ready' | 'stale' | 'memory-unavailable' {
    if (!allowsEvidence(evidence, project) || !transferable(evidence)) return 'stale'
    if (needsMemoryTransport(evidence) && !transportReady) return 'memory-unavailable'
    return 'ready'
  }
  function transfer(session: string, evidence: MemoryProvenance | null | undefined, project: MemoryProject | undefined, transportReady: boolean) {
    if (transferStatus(evidence, project, transportReady) !== 'ready') return false
    if (evidence) dispatch()!.attach(session, evidence)
    return true
  }
  function canInherit(source: string, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, transportReady: boolean) {
    return !stale(source, sourceProject) && canTransferToModel(source, transportReady) && allowsEvidence(dispatch()?.snapshot(source), targetProject)
  }
  function inherit(source: string, target: string, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, transportReady: boolean) {
    if (!canInherit(source, sourceProject, targetProject, transportReady)) return false
    dispatch()?.inherit(source, target)
    return true
  }
  function allowsHistory(row: MemoryHistoryOccurrence, sourceProject?: MemoryProject) {
    const owner = runtime()
    return Boolean(owner?.allowedHistory(row) && (!row.sourceId || owner.sourceCurrent(row.sourceId))
      && ((row.role === 'user' && Boolean(row.sourceId)) || !stale(row.sessionId, sourceProject)))
  }
  function allowsProjectHistory(row: MemoryHistoryOccurrence, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, sessionProject?: MemoryProject) {
    if (sourceProject?.id !== targetProject?.id || !allowsHistory(row, sessionProject)) return false
    if (row.sourceId && !runtime()?.projectAllows({ dependencies: [], sources: [row.sourceId] }, targetProject)) return false
    return (row.role === 'user' && Boolean(row.sourceId)) || !row.sessionId || allowsEvidence(dispatch()?.snapshot(row.sessionId), targetProject)
  }
  function useHistory(session: string | undefined, row: MemoryHistoryOccurrence) {
    if (!session) return
    const leases = dispatch()
    if (row.sourceId) leases?.recordSource(session, row.sourceId)
    if (row.sessionId && (row.role !== 'user' || !row.sourceId)) leases?.inherit(row.sessionId, session)
  }

  async function mutate<T>(work: () => T | Promise<T>, prepare?: () => void | Promise<void>): Promise<T> {
    if (busy()) throw new MemoryCoordinationError()
    transition = true
    try {
      await prepare?.()
      for (;;) {
        try { return await work() }
        catch (error) {
          if (!(error instanceof MemoryDispatchConflict)) throw error
          const owners = new Map<MemoryCoordinationDispatch, string[]>()
          for (const request of error.requests) {
            const leases = acquired.get(request) ?? dispatch()
            if (!leases) throw error
            const requests = owners.get(leases) ?? []
            requests.push(request)
            owners.set(leases, requests)
          }
          for (const [leases, requests] of owners) for (const session of leases.sessionsOf(requests)) blocked.add(session)
          await Promise.all([...owners].map(([leases, requests]) => leases.whenIdle(requests)))
        }
      }
    } finally {
      blocked.clear()
      transition = false
    }
  }

  function endDispatch(id: string) {
    const leases = acquired.get(id)
    if (!leases) return
    leases.release(id)
    acquired.delete(id)
  }

  return { busy, projectChanged, bindProject, allowsEvidence, stale, allowsSession, canTransferToModel,
    allowsTransport, beginSession, beginJob, transferable, transferStatus, transfer, canInherit, inherit, allowsHistory, allowsProjectHistory, useHistory, mutate, endDispatch }
}
