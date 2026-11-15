import type { MemoryDependency, MemoryProvenance, MemoryStore } from './ports/store.ts'
export type { MemoryDependency, MemoryProvenance } from './ports/store.ts'

export function needsMemoryTransport(evidence: MemoryProvenance | null | undefined) {
  return Boolean(evidence && (evidence.dependencies.length || evidence.sources.length || evidence.turnOnly))
}

export function combineMemoryProvenance(first: MemoryProvenance | null, second: MemoryProvenance): MemoryProvenance {
  if (!first) return second
  const dependencies = new Map([...first.dependencies, ...second.dependencies].map(item => [JSON.stringify(item), item]))
  const projects = [...new Set([...first.projects ?? [], ...second.projects ?? []])]
  return { ...(projects.length ? { projects } : {}), dependencies: [...dependencies.values()], sources: [...new Set([...first.sources, ...second.sources])], turnOnly: first.turnOnly || second.turnOnly,
    epoch: Math.min(first.epoch, second.epoch) }
}

export class MemoryDispatchConflict extends Error {
  readonly requests: readonly string[]
  constructor(requests: readonly string[]) {
    super('A model request is sending affected memory')
    this.requests = requests
  }
}

/** Retains the facts a DSH session has seen, including the inputs of its later replies and summaries. */
export function createMemoryDispatch(store: Pick<MemoryStore, 'dispatch' | 'epoch'>, current: (items: readonly MemoryDependency[], at?: number) => boolean,
  sourceCurrent: (id: string, at?: number) => boolean,
  nextBoundary?: (items: readonly MemoryDependency[], sources: readonly string[], at: number) => number | null,
) {
  const { snapshot, dependencies: record, source: recordSource, turnOnly: retainTurnOnly } = store.dispatch
  const liveTurnOnly = new Set<string>()
  const leases = new Map<string, { current: () => boolean, session?: string }>()
  const waiters = new Set<() => void>()
  function evidenceCurrent({ dependencies, sources }: MemoryProvenance, at: number) {
    return current(dependencies, at) && sources.every(id => sourceCurrent(id, at))
  }
  function attach(session: string, evidence: MemoryProvenance) {
    record(session, evidence.dependencies)
    for (const source of evidence.sources) recordSource(session, source)
    if (evidence.turnOnly) retainTurnOnly(session)
  }
  function admission(session: string) {
    const at = Date.now()
    const evidence = snapshot(session)
    if ((evidence.turnOnly && !liveTurnOnly.has(session)) || !evidenceCurrent(evidence, at)) return { allowed: false } as const
    return { allowed: true, deadline: nextBoundary?.(evidence.dependencies, evidence.sources, at) ?? null, evidence, at } as const
  }
  return {
    record, recordSource,
    inherit(parent: string, child: string) { if (parent !== child) attach(child, snapshot(parent)) },
    snapshot,
    attach,
    transferable: (evidence: MemoryProvenance) => !evidence.turnOnly && evidence.epoch === store.epoch() && evidenceCurrent(evidence, Date.now()),
    recordTurnOnly(session: string) { retainTurnOnly(session); liveTurnOnly.add(session) },
    endTurn(session: string) { liveTurnOnly.delete(session) },
    resetLive() { liveTurnOnly.clear() },
    admission,
    stale: (session: string) => !admission(session).allowed,
    acquire(id: string, check = () => false, session?: string) { leases.set(id, { current: check, session }) },
    acquireSession(id: string, session: string, admitted: Extract<ReturnType<typeof admission>, { allowed: true }>, stillAllowed: () => boolean) {
      leases.set(id, { session, current: () => stillAllowed() && evidenceCurrent(admitted.evidence, admitted.at) })
    },
    release(id: string) {
      if (leases.delete(id)) for (const notify of waiters) notify()
    },
    validateCommit() {
      const affected = [...leases].filter(([, request]) => !request.current()).map(([id]) => id)
      if (affected.length) throw new MemoryDispatchConflict(affected)
    },
    sessionsOf: (ids: readonly string[]) => ids.flatMap(id => leases.get(id)?.session ?? []),
    canCommit: () => leases.size === 0,
    whenIdle(ids: readonly string[] = [...leases.keys()]) {
      const idle = () => ids.every(id => !leases.has(id))
      if (idle()) return Promise.resolve()
      return new Promise<void>(resolve => {
        const notify = () => { if (idle()) { waiters.delete(notify); resolve() } }
        waiters.add(notify)
      })
    },
  }
}
