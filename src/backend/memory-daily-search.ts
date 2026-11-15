import { DAILY_MEMORY_DEFAULTS as defaults } from '../shared/memory-daily-defaults.ts'
import { MEMORY_EMBEDDING_BATCH, MEMORY_EMBEDDING_MAX_CHARS } from './memory-embedder.ts'
import type { MemoryEmbedder } from './memory-embedder.ts'
import { memorySearchTokens } from './memory-index.ts'
import { memoryHash } from './memory-store.ts'

export type SearchChunk = { text: string, startLine: number, endLine: number }
export type DailySearchDocument = { key: string, text: string, keywords?: readonly string[] }

export function dailySearchLimit(limit: number = defaults.searchLimit) {
  return Math.min(defaults.searchMaxLimit, Math.max(1, limit))
}

export function markdownSearchChunks(markdown: string): SearchChunk[] {
  const lines = markdown.split('\n')
  const chunks: SearchChunk[] = []
  let start = 0, bytes = 0, boundary = 0
  const size = (line: string) => Buffer.byteLength(line) + 1
  const flush = (end: number) => {
    const text = lines.slice(start, end).join('\n')
    if (text.trim()) chunks.push({ text, startLine: start + 1, endLine: end })
    bytes = 0
    start = end
    boundary = end
  }
  for (const [index, line] of lines.entries()) {
    if (/^#{1,6}\s/u.test(line) && index > start) boundary = index
    const length = size(line)
    if (bytes + length > defaults.markdownChunkBytes && index > start) {
      const end = boundary > start ? boundary : index
      flush(end)
      for (let j = end; j < index; j++) bytes += size(lines[j]!)
      if (bytes + length > defaults.markdownChunkBytes && index > start) flush(index)
    }
    bytes += length
    if (!line.trim()) boundary = index + 1
  }
  flush(lines.length)
  return chunks
}

type Ranked<T> = { document: T, score: number, semantic?: boolean }

export function rankDailyMemory<T extends DailySearchDocument>(documents: readonly T[], query: string,
  limit: number, minScore: number, semanticScores: ReadonlyMap<string, number> = new Map()) {
  const terms = new Set(memorySearchTokens(query, false))
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

/** The local encoder's maximum only controls passage boundaries. Continue through the whole chunk. */
function* embeddingPassages(text: string, width = MEMORY_EMBEDDING_MAX_CHARS) {
  let index = 0
  while (index < text.length) {
    let end = Math.min(index + width, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--
    const passage = text.slice(index, end).trim()
    if (passage) yield passage
    index = end
  }
}

function cosine(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return 0
  let dot = 0
  for (const [index, value] of a.entries()) dot += value * b[index]!
  return Math.max(-1, Math.min(1, dot))
}

export function createDailySemanticSearch(embedder: MemoryEmbedder) {
  const cache = new Map<string, { hash: string, vectors: Float32Array[] }>()

  async function rank(documents: readonly DailySearchDocument[], query: string, signal: AbortSignal, {
    scores = new Map<string, number>(), indexed,
  }: { scores?: Map<string, number>, indexed?: (query: Float32Array) => ReadonlyMap<string, number> } = {}) {
    const incomplete = () => ({ scores, incomplete: true })
    const [queryVector] = await embedder.embedBatch([{ kind: 'query', text: query }], signal) ?? []
    if (!queryVector || signal.aborted) return incomplete()
    const indexedScores = indexed?.(queryVector)
    type Missing = { key: string, hash: string, passages: string[], vectors: Float32Array[], outstanding: number }
    const missing: Missing[] = []
    function score(key: string, vectors: Float32Array[]) {
      if (vectors.length) scores.set(key, vectors.reduce((best, vector) => Math.max(best, cosine(queryVector!, vector)), -1))
    }
    for (const doc of documents) {
      const stored = indexedScores?.get(doc.key)
      if (stored !== undefined) {
        scores.set(doc.key, stored)
        continue
      }
      const hash = memoryHash(doc.text)
      const saved = cache.get(doc.key)
      if (saved?.hash === hash) score(doc.key, saved.vectors)
      else {
        const passages = [...embeddingPassages(doc.text)]
        if (passages.length) missing.push({ key: doc.key, hash, passages, vectors: [], outstanding: passages.length })
      }
    }
    const passages = missing.flatMap(item => item.passages.map(text => ({ item, text })))
    for (let index = 0; index < passages.length; index += MEMORY_EMBEDDING_BATCH) {
      if (signal.aborted) return incomplete()
      const batch = passages.slice(index, index + MEMORY_EMBEDDING_BATCH)
      const output = await embedder.embedBatch(batch.map(({ text }) => ({ kind: 'passage', text })), signal)
      if (signal.aborted || !output || output.length !== batch.length) return incomplete()
      for (const [position, vector] of output.entries()) {
        const { item, text } = batch[position]!
        if (vector) item.vectors.push(vector)
        else {
          // The tokenizer can still overflow on dense text. Retry smaller pieces.
          for (const part of embeddingPassages(text, 256)) {
            const [smaller] = await embedder.embedBatch([{ kind: 'passage', text: part }], signal) ?? []
            if (!smaller || signal.aborted) return incomplete()
            item.vectors.push(smaller)
          }
        }
        if (--item.outstanding === 0) {
          cache.set(item.key, { hash: item.hash, vectors: item.vectors })
          score(item.key, item.vectors)
        }
      }
    }
    return { scores, incomplete: false }
  }
  return { rank, clear: () => cache.clear() }
}
