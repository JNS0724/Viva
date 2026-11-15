import { covers } from './memory-facts.ts'
import { intersect, normalizeWindows, subtract } from './memory-intervals.ts'
import type { MemoryInterval } from './memory-intervals.ts'
import type { MemoryChange, MemoryEntry, MemoryEvidence } from './memory-store.ts'

export function connected(seeds: Iterable<number>, links: readonly MemoryChange[]) {
  const adjacent = new Map<number, Set<number>>()
  for (const { targetId, replacementId } of links) {
    if (replacementId === null) continue
    for (const [from, to] of [[targetId, replacementId], [replacementId, targetId]]) {
      const neighbours = adjacent.get(from) ?? new Set<number>()
      neighbours.add(to)
      adjacent.set(from, neighbours)
    }
  }
  const ids = new Set(seeds)
  for (const id of ids) for (const other of adjacent.get(id) ?? []) ids.add(other)
  return ids
}

type Assertion = Pick<MemoryEvidence, 'changeId' | 'assertedFrom' | 'assertedTo' | 'inheritsChangeTime'> & { text: string }
type Row = { entry: MemoryEntry, supports: Assertion[] }

export function timelinePredecessors(id: number, history: readonly MemoryChange[]) {
  const related = history.filter(change => change.kind === 'supersede' || (change.kind === 'correct' && change.sourceId !== null))
  return connected([id], related)
}

/** Replay reviewed intent from source-backed assertions, retaining the identity of each predecessor. */
export function projectTimeline(rows: readonly Row[], history: readonly MemoryChange[], applied: readonly MemoryChange[]) {
  const entries = rows.map(row => ({ ...row, ended: false, windows: normalizeWindows(row.supports
    .filter(edge => edge.changeId === null).map(edge => ({ from: edge.assertedFrom, to: edge.assertedTo }))) }))
  const byId = new Map(entries.map(row => [row.entry.id, row]))
  const corrections = applied.filter(change => change.kind === 'correct')
  const correctedWindows = (change: MemoryChange) => change.intentWindows ?? [{ from: change.intentFrom, to: change.intentTo }]
  const masks = new Map<number, MemoryInterval[]>()
  for (const change of corrections) masks.set(change.targetId, [...masks.get(change.targetId) ?? [], ...correctedWindows(change)])
  const withoutCorrections = (id: number, windows: MemoryInterval[]) =>
    (masks.get(id) ?? []).reduce((rest, mask) => rest.flatMap(window => subtract(window, mask)), windows)

  function includeReplacement(change: MemoryChange, window: MemoryInterval) {
    const row = change.replacementId && byId.get(change.replacementId)
    if (!row) return
    const supported = row.supports.filter(edge => edge.changeId === change.id).flatMap(edge => {
      const asserted = { from: edge.assertedFrom, to: edge.assertedTo }
      const overlap = !edge.inheritsChangeTime ? asserted : intersect(window, asserted)
      return overlap ? [overlap] : []
    })
    row.windows = normalizeWindows([...row.windows, ...supported])
  }

  // Keep corrected assertions present while replaying later boundaries. Mask their disputed historical
  // portions only after the boundaries that refer to their identity have taken effect.
  for (const change of corrections) for (const window of correctedWindows(change)) includeReplacement(change, window)
  const transitions = applied.filter(change => change.effectiveAt !== null && (change.kind === 'supersede' || change.kind === 'end'))
    .sort((a, b) => a.effectiveAt! - b.effectiveAt! || a.id - b.id)
  const projected = new Map<number, MemoryInterval>()
  const competing = new Map<MemoryChange, number[]>()
  const unresolvedEnds = new Set<number>()
  const unresolvedMasks = new Map<number, MemoryInterval[]>()
  for (const change of transitions) {
    const boundary = change.effectiveAt!
    const intent = { from: boundary, to: change.intentTo }
    const target = byId.get(change.targetId)
    const atBoundary = (row: typeof target) => row?.windows.find(window => covers(window.from, window.to, boundary - 1))
    let predecessor = target
    let priorWindow = atBoundary(target)
    if (!priorWindow && change.kind === 'supersede') {
      const related = timelinePredecessors(change.targetId, history)
      const alternatives = entries.filter(row => row.entry.id !== change.replacementId && related.has(row.entry.id))
      const candidates = alternatives.filter(row => {
        const window = atBoundary(row)
        return window && (window.to === null || window.to > boundary)
      })
      if (candidates.length === 1) {
        predecessor = candidates[0]
        priorWindow = atBoundary(predecessor)
      } else competing.set(change, alternatives.map(row => row.entry.id))
    }
    const effect = priorWindow && intersect(priorWindow, intent)
    if (predecessor && priorWindow) {
      if (effect) {
        predecessor.windows = predecessor.windows.flatMap(window => subtract(window, effect))
        predecessor.ended = true
        projected.set(change.id, effect)
      }
      // A correction can rename the predecessor or correct its starting date. Its own evidence remains
      // subject to a later reviewed boundary for the assertion that it corrected.
      const endedLineage = new Set([predecessor.entry.id])
      for (const oldId of endedLineage) for (const correction of corrections) {
        if (correction.targetId !== oldId || correction.replacementId === null || !correctedWindows(correction)
          .some(window => covers(window.from, window.to, boundary - 1))) continue
        const replacement = byId.get(correction.replacementId)
        if (!replacement || !replacement.supports.some(edge => edge.changeId === correction.id)) continue
        replacement.windows = replacement.windows.flatMap(window => subtract(window, intent))
        replacement.ended = true
        endedLineage.add(replacement.entry.id)
      }
    } else if (change.kind === 'end') {
      unresolvedEnds.add(change.id)
      // The original target is gone. Hold any predecessor that was carrying this reviewed
      // timeline at the boundary, while retaining later independently dated assertions.
      const lineage = timelinePredecessors(change.targetId, history)
      for (const row of entries) {
        if (!lineage.has(row.entry.id)) continue
        const window = atBoundary(row)
        const held = window && intersect(window, intent)
        if (held) unresolvedMasks.set(row.entry.id, [...unresolvedMasks.get(row.entry.id) ?? [], held])
      }
    }
    // The replacement source itself asserts the new state. A deleted prior record does not erase it.
    includeReplacement(change, effect ?? intent)
  }
  for (const row of entries) {
    row.windows = withoutCorrections(row.entry.id, row.windows)
    for (const held of unresolvedMasks.get(row.entry.id) ?? []) {
      if (!row.windows.some(window => intersect(window, held))) continue
      row.windows = row.windows.flatMap(window => subtract(window, held))
      row.ended = true
    }
  }
  return { entries, byId, projected, competing, unresolvedEnds, transitions }
}
