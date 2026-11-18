import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import type { MemoryFileChunkRef, MemoryFileHit } from './ports/file-index.ts'
import { lexicalTerms, memoryIdentifierTokens, memoryRelevanceTerms } from './search-tokens.ts'

export const memoryFileChunkKey = (ref: MemoryFileChunkRef) => JSON.stringify([ref.workspace, ref.fileId, ref.ordinal, ref.revision, ref.usageVersion, ref.policyToken])
export interface RankedMemoryFileHit extends MemoryFileHit {
  /** One-based positions in the deduplicated candidate lanes; never model confidence. */
  ranks: { lexical?: number, vector?: number }
}

/** Gate each lane on its original evidence. Reciprocal ranks alone always give the first hit a positive score. */
export function relevantMemoryFileLanes(query: string, lexical: readonly MemoryFileHit[], vector: readonly MemoryFileHit[]) {
  const terms = memoryRelevanceTerms(query)
  const identifiers = memoryIdentifierTokens(query)
  const queryLength = terms.reduce((length, term) => length + term.length, 0)
  const required = Math.max(2, Math.ceil(terms.length * defaults.searchMinTermCoverage))
  const matches = (hit: MemoryFileHit) => {
    const indexed = lexicalTerms(hit.searchText, true)
    if (identifiers.some(identifier => indexed.has(identifier))) return true
    const text = hit.searchText.normalize('NFKC')
    let count = 0
    for (const term of terms) {
      if (!indexed.has(term) && !(/^\p{Script=Han}+$/u.test(term) && text.includes(term))) continue
      // One exact word can carry most of a short query (e.g. “where … conference … held”).
      if (term.length > queryLength / 2) return true
      count++
    }
    return count >= required
  }
  // A fixed reference rank within even the smallest candidate pool keeps the gate
  // independent of the requested output limit. Small pools use only the absolute cutoff.
  const fifthCosine = vector[4]?.score
  const semantic = vector.filter(hit => hit.score >= defaults.searchMinCosine
    || (fifthCosine !== undefined && hit.score >= defaults.searchContrastMinCosine && hit.score - fifthCosine >= defaults.searchCosineMargin))
  return { lexical: lexical.filter(matches), vector: semantic }
}

/** Fixed weighted reciprocal ranks, including when only one lane is available. */
export function fuseMemoryFileHits(lexical: readonly MemoryFileHit[], vector: readonly MemoryFileHit[]): RankedMemoryFileHit[] {
  const scores = new Map<string, RankedMemoryFileHit>()
  for (const [lane, rows, weight] of [['vector', vector, defaults.vectorWeight], ['lexical', lexical, 1 - defaults.vectorWeight]] as const) {
    const seen = new Set<string>()
    for (const hit of rows) {
      const key = memoryFileChunkKey(hit.ref)
      if (seen.has(key)) continue
      seen.add(key)
      const rank = seen.size, previous = scores.get(key)
      scores.set(key, { ...(previous ?? hit), score: (previous?.score ?? 0) + weight / (defaults.reciprocalRankK + rank),
        ranks: { ...previous?.ranks, [lane]: rank } })
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || memoryFileChunkKey(a.ref).localeCompare(memoryFileChunkKey(b.ref)))
}

/** Cover surviving lane leaders, then distinct files, before spending remaining slots on extra chunks. */
export function selectMemoryFileHits(ranked: readonly RankedMemoryFileHit[], { limit, minScore = 0, seen }: {
  limit: number, minScore?: number, seen?: ReadonlySet<string>
}): RankedMemoryFileHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(minScore) || minScore < 0) throw new Error('Invalid memory file selection')
  const remaining = ranked.filter(hit => hit.score >= minScore && !seen?.has(memoryFileChunkKey(hit.ref)))
  if (limit === 1) return remaining.slice(0, 1)
  const anchors = new Set<string>()
  for (const lane of ['lexical', 'vector'] as const) {
    let first: RankedMemoryFileHit | undefined
    for (const hit of remaining) {
      if (hit.ranks[lane] !== undefined && (!first || hit.ranks[lane]! < first.ranks[lane]!)) first = hit
    }
    if (first) anchors.add(memoryFileChunkKey(first.ref))
  }
  const selected: RankedMemoryFileHit[] = []
  const chunks = new Set<string>(), files = new Set<string>()
  const fileKey = (hit: RankedMemoryFileHit) => JSON.stringify([hit.ref.workspace, hit.ref.fileId])
  const take = (hit: RankedMemoryFileHit) => {
    const key = memoryFileChunkKey(hit.ref)
    if (selected.length >= limit || chunks.has(key)) return
    selected.push(hit); chunks.add(key); files.add(fileKey(hit))
  }
  for (const hit of remaining) if (anchors.has(memoryFileChunkKey(hit.ref))) take(hit)
  for (const hit of remaining) if (!files.has(fileKey(hit))) take(hit)
  for (const hit of remaining) take(hit)
  return selected
}
