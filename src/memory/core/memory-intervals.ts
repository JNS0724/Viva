import type { MemoryInterval } from '../contracts/facts.ts'
export type { MemoryInterval } from '../contracts/facts.ts'

const lower = (value: number | null) => value ?? -Infinity
const upper = (value: number | null) => value ?? Infinity

export function intersect(a: MemoryInterval, b: MemoryInterval): MemoryInterval | null {
  const from = lower(a.from) >= lower(b.from) ? a.from : b.from
  const to = upper(a.to) <= upper(b.to) ? a.to : b.to
  return lower(from) < upper(to) ? { from, to } : null
}

export function subtract(interval: MemoryInterval, removal: MemoryInterval): MemoryInterval[] {
  const removed = intersect(interval, removal)
  if (!removed) return [interval]
  const result: MemoryInterval[] = []
  if (lower(interval.from) < lower(removed.from)) result.push({ from: interval.from, to: removed.from })
  if (upper(removed.to) < upper(interval.to)) result.push({ from: removed.to, to: interval.to })
  return result
}

export function normalizeWindows(windows: readonly MemoryInterval[]): MemoryInterval[] {
  const sorted = windows.filter(window => lower(window.from) < upper(window.to))
    .sort((a, b) => lower(a.from) - lower(b.from))
  const result: MemoryInterval[] = []
  for (const window of sorted) {
    const last = result.at(-1)
    if (last && lower(window.from) <= upper(last.to)) {
      if (upper(window.to) > upper(last.to)) last.to = window.to
    } else result.push({ ...window })
  }
  return result
}

export function overlapWindows(first: readonly MemoryInterval[], second: readonly MemoryInterval[], edge: MemoryInterval): MemoryInterval[] {
  return normalizeWindows(first.flatMap(left => second.flatMap(right => {
    const overlap = intersect(left, right)
    const clipped = overlap && intersect(overlap, edge)
    return clipped ? [clipped] : []
  })))
}

export function sameWindows(first: readonly MemoryInterval[], second: readonly MemoryInterval[]): boolean {
  return first.length === second.length && first.every((window, index) => window.from === second[index].from && window.to === second[index].to)
}
