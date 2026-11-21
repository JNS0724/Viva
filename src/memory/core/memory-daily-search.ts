import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { memoryFileLexicalQuery, memorySearchTokens } from './search-tokens.ts'

export type DailySearchDocument = { key: string, text: string, keywords?: readonly string[] }

export function dailySearchLimit(limit: number = defaults.searchLimit) {
  return Math.min(defaults.searchMaxLimit, Math.max(1, limit))
}

type Ranked<T> = { document: T, score: number, semantic?: boolean }

export function rankDailyMemory<T extends DailySearchDocument>(documents: readonly T[], query: string,
  limit: number, minScore: number, semanticScores: ReadonlyMap<string, number> = new Map()) {
  const terms = new Set(memorySearchTokens(memoryFileLexicalQuery(query), false))
  const frequencies = new Map<string, number>()
  const corpus = documents.map(document => {
    const tokens = memorySearchTokens([document.text, ...document.keywords ?? []].join(' '), true)
    const counts = new Map<string, number>()
    for (const term of tokens) if (terms.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1)
    for (const term of counts.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    return { document, length: tokens.length, counts }
  })
  const avg = corpus.reduce((sum, row) => sum + row.length, 0) / (corpus.length || 1) || 1
  const k1 = 1.5, b = 0.75
  const candidates = Math.min(defaults.searchMaxCandidates, limit * defaults.searchCandidateMultiplier)
  const byScore = (a: Ranked<T>, b: Ranked<T>) => b.score - a.score
  const keyword: Ranked<T>[] = corpus.flatMap(({ document, length, counts }) => {
    let score = 0
    for (const [term, count] of counts) {
      const df = frequencies.get(term)!
      const idf = Math.log1p((corpus.length - df + 0.5) / (df + 0.5))
      score += idf * count * (k1 + 1) / (count + k1 * (1 - b + b * length / avg))
    }
    return score > 0 ? [{ document, score }] : []
  }).sort(byScore).slice(0, candidates)
  const vector: Ranked<T>[] = documents.flatMap(document => {
    const score = semanticScores.get(document.key)
    return score === undefined ? [] : [{ document, score, semantic: true }]
  }).sort(byScore).slice(0, candidates)
  let ranked: Ranked<T>[]
  if (!keyword.length || !vector.length) ranked = keyword.length ? keyword : vector
  else {
    const fused = new Map<string, Ranked<T>>()
    function merge(rows: Ranked<T>[], weight: number) {
      for (const [rank, row] of rows.entries()) {
        const existing = fused.get(row.document.key)
        const score = weight / (defaults.reciprocalRankK + rank + 1)
        fused.set(row.document.key, { ...row, score: score + (existing?.score ?? 0) })
      }
    }
    merge(vector, defaults.vectorWeight)
    merge(keyword, 1 - defaults.vectorWeight)
    ranked = [...fused.values()].sort(byScore)
  }
  const matching = minScore > 0 ? ranked.filter(row => row.score >= minScore) : ranked
  return { hits: matching.slice(0, limit), partial: matching.length > limit }
}
