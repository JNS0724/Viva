import { MemoryDispatchConflict, needsMemoryTransport } from './memory-dispatch.ts'
import type { FileEvidenceCurrent } from './memory-dispatch.ts'
import { MemoryDomainError } from './presentation.ts'
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
  sessionCrossProject?(session: string): boolean
  recordSessionCrossProject?(session: string): void
  projectAllows(evidence: Pick<MemoryProvenance, 'sources' | 'projects' | 'files'>, project?: MemoryProject, acceptsFiles?: FileEvidenceCurrent, crossProject?: boolean): boolean
  computeAdmission(job: string): { current(): boolean, deadline: number | null } | null
}

/** Dispatch storage/transport adaptation stays behind this port, including its in-flight wait. */
export interface MemoryCoordinationDispatch {
  snapshot(session: string): MemoryProvenance
  inherit(parent: string, child: string): void
  recordSource(session: string, source: string): void
  stale(session: string, acceptsFiles?: FileEvidenceCurrent): boolean
  admission(session: string, acceptsFiles?: FileEvidenceCurrent): Admission
  acquireSession(id: string, session: string, admission: Extract<Admission, { allowed: true }>, current: () => boolean, acceptsFiles?: FileEvidenceCurrent): void
  acquire(id: string, current: () => boolean): void
  release(id: string): void
  sessionsOf(requests: readonly string[]): string[]
  whenIdle(requests: readonly string[]): Promise<void>
  transferable(evidence: MemoryProvenance, acceptsFiles?: FileEvidenceCurrent): boolean
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
export function createMemoryCoordination({ runtime, dispatch }: {
  runtime: () => MemoryCoordinationRuntime | undefined,
  dispatch: () => MemoryCoordinationDispatch | undefined,
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
  const sessionCrossProject = (session: string | null | undefined) => Boolean(session && runtime()?.sessionCrossProject?.(session))
  const markCrossProject = (session: string) => { runtime()?.recordSessionCrossProject?.(session) }
  const allowsEvidence = (evidence: MemoryProvenance | null | undefined, project?: MemoryProject, acceptsFiles?: FileEvidenceCurrent, crossProject = false) =>
    !evidence || Boolean(runtime()?.projectAllows(evidence, project, acceptsFiles, crossProject))
  function bindProject(session: string, project?: MemoryProject) {
    const owner = runtime()
    if (!owner || projectChanged(session, project)) return false
    if (owner.sessionProject(session) === undefined) owner.recordSessionProject(session, project?.id ?? '')
    return true
  }
  function stale(session: string | null | undefined, project?: MemoryProject, acceptsFiles?: FileEvidenceCurrent) {
    if (!session) return false
    const owner = runtime()
    return !owner || owner.staleSession(session) || projectChanged(session, project)
      || Boolean(dispatch()?.stale(session, acceptsFiles))
  }
  function allowsSession(session: string, project?: MemoryProject, acceptsFiles?: FileEvidenceCurrent) {
    return !busy() && !stale(session, project, acceptsFiles)
      && allowsEvidence(dispatch()?.snapshot(session), project, acceptsFiles, sessionCrossProject(session))
  }
  const canTransferToModel = (session: string, transportReady: boolean) =>
    transportReady || !needsMemoryTransport(dispatch()?.snapshot(session))

  function allowsTransport(session: string, project: MemoryProject | undefined, transportReady: boolean, isTask: boolean) {
    if (!allowsSession(session, project)) return false
    if (transportReady) return true
    const evidence = dispatch()?.snapshot(session)
    if (isTask) return !needsMemoryTransport(evidence)
    const admission = dispatch()?.admission(session)
    return !evidence?.turnOnly && !evidence?.files?.length && (!admission || admission.allowed && admission.deadline === null)
  }

  function beginSession(id: string, session: string, project: MemoryProject | undefined, currentProject: () => MemoryProject | undefined, acceptsFiles?: FileEvidenceCurrent) {
    const owner = runtime()
    const leases = dispatch()
    if (acquired.has(id) || !owner || !leases || blocked.has(session) || owner.staleSession(session)) return false
    const admission = leases.admission(session, acceptsFiles)
    if (!admission.allowed || !allowsEvidence(admission.evidence, project, acceptsFiles, sessionCrossProject(session)) || !bindProject(session, project)) return false
    leases.acquireSession(id, session, admission, () => runtime() === owner && dispatch() === leases
      && !owner.staleSession(session)
      && !projectChanged(session, currentProject())
      && allowsEvidence(admission.evidence, currentProject(), acceptsFiles, sessionCrossProject(session)), acceptsFiles)
    acquired.set(id, leases)
    return { allowed: true as const, evidence: admission.evidence, deadline: admission.deadline }
  }

  function beginJob(id: string, jobId: string, proof?: ReturnType<MemoryCoordinationRuntime['computeAdmission']>) {
    if (busy() || acquired.has(id)) return false
    const owner = runtime()
    const leases = dispatch()
    const job = proof === undefined ? owner?.computeAdmission(jobId) : proof
    if (!owner || !leases || !job?.current()) return false
    leases.acquire(id, () => runtime() === owner && dispatch() === leases && job.current())
    acquired.set(id, leases)
    return { allowed: true as const, deadline: job.deadline }
  }

  const transferable = (evidence: MemoryProvenance | null | undefined, acceptsFiles?: FileEvidenceCurrent) => !evidence || Boolean(dispatch()?.transferable(evidence, acceptsFiles))
  function transferStatus(evidence: MemoryProvenance | null | undefined, project: MemoryProject | undefined, transportReady: boolean, acceptsFiles?: FileEvidenceCurrent, crossProject = false): 'ready' | 'stale' | 'memory-unavailable' {
    if (!allowsEvidence(evidence, project, acceptsFiles, crossProject) || !transferable(evidence, acceptsFiles)) return 'stale'
    if (needsMemoryTransport(evidence) && !transportReady) return 'memory-unavailable'
    return 'ready'
  }
  function transfer(session: string, evidence: MemoryProvenance | null | undefined, project: MemoryProject | undefined, transportReady: boolean, acceptsFiles?: FileEvidenceCurrent, crossProject = false) {
    const allowCross = Boolean(crossProject || sessionCrossProject(session))
    if (transferStatus(evidence, project, transportReady, acceptsFiles, allowCross) !== 'ready') return false
    if (evidence) {
      dispatch()!.attach(session, evidence)
      if (allowCross && !allowsEvidence(evidence, project, acceptsFiles, false)) markCrossProject(session)
    }
    return true
  }
  function canInherit(source: string, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, transportReady: boolean, acceptsFiles?: FileEvidenceCurrent, crossProject = false) {
    return !stale(source, sourceProject, acceptsFiles) && canTransferToModel(source, transportReady)
      && allowsEvidence(dispatch()?.snapshot(source), targetProject, acceptsFiles, crossProject)
  }
  function inherit(source: string, target: string, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, transportReady: boolean, acceptsFiles?: FileEvidenceCurrent, crossProject = false) {
    const allowCross = Boolean(crossProject || (source === target && sessionCrossProject(target)))
    if (!canInherit(source, sourceProject, targetProject, transportReady, acceptsFiles, allowCross)) return false
    const snapshot = dispatch()?.snapshot(source)
    dispatch()?.inherit(source, target)
    if (allowCross && (sessionCrossProject(source) || !allowsEvidence(snapshot, targetProject, acceptsFiles, false))) markCrossProject(target)
    return true
  }
  function allowsHistory(row: MemoryHistoryOccurrence, sourceProject?: MemoryProject, acceptsFiles?: FileEvidenceCurrent) {
    const owner = runtime()
    return Boolean(owner?.allowedHistory(row) && (!row.sourceId || owner.sourceCurrent(row.sourceId))
      && ((row.role === 'user' && Boolean(row.sourceId)) || !stale(row.sessionId, sourceProject, acceptsFiles)))
  }
  function allowsProjectHistory(row: MemoryHistoryOccurrence, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, sessionProject?: MemoryProject, acceptsFiles?: FileEvidenceCurrent, crossProject = false) {
    if (!crossProject && sourceProject?.id !== targetProject?.id) return false
    if (!allowsHistory(row, sessionProject, acceptsFiles)) return false
    if (!crossProject && row.sourceId && !runtime()?.projectAllows({ sources: [row.sourceId] }, targetProject)) return false
    return (row.role === 'user' && Boolean(row.sourceId)) || !row.sessionId
      || allowsEvidence(dispatch()?.snapshot(row.sessionId), targetProject, acceptsFiles, crossProject)
  }
  function useHistory(session: string | undefined, row: MemoryHistoryOccurrence, acceptsFiles?: FileEvidenceCurrent, crossProject = false) {
    const owner = runtime()
    const leases = dispatch()
    const sourceProject = row.sessionId ? owner?.sessionProject(row.sessionId) : undefined
    if (busy() || !owner || !leases || !allowsHistory(row, sourceProject ? { kind: 'project', id: sourceProject } : undefined, acceptsFiles)) {
      throw new MemoryDomainError('revision.conflict')
    }
    if (!session) return
    const targetProject = owner.sessionProject(session)
    const project = targetProject ? { kind: 'project' as const, id: targetProject } : undefined
    const allowCross = Boolean(crossProject)
    const sourceSnapshot = row.sessionId && (row.role !== 'user' || !row.sourceId) ? leases.snapshot(row.sessionId) : undefined
    if (!allowCross && row.sourceId && !owner.projectAllows({ sources: [row.sourceId] }, project)
      || sourceSnapshot && !allowsEvidence(sourceSnapshot, project, acceptsFiles, allowCross)) {
      throw new MemoryDomainError('revision.conflict')
    }
    const crosses = allowCross && (
      Boolean(row.sourceId && !owner.projectAllows({ sources: [row.sourceId] }, project))
      || Boolean(sourceSnapshot && (sessionCrossProject(row.sessionId) || !allowsEvidence(sourceSnapshot, project, acceptsFiles, false)))
    )
    if (row.sourceId) leases.recordSource(session, row.sourceId)
    if (row.sessionId && (row.role !== 'user' || !row.sourceId)) leases.inherit(row.sessionId, session)
    if (crosses) markCrossProject(session)
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

  return { busy, projectChanged, bindProject, sessionCrossProject, allowsEvidence, stale, allowsSession, canTransferToModel,
    allowsTransport, beginSession, beginJob, transferable, transferStatus, transfer, canInherit, inherit, allowsHistory, allowsProjectHistory, useHistory, mutate, endDispatch }
}
