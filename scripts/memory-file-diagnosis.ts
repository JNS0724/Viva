/** Development diagnostics only: controlled query-language and ranking ablations.
 * This does not change the frozen corpus or produce a new acceptance score. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createMemoryEmbedder } from '../src/memory/node/memory-embedder.ts'
import { openMemoryFileIndex } from '../src/memory/node/memory-file-index.ts'
import { createMemoryFileRetrieval, memoryFileChunkKey, memoryFileLexicalQuery } from '../src/memory/core/memory-file-retrieval.ts'
import { fuseMemoryFileHits, selectMemoryFileHits } from '../src/memory/core/memory-file-ranking.ts'
import { memoryFileEmbeddingPassages } from '../src/memory/core/memory-file-passages.ts'
import { evaluationDocuments, evaluationQueries } from '../test/fixtures/memory-file-evaluation.ts'
import { checkEvaluationFreeze, dataPolicy } from './memory-file-evaluation.ts'

const [modelRoot, runtimeRoot, output] = process.argv.slice(2)
if (!modelRoot || !runtimeRoot || !output) throw new Error('model, runtime and output paths required')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const workspace = hash('holdout-workspace:public')
const db = new DatabaseSync(':memory:')
const embedder = createMemoryEmbedder({ modelRoot, runtimeRoot })
const index = openMemoryFileIndex({ db })
const { policy, ids } = dataPolicy(evaluationDocuments)
const retrieval = createMemoryFileRetrieval({ index, policy, workspaces: () => [workspace], hash, embedder })
const cosine = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, n) => sum + value * b[n]!, 0)
const variants: Record<string, { latinName: string, english: string }> = {
  'cross-3': { latinName: 'Lighthouse服务能找回多少天以前的数据库快照，去哪里找？', english: 'For Lighthouse, how many days of database snapshots are retained, and where are they stored?' },
  'cross-5': { latinName: 'Orchard项目的安全豁免如果没人续签，多久就失效？', english: 'When do Orchard security exceptions expire if nobody signs a renewal?' },
  'cross-7': { latinName: 'Atlas故障的内部记录和给客户看的摘要，各自交到哪里？', english: 'For Atlas incidents, where do internal reports and customer-facing summaries each go?' },
  'cross-9': { latinName: 'Maple原型发现不好用的地方，反馈里要带哪些东西？', english: 'What should feedback on usability issues in the Maple prototype include?' },
}
try {
  const freeze = checkEvaluationFreeze()
  retrieval.sync()
  assert(await retrieval.prepareVectors())
  const files = index.files([workspace]), chunks = index.chunks(files)
  // A short-body-only corpus removes AST context, long passages and fusion. It is an
  // ablation with a different corpus, never a substitute holdout score.
  const short = evaluationDocuments.filter(doc => doc.scope === 'public' && doc.state === 'active'
    && doc.body.length <= 1100 && files.some(file => ids.get(file.id) === doc.id))
  const rawVectors: Float32Array[] = []
  for (let start = 0; start < short.length; start += 8) {
    const vectors = await embedder.embedBatch(short.slice(start, start + 8).map(doc => ({ kind: 'passage', text: doc.body })))
    assert(vectors?.every(vector => vector !== null))
    rawVectors.push(...vectors as Float32Array[])
  }
  const results = []
  for (const query of evaluationQueries.filter(q => q.kind === 'answer' && (q.group === 'cross-language' || q.id === 'zh-6' || q.id === 'tail-8'))) {
    const label = query.evidence[0]!
    const correct = chunks.filter(chunk => ids.get(chunk.file.id) === label.id && chunk.text.includes(label.quote))
    assert(correct.length)
    const tests = [{ mode: 'original', query: query.text }, ...variants[query.id] ? [
      { mode: 'latin-entity-only', query: variants[query.id]!.latinName },
      { mode: 'english-paraphrase', query: variants[query.id]!.english },
    ] : []]
    for (const variant of tests) {
      const [vector] = await embedder.embedBatch([{ kind: 'query', text: variant.query }]) ?? []
      assert(vector)
      const scores = retrieval.indexedScores(vector, files)
      const ranked = chunks.flatMap(chunk => { const score = scores.get(memoryFileChunkKey(chunk.ref)); return score === undefined ? [] : [{ ...chunk, score }] })
        .sort((a, b) => b.score - a.score || memoryFileChunkKey(a.ref).localeCompare(memoryFileChunkKey(b.ref)))
      const lexical = index.lexicalCandidates(memoryFileLexicalQuery(variant.query), { workspaces: [workspace] }, 25).rows
      const fused = fuseMemoryFileHits(lexical, ranked.slice(0, 25))
      const selected = selectMemoryFileHits(fused, { limit: 5, minScore: 0 })
      const isEvidence = (chunk: { file: {id:string}, text:string }) => ids.get(chunk.file.id) === label.id && chunk.text.includes(label.quote)
      const rank = (rows: typeof ranked) => { const n = rows.findIndex(isEvidence); return n < 0 ? null : n + 1 }
      const raw = short.map((doc, n) => ({ id: doc.id, score: cosine(vector, rawVectors[n]!) })).sort((a, b) => b.score - a.score)
      const target = correct[0]!, file = index.snapshot(workspace, target.file.id)!
      const passages = memoryFileEmbeddingPassages(target, file.name)!
      const checkVectors: Float32Array[] = []
      for (let start = 0; start < passages.length; start += 8) {
        const checked = await embedder.embedBatch(passages.slice(start, start + 8).map(p => ({ kind: 'passage', text: p.text })))
        assert(checked?.every(v => v !== null)); checkVectors.push(...checked as Float32Array[])
      }
      const independentMax = Math.max(...checkVectors.map(v => cosine(vector, v)))
      results.push({ id: query.id, mode: variant.mode, query: variant.query, target: label.id,
        vectorRank: rank(ranked), lexicalRank: rank(lexical), rrfRank: rank(fused), fusedRank: rank(selected),
        selectedTop5: selected.map(row => ({ id: ids.get(row.file.id), score: row.score, ranks: row.ranks })),
        vectorTop5: ranked.slice(0, 5).map(row => ({ id: ids.get(row.file.id), score: row.score })),
        rawShortCorpus: { count: short.length, rank: raw.findIndex(row => row.id === label.id) + 1 || null, score: raw.find(row => row.id === label.id)?.score },
        indexScore: scores.get(memoryFileChunkKey(target.ref)), independentTargetScore: independentMax,
        scoreDifference: Math.abs(scores.get(memoryFileChunkKey(target.ref))! - independentMax) })
    }
  }
  writeFileSync(output, JSON.stringify({ kind: 'development-diagnosis', freeze, fingerprint: embedder.fingerprint,
    dimensions: embedder.dimensions, corpusFiles: files.length, corpusChunks: chunks.length, results,
    limits: ['Manual paraphrases are diagnostics, not production translation or held-out quality scores.',
      'Direct and indexed comparisons use the same q8 weights; FP32 quantization effects remain unmeasured.'] }, null, 2) + '\n')
  console.log(JSON.stringify(results.map(({ id, mode, vectorRank, lexicalRank, fusedRank, rawShortCorpus, scoreDifference }) => ({ id, mode, vectorRank, lexicalRank, fusedRank, rawRank: rawShortCorpus.rank, scoreDifference }))))
} finally { retrieval.close(); embedder.close(); db.close() }
