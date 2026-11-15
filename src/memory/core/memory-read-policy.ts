import type { MemoryScope } from '../contracts/memory-contract.ts'
import type { MemoryStore, MemoryEntry, MemorySource, MemoryDependency } from './ports/store.ts'
import type { MemoryInterval } from './memory-intervals.ts'
import { covers, localDay, nextDay } from './memory-facts.ts'
import { intersect, overlapWindows, subtract } from './memory-intervals.ts'

export function contextAllows(owned: MemoryScope, scope: MemoryScope | undefined) {
  return owned.kind === 'user' || (scope?.kind !== 'user' && scope?.kind === owned.kind && scope.id === owned.id)
}
export function sourceCanRead(owned: MemoryScope, source: MemorySource) {
  const context = source.context ?? (source.conversation ? { kind: 'conversation' as const, id: source.conversation } : undefined)
  return contextAllows(owned, source.scope) || contextAllows(owned, context) || contextAllows(owned, source.project ?? undefined)
}
export const retained = (entry: MemoryEntry) => entry.retention === 'retained' && (entry.state === 'active' || entry.state === 'superseded')
export const visible = (entry: MemoryEntry, at: number) => retained(entry) && entry.windows.some(window => covers(window.from, window.to, at))

/** The same temporal/evidence eligibility policy is used by recall, profile, mutations and dispatch. */
export function createMemoryReadPolicy({ store, now, timezone, evidenceBlocked, sourceBlocked }: {
  store: MemoryStore,
  now: () => number,
  timezone: () => string,
  evidenceBlocked: (edge: MemoryEntry['evidence'][number]) => boolean,
  sourceBlocked: (source: Pick<MemorySource, 'id' | 'conversation'>) => boolean,
}) {
  const wholeEvidenceAvailable = (entry: MemoryEntry) => !entry.evidence.some(evidenceBlocked)
  function disputeBetween(first: MemoryEntry, second: MemoryEntry, changeId?: number, includeHeld = false) {
    if (!retained(first) || !retained(second) || !available(first, includeHeld) || !available(second, includeHeld)) return null
    for (const change of store.changesFor(first.id)) {
      if (change.kind !== 'possible_conflict' || (changeId !== undefined && change.id !== changeId)
        || (change.targetId !== second.id && change.replacementId !== second.id)) continue
      if (change.sourceId) {
        const source = store.readSource(change.sourceId)
        if (!source || store.sourceExcluded(source.id) || (!includeHeld && sourceBlocked(source))) continue
      }
      const windows = overlapWindows(first.windows, second.windows, change)
      if (windows.length) return { ...change, windows }
    }
    return null
  }

  function available(entry: MemoryEntry, includeHeld = false) {
    return !store.excluded(entry.text, entry.scope, entry.authorizedRevision)
      && entry.evidence.some(edge => includeHeld || !evidenceBlocked(edge))
  }

  function independentWindows(entry: MemoryEntry, projected = entry.windows, includeHeld = false) {
    const assertions = entry.evidence.filter(edge => edge.changeId === null && (includeHeld || !evidenceBlocked(edge)))
      .map(edge => ({ from: edge.assertedFrom, to: edge.assertedTo }))
    return overlapWindows(projected, assertions, { from: null, to: null })
  }

  function pendingRelationWindows(entry: MemoryEntry, byId: ReadonlyMap<number, MemoryEntry>, includeHeld = false) {
    return entry.links.flatMap(link => {
      if (link.kind !== 'pending-relation' || !link.incoming) return []
      const peer = byId.get(link.id)
      return peer && retained(peer) && available(peer, includeHeld)
        ? overlapWindows(entry.windows, independentWindows(peer, peer.windows, includeHeld), { from: link.from ?? null, to: link.to ?? null }) : []
    })
  }

  function selection(entries: MemoryEntry[], at: number) {
    return classify(entries.filter(entry => visible(entry, at) && available(entry)), { from: at, to: at + 1 })
  }

  function recallInterval(asOf: string | undefined, at: number): MemoryInterval | null {
    if (!asOf) return { from: at, to: at + 1 }
    const zone = timezone()
    const from = localDay(asOf, zone)
    if (from === null) return null
    const to = localDay(nextDay(asOf), zone)
    return to === null ? null : { from, to }
  }

  function classify(eligible: readonly MemoryEntry[], interval: MemoryInterval, includeHeld = false) {
    const byId = new Map(eligible.map(entry => [entry.id, entry]))
    const pending = new Map(eligible.flatMap(entry => {
      const windows = pendingRelationWindows(entry, byId, includeHeld)
      return windows.length ? [[entry.id, windows] as const] : []
    }))
    const disputes = eligible.flatMap(first => first.links.flatMap(link => {
      if (link.kind !== 'conflict' || first.id >= link.id || link.changeId === undefined) return []
      const second = byId.get(link.id)
      if (!second) return []
      const dispute = disputeBetween(first, second, link.changeId, includeHeld)
      if (!dispute) return []
      return [{ ...dispute, sides: [first, second] as const }]
    }))
    const applicable = disputes.filter(dispute => dispute.windows.some(window => intersect(window, interval)))
    const activeConflicts = new Set(applicable.flatMap(item => item.sides.map(side => side.id)))
    const contested = new Map<number, MemoryInterval[]>()
    for (const dispute of disputes) for (const side of dispute.sides) {
      const windows = contested.get(side.id) ?? []
      windows.push(...dispute.windows)
      contested.set(side.id, windows)
    }
    return {
      current: eligible.flatMap(entry => {
        const holds = [...contested.get(entry.id) ?? [], ...pending.get(entry.id) ?? []]
        if (!holds.length) return entry.windows.some(window => intersect(window, interval)) ? [entry] : []
        const windows = holds.reduce((rest, hold) => rest.flatMap(window => subtract(window, hold)), entry.windows)
        if (!windows.some(window => intersect(window, interval))) return []
        return [{ ...entry, windows, validFrom: windows[0].from, validTo: windows.at(-1)!.to }]
      }),
      conflicts: eligible.filter(entry => activeConflicts.has(entry.id)),
      disputes: applicable,
      pendingRelations: eligible.filter(entry => pending.get(entry.id)?.some(window => intersect(window, interval))),
    }
  }

  function recallSelection(entries: MemoryEntry[], asOf?: string, at = now()) {
    if (!asOf) return selection(entries, at)
    const day = recallInterval(asOf, at)
    return day ? classify(entries.filter(entry => retained(entry) && available(entry) && entry.windows.some(window => intersect(window, day))), day) : null
  }

  function scopedEntries(scope?: MemoryScope) {
    return store.listForScope(scope).filter(entry => store.modelEligible(entry.id))
  }

  function valid(scope?: MemoryScope) {
    return selection(store.listForScope(scope), now()).current
  }

  function entriesWithPeers(ids: ReadonlySet<number>) {
    const entries = new Map<number, MemoryEntry>()
    const load = (id: number) => {
      const entry = store.get(id)
      if (entry) entries.set(id, entry)
    }
    for (const id of ids) load(id)
    const peers = new Set([...entries.values()].flatMap(entry => entry.links.flatMap(link =>
      link.kind === 'conflict' || link.kind === 'pending-relation' ? [link.id] : [])))
    for (const id of peers) if (!ids.has(id)) load(id)
    return entries
  }

  function readableSelection(entries: readonly MemoryEntry[], interval: MemoryInterval) {
    // Held evidence still contests a peer until withdrawal commits and the timeline is reprojected.
    const selected = classify(entries.filter(entry => retained(entry) && available(entry, true)), interval, true)
    const disputeAvailable = (dispute: typeof selected.disputes[number]) =>
      dispute.sides.every(wholeEvidenceAvailable) && (!dispute.sourceId || !sourceBlocked({
        id: dispute.sourceId, conversation: store.readSource(dispute.sourceId)?.conversation ?? null,
      }))
    const disputes = selected.disputes.filter(disputeAvailable)
    const disputeIds = new Set(disputes.flatMap(item => item.sides.map(side => side.id)))
    const current = selected.current.filter(wholeEvidenceAvailable)
    return { ...selected, current, disputes, conflicts: selected.conflicts.filter(entry => disputeIds.has(entry.id)),
      held: current.length !== selected.current.length || disputes.length !== selected.disputes.length }
  }

  function dependenciesCurrent(items: readonly MemoryDependency[], at = now()) {
    if (!items.length) return true
    const entries = [...entriesWithPeers(new Set(items.map(item => item.id))).values()]
    const selections = new Map<string | undefined, ReturnType<typeof readableSelection>>()
    const revision = store.revision()
    return items.every(item => {
      if (item.collectionRevision !== undefined && item.collectionRevision !== revision) return false
      if (item.expiresAt !== undefined && at >= item.expiresAt) return false
      if (item.asOfZone !== undefined && item.asOfZone !== timezone()) return false
      if (!selections.has(item.asOf)) {
        const interval = recallInterval(item.asOf, at)
        if (!interval) return false
        selections.set(item.asOf, readableSelection(entries, interval))
      }
      const matching = selections.get(item.asOf)
      const availableEntries = item.disputed ? matching?.conflicts : matching?.current
      return availableEntries?.some(entry => entry.id === item.id && entry.revision === item.revision) ?? false
    })
  }

  function dispatchDeadline(items: readonly MemoryDependency[], sources: readonly string[], at: number) {
    const ids = new Set([...items.filter(item => !item.asOf).map(item => item.id), ...sources.flatMap(store.memoriesFrom)])
    if (!ids.size) return null
    const byId = entriesWithPeers(ids)
    let deadline = items.reduce((first, item) => Math.min(first, item.expiresAt ?? Infinity), Infinity)
    for (const id of ids) {
      const entry = byId.get(id)
      if (!entry) continue
      const disputeWindows = entry.links.flatMap(link => {
        const peer = byId.get(link.id)
        return link.kind === 'conflict' && peer ? disputeBetween(entry, peer, link.changeId)?.windows ?? [] : []
      })
      const evidenceWindows = entry.evidence.map(edge => ({ from: edge.assertedFrom, to: edge.assertedTo }))
      for (const { from, to } of [...entry.windows, ...evidenceWindows, ...disputeWindows, ...pendingRelationWindows(entry, byId)]) {
        if (from !== null && from > at) deadline = Math.min(deadline, from)
        if (to !== null && to > at) deadline = Math.min(deadline, to)
      }
    }
    return Number.isFinite(deadline) ? deadline : null
  }

  return { available, independentWindows, pendingRelationWindows, selection, recallInterval, classify, recallSelection, scopedEntries, valid, entriesWithPeers, readableSelection, dependenciesCurrent, dispatchDeadline, disputeBetween }
}
