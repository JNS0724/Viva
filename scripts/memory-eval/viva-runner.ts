/** Production-code Viva runners for offline retrieval, scale benchmarking,
 * Chinese semantic comparison, and LongMemEval end-to-end comparison. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { createMemoryEmbedder } from '../../src/memory/node/memory-embedder.ts'
import { openMemoryFileIndex } from '../../src/memory/node/memory-file-index.ts'
import { createMemoryFileRetrieval } from '../../src/memory/core/memory-file-retrieval.ts'
import { formatMemoryDocument } from '../../src/memory/core/memory-document.ts'
import { openMemoryOwner } from '../../src/memory/node/owner.ts'
import { memoryProjectScope } from '../../src/memory/node/project-scope.ts'
import { DEEPSEEK_DEFAULT } from '../../src/backend/model-providers.ts'
import { completeMemoryModel } from '../../plugins/memory/lib/model.ts'
import { memorySource } from '../../plugins/memory/lib/source.ts'
import { evaluationDocuments, evaluationQueries, evaluationGates } from '../../test/fixtures/memory-file-evaluation.ts'
import { validationDocuments, validationQueries } from '../../test/fixtures/memory-file-validation.ts'
import type { EvaluationDocument, EvaluationQuery } from '../../test/fixtures/memory-file-evaluation.ts'
import { dataPolicy } from '../memory-file-evaluation.ts'
import type { MemorySemanticCase } from '../memory-semantic-cases.ts'
import type { MemoryDocumentView } from '../../src/memory/core/memory-document-read-policy.ts'
import type { MemoryFileSnapshot } from '../../src/memory/core/ports/file-index.ts'
import { parseMemoryMarkdown } from '../../src/memory/core/memory-markdown.ts'
import type {
  ChineseCaseSystemResult,
  LiveTelemetry,
  LmeCaseSystemResult,
  OfflineModeSummary,
  OfflineQueryResult,
  ScaleBenchmarkResult,
  ScalePointResult,
  WorkspaceStats,
} from './types.ts'
import type { SortedLmeSession } from './lme-slice.ts'
import { judgeChineseSemanticAnswer, judgeLmeAnswer } from './judge.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const evalWorkspace = (scope: EvaluationDocument['scope']) => hash(`holdout-workspace:${scope}`)

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))]!
}

function collectWorkspaceStats(rootDir: string): WorkspaceStats {
  const filesRoot = path.join(rootDir, 'memory-files')
  const filePaths: string[] = []
  let dailyFiles = 0
  let digestFiles = 0
  let sessionFiles = 0
  let totalBytes = 0
  function visit(dir: string) {
    let entries: string[]
    try { entries = readdirSync(dir).sort() } catch { return }
    for (const name of entries) {
      const full = path.join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) {
        const rel = path.relative(filesRoot, full).replaceAll('\\', '/')
        filePaths.push(rel)
        totalBytes += stat.size
        if (rel.includes('/daily/') && rel.endsWith('.md')) dailyFiles++
        else if (rel.includes('/digest/') && rel.endsWith('.md')) digestFiles++
        else if (rel.includes('/session/')) sessionFiles++
      }
    }
  }
  visit(filesRoot)
  return { dailyFiles, digestFiles, sessionFiles, totalBytes, filePaths }
}

/** Build the exact ReMe-compatible offline document bundle for an evaluation or validation dataset. */
export function buildOfflineBundle(dataset: 'evaluation' | 'validation') {
  const documents = dataset === 'validation' ? validationDocuments : evaluationDocuments
  const queries = dataset === 'validation' ? validationQueries : evaluationQueries
  // Public active docs only for ReMe, applying the same supersedes retirement rules as dataPolicy().
  const retiredIds = new Set(documents.flatMap(d => d.supersedes ? [d.supersedes.id] : []))
  const activePublicDocs = documents.filter(d => d.scope === 'public' && d.state === 'active' && !retiredIds.has(d.id))
  const remeDocuments = activePublicDocs.map(doc => ({
    id: doc.id,
    path: doc.kind === 'daily' ? `daily/${doc.day}/${doc.id}.md` : `digest/wiki/${doc.id}.md`,
    markdown: formatMemoryDocument({ metadata: { name: doc.name, description: doc.name }, body: doc.body }),
  }))
  const remeQueries = queries.map(q => ({
    id: q.id,
    text: q.text,
    ...(q.from ? { from: q.from } : {}),
    ...(q.through ? { through: q.through } : {}),
  }))
  // Node-search queries: answer queries targeting digest docs
  const digestIds = new Set(activePublicDocs.filter(d => d.kind === 'digest').map(d => d.id))
  const nodeQueries = queries
    .filter(q => q.kind === 'answer' && q.evidence.some(ev => digestIds.has(ev.id)))
    .map(q => ({ id: q.id, text: q.text, expectedIds: q.evidence.map(e => e.id) }))
  return { documents, queries, remeDocuments, remeQueries, nodeQueries }
}

export function scoreOfflineQueries(
  queries: readonly EvaluationQuery[],
  rawResults: readonly { id: string, elapsedMs: number, hits: Array<{ id: string, text: string, score: number }> }[],
  meta: {
    system: 'viva' | 'reme'
    mode: string
    dataset: 'evaluation' | 'validation'
    indexMs: number
    vectorPrepMs: number | null
    nodeHits?: Array<{ id: string, expectedIds: string[], returnedIds: string[] }>
  },
): OfflineModeSummary {
  const byId = new Map(rawResults.map(r => [r.id, r]))
  const cases: OfflineQueryResult[] = []
  const times: number[] = []
  for (const query of queries) {
    const res = byId.get(query.id) ?? { id: query.id, elapsedMs: 0, hits: [] }
    times.push(res.elapsedMs)
    const top5 = res.hits.slice(0, 5)
    // Require quote text coverage strictly; empty-text hits with matching IDs are tracked separately in docIdHit5.
    const covered = (hits: typeof top5, label: { id: string, quote: string }) =>
      hits.some(hit => hit.id === label.id && hit.text.includes(label.quote))
    const hit1 = query.evidence.some(label => covered(top5.slice(0, 1), label))
    const hit5 = query.evidence.some(label => covered(top5, label))
    const allEvidenceHit5 = query.evidence.length > 0 && query.evidence.every(label => covered(top5, label))
    let mrr5 = 0
    for (let i = 0; i < top5.length; i++) {
      if (query.evidence.some(label => covered([top5[i]!], label))) {
        mrr5 = 1 / (i + 1)
        break
      }
    }
    const safetyLeaks = (query.forbidden ?? []).filter(label => top5.some(hit => hit.id === label.id || hit.text.includes(label.quote))).length
    cases.push({
      id: query.id,
      kind: query.kind,
      group: query.group,
      text: query.text,
      hit1,
      hit5,
      allEvidenceHit5,
      mrr5,
      elapsedMs: res.elapsedMs,
      safetyLeaks,
      topIds: top5.map(h => h.id),
      topScores: top5.map(h => Number(h.score.toFixed(4))),
    })
  }
  const answers = cases.filter(c => c.kind === 'answer')
  const answerQueriesById = new Map(queries.filter(q => q.kind === 'answer').map(q => [q.id, q]))
  const docIdHit5 = answers.filter(c => {
    const q = answerQueriesById.get(c.id)
    return Boolean(q && q.evidence.some(label => c.topIds.includes(label.id)))
  }).length
  const ambiguous = cases.filter(c => c.kind === 'ambiguous')
  const absent = cases.filter(c => c.kind === 'absent')
  const groups: Record<string, { hit1: number, hit5: number, count: number }> = {}
  for (const c of answers) {
    const g = c.group ?? 'other'
    groups[g] ??= { hit1: 0, hit5: 0, count: 0 }
    groups[g]!.count++
    if (c.hit1) groups[g]!.hit1++
    if (c.hit5) groups[g]!.hit5++
  }
  const nodeSearchCount = meta.nodeHits?.length
  const nodeSearchHit1 = meta.nodeHits?.filter(n => n.returnedIds.slice(0, 1).some(id => n.expectedIds.includes(id))).length
  const nodeSearchHit5 = meta.nodeHits?.filter(n => n.returnedIds.slice(0, 5).some(id => n.expectedIds.includes(id))).length
  return {
    system: meta.system,
    mode: meta.mode,
    dataset: meta.dataset,
    indexMs: Number(meta.indexMs.toFixed(1)),
    vectorPrepMs: meta.vectorPrepMs === null ? null : Number(meta.vectorPrepMs.toFixed(1)),
    answerCount: answers.length,
    hit1: answers.filter(c => c.hit1).length,
    hit5: answers.filter(c => c.hit5).length,
    mrr5: Number((answers.reduce((s, c) => s + c.mrr5, 0) / Math.max(answers.length, 1)).toFixed(4)),
    groups,
    ambiguousAllEvidenceHit5: ambiguous.filter(c => c.allEvidenceHit5).length,
    ambiguousCount: ambiguous.length,
    absentReturnedAny: absent.filter(c => c.topIds.length > 0).length,
    absentCount: absent.length,
    safetyLeaks: cases.reduce((s, c) => s + c.safetyLeaks, 0),
    p50Ms: Number(percentile(times, 0.5).toFixed(2)),
    p95Ms: Number(percentile(times, 0.95).toFixed(2)),
    ...(nodeSearchCount !== undefined ? { nodeSearchHit1, nodeSearchHit5, nodeSearchCount } : {}),
    docIdHit5,
    cases,
  }
}

export async function runVivaOfflineEval(
  dataset: 'evaluation' | 'validation',
  opts: { mode: 'viva-bm25' | 'viva-hybrid-granite', modelRoot?: string, runtimeRoot?: string },
): Promise<OfflineModeSummary> {
  const { documents, queries, nodeQueries } = buildOfflineBundle(dataset)
  const db = new DatabaseSync(':memory:')
  const index = openMemoryFileIndex({ db })
  const embedder = opts.mode === 'viva-hybrid-granite' && opts.modelRoot && opts.runtimeRoot
    ? createMemoryEmbedder({ modelRoot: opts.modelRoot, runtimeRoot: opts.runtimeRoot })
    : null
  const { policy, ids } = dataPolicy(documents)
  const scopes = [evalWorkspace('public'), evalWorkspace('restricted')]
  const allows = (view: MemoryDocumentView) => view.workspace === evalWorkspace('public')
  const retrieval = createMemoryFileRetrieval({ index, policy, workspaces: () => scopes, hash, embedder })
  try {
    if (embedder) {
      await embedder.embedBatch([{ kind: 'query', text: 'warmup' }])
    }
    const t0 = performance.now()
    retrieval.sync()
    const indexMs = performance.now() - t0
    let vectorPrepMs = 0
    if (embedder) {
      const vt0 = performance.now()
      let ready = false
      for (let i = 0; i < 8 && !ready; i++) ready = await retrieval.prepareVectors()
      if (!ready) throw new Error('Viva prepareVectors failed to complete')
      vectorPrepMs = performance.now() - vt0
    }
    const rawResults: Array<{ id: string, elapsedMs: number, hits: Array<{ id: string, text: string, score: number }> }> = []
    for (const q of queries) {
      const qs = performance.now()
      const res = await retrieval.search({
        query: q.text,
        limit: evaluationGates.fixedLimit,
        minScore: evaluationGates.minScore,
        from: q.from,
        through: q.through,
        asOf: q.asOf,
        allows,
      })
      const elapsedMs = performance.now() - qs
      rawResults.push({
        id: q.id,
        elapsedMs,
        hits: res.hits.map(h => ({ id: ids.get(h.id) ?? h.id, text: h.text, score: h.score })),
      })
    }
    const nodeHits: Array<{ id: string, expectedIds: string[], returnedIds: string[] }> = []
    for (const nq of nodeQueries) {
      const nr = await retrieval.nodeSearchAsync({ query: nq.text, limit: 5, allows })
      nodeHits.push({
        id: nq.id,
        expectedIds: nq.expectedIds,
        returnedIds: nr.nodes.map(n => ids.get(n.id) ?? n.id),
      })
    }
    return scoreOfflineQueries(queries, rawResults, {
      system: 'viva',
      mode: opts.mode,
      dataset,
      indexMs,
      vectorPrepMs,
      nodeHits,
    })
  } finally {
    retrieval.close()
    await embedder?.close()
    db.close()
  }
}

export async function runVivaScaleBench(
  docCounts: readonly number[],
  opts: { modelRoot?: string, runtimeRoot?: string, includeHybrid: boolean },
): Promise<ScaleBenchmarkResult> {
  const embedder = opts.includeHybrid && opts.modelRoot && opts.runtimeRoot
    ? createMemoryEmbedder({ modelRoot: opts.modelRoot, runtimeRoot: opts.runtimeRoot })
    : null
  if (embedder) await embedder.embedBatch([{ kind: 'query', text: 'warmup' }])
  const points: ScalePointResult[] = []
  try {
    for (const docCount of docCounts) {
      const db = new DatabaseSync(':memory:')
      const index = openMemoryFileIndex({ db })
      const ws = hash(`scale-ws:${docCount}`)
      const views = new Map<string, MemoryDocumentView>()
      const t0 = performance.now()
      let chunkCount = 0
      for (let i = 0; i < docCount; i++) {
        const day = `2026-${String((i % 10) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`
        const isDaily = i % 3 === 0
        const docPath = isDaily ? `daily/${day}/note-${String(i).padStart(5, '0')}.md` : `digest/wiki/doc-${String(i).padStart(5, '0')}.md`
        const markdown =
          `---\nname: Topic ${i}\ndescription: Benchmark synthetic memory entry ${i} for scale testing\n---\n\n` +
          `# Entry ${i}\n\n` +
          `Project code SIGMA-${1000 + i} handles service routing on port ${8000 + (i % 500)}.\n` +
          `中文测试条目 ${i}：关于季度预算复核、接口限流策略与每周例会安排的备忘记录。\n` +
          `Owner is engineer_${i % 40} in team_${i % 12}. Approval requires checklist-${i % 25}.\n`
        const rev = hash(markdown)
        const id = `doc-${i}`
        const parsed = parseMemoryMarkdown(markdown)
        const chunks = parsed.chunks.filter(c => Boolean(c.text.trim()))
        chunkCount += chunks.length
        const snap: MemoryFileSnapshot = {
          workspace: ws,
          id,
          path: docPath,
          revision: rev,
          usageVersion: 1,
          policyToken: rev,
          kind: isDaily ? 'daily' : 'digest',
          ...(isDaily ? { day } : {}),
          updatedAt: Date.parse(`${day}T12:00:00Z`),
          sources: [{ id: `src-${i}`, token: rev }],
          name: `Topic ${i}`,
          description: `Benchmark synthetic memory entry ${i} for scale testing`,
          chunks,
        }
        index.accept(snap, null)
        views.set(docPath, {
          id,
          workspace: ws,
          kind: isDaily ? 'daily' : 'digest',
          path: docPath,
          revision: rev,
          usageVersion: 1,
          policyToken: rev,
          ...(isDaily ? { day } : {}),
          updatedAt: Date.parse(`${day}T12:00:00Z`),
          markdown,
          sources: [{ namespace: 'scale', sourceId: `src-${i}`, revision: 1 }],
          sourceTokens: [{ id: `src-${i}`, token: rev }],
          backing: null,
        })
      }
      const indexMs = performance.now() - t0
      const policy = {
        read: (_workspace: string, p: string) => views.get(p) ?? null,
        list: () => [...views.values()],
      }
      const retrieval = createMemoryFileRetrieval({ index, policy, workspaces: () => [ws], hash, embedder })
      const queries = Array.from({ length: 30 }, (_, k) =>
        k % 2 === 0
          ? `SIGMA-${1000 + ((k * Math.max(1, Math.floor(docCount / 30))) % docCount)} routing port`
          : `中文测试条目 ${(k * Math.max(1, Math.floor(docCount / 30))) % docCount} 季度预算 接口限流`,
      )
      const lexTimes: number[] = []
      for (const q of queries) {
        const qs = performance.now()
        retrieval.searchCached({ query: q, limit: 5, allows: () => true })
        lexTimes.push(performance.now() - qs)
      }
      let vectorPrepMs = 0
      let hybridTimes: number[] | null = null
      let autoTimes: number[] | null = null
      let autoTimeouts = 0
      if (embedder) {
        const vt0 = performance.now()
        let ready = false
        for (let i = 0; i < 40 && !ready; i++) ready = await retrieval.prepareVectors()
        vectorPrepMs = performance.now() - vt0
        if (ready) {
          hybridTimes = []
          autoTimes = []
          for (const q of queries) {
            const qs = performance.now()
            await retrieval.search({ query: q, limit: 5, allows: () => true })
            hybridTimes.push(performance.now() - qs)
          }
          for (const q of queries) {
            const qs = performance.now()
            const autoRes = await retrieval.search({ query: q, limit: 3, automatic: true, allows: () => true })
            autoTimes.push(performance.now() - qs)
            if (autoRes.reasons.includes('semantic-unavailable')) autoTimeouts++
          }
        }
      }
      const rssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1))
      points.push({
        docCount,
        chunkCount,
        indexMs: Number(indexMs.toFixed(1)),
        vectorPrepMs: Number(vectorPrepMs.toFixed(1)),
        lexicalP50Ms: Number(percentile(lexTimes, 0.5).toFixed(2)),
        lexicalP95Ms: Number(percentile(lexTimes, 0.95).toFixed(2)),
        lexicalP99Ms: Number(percentile(lexTimes, 0.99).toFixed(2)),
        hybridP50Ms: hybridTimes ? Number(percentile(hybridTimes, 0.5).toFixed(2)) : null,
        hybridP95Ms: hybridTimes ? Number(percentile(hybridTimes, 0.95).toFixed(2)) : null,
        hybridP99Ms: hybridTimes ? Number(percentile(hybridTimes, 0.99).toFixed(2)) : null,
        automaticP50Ms: autoTimes ? Number(percentile(autoTimes, 0.5).toFixed(2)) : null,
        automaticP95Ms: autoTimes ? Number(percentile(autoTimes, 0.95).toFixed(2)) : null,
        automaticTimeoutRate: autoTimes ? Number((autoTimeouts / autoTimes.length).toFixed(3)) : null,
        rssMb,
      })
      retrieval.close()
      db.close()
    }
    return { system: 'viva', mode: embedder ? 'viva-hybrid-granite' : 'viva-bm25', rssMetric: 'process-current-rss', points }
  } finally {
    await embedder?.close()
  }
}

/**
 * ReAct answering prompt ported from agentscope-ai/ReMe (commit 54fa338,
 * plugins/lme/src/reme_lme/agentic_answer.yaml, Apache-2.0), adapted to Viva's native
 * memory tool names (memory_recall, memory_read, memory_node_search) so answering strategy
 * and tool budget match apples-to-apples. See ./THIRD_PARTY_NOTICES.md and ../licenses/Apache-2.0.txt.
 */
const VIVA_AGENTIC_ANSWER_SYSTEM = [
  'You are a memory retrieval assistant. You MUST use the memory_recall tool to find information before answering.',
  '- Your total number of tool calls should be at most 9 times.',
  '',
  '## Search Strategy',
  '- You can call "memory_recall" multiple times (at least once) with different queries to gather comprehensive information.',
  '- Do not stop after the first relevant hit unless you are confident that the information is sufficient.',
  '- You can use "memory_node_search" to inspect digest topic titles, and "memory_read" to read specific line ranges of a memory file.',
  '- After finding a preliminary answer, continue searching from multiple angles to check for potentially conflicting, supplementary, or updated information.',
  '## Draft Tool',
  '- Use "add_draft" to save key findings during search, and "read_all_draft" to review all saved notes before answering.',
  '## Answer Rules',
  '- Answer based ONLY on retrieved memory context.',
  '- Output ONLY the direct factual answer — no reasoning, no search process, no elaboration.',
  '- Do NOT invent or assume information that is not in the memories. Do NOT extrapolate or fabricate connections from related but non-direct evidence.',
  '- If information is not found or not sufficient after multiple searches, or if the maximum iteration count is reached without finding the answer, reply: "Information not found."',
].join('\n')

const VIVA_ANSWER_TOOLS: ToolSchema[] = [
  {
    name: 'memory_recall',
    description: 'Search authorized daily/digest memory files with hybrid keyword + semantic retrieval. Supports start_date/end_date/asOf (YYYY-MM-DD), limit, deep.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        asOf: { type: 'string' },
        limit: { type: 'integer' },
        deep: { type: 'boolean' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_read',
    description: 'Read specific line ranges of a memory file by id returned from memory_recall or memory_node_search.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_node_search',
    description: 'Search digest node names and descriptions without returning document bodies.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_draft',
    description: 'Append key findings to the current draft note list.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'read_all_draft',
    description: 'Read all draft notes appended in the current question context.',
    parameters: { type: 'object', properties: {} },
  },
]

export async function runVivaAgenticAnswer(
  ctx: Pick<Context, 'llm'>,
  owner: Pick<ReturnType<typeof openMemoryOwner>, 'sessionContext' | 'runtime'>,
  readerSessionId: string,
  question: string,
  queryTimeIso: string,
  telemetry: LiveTelemetry,
  opts: { includeAutoContext?: boolean } = {},
): Promise<string> {
  const t0 = performance.now()
  const drafts: string[] = []
  const origin = owner.sessionContext(readerSessionId)
  let userText = question
  if (opts.includeAutoContext) {
    const autoCtx = await owner.runtime.handleModelRequest(
      { op: 'context', session: readerSessionId, turn: 1, question },
      origin,
      () => true,
      AbortSignal.timeout(15_000),
    )
    if (autoCtx) userText = `${autoCtx}\n\nQuestion: ${question}`
  }
  const system = queryTimeIso ? `${VIVA_AGENTIC_ANSWER_SYSTEM}\nCurrent time context: ${queryTimeIso}` : VIVA_AGENTIC_ANSWER_SYSTEM
  const messages: Message[] = [createUserMessage({ content: [{ type: 'text', text: userText }], source: memorySource })]
  const maxRounds = 10
  const maxToolCalls = 9
  let usedToolCalls = 0
  for (let round = 0; round < maxRounds; round++) {
    const canCallTools = usedToolCalls < maxToolCalls && round < maxRounds - 1
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: DEEPSEEK_DEFAULT.provider,
      model: DEEPSEEK_DEFAULT.model,
      system,
      messages,
      ...(canCallTools ? { tools: VIVA_ANSWER_TOOLS } : {}),
      maxTokens: 2048,
      signal: AbortSignal.timeout(90_000),
    })) {
      assembler.push(chunk)
    }
    const blocks = assembler.blocks()
    const calls = blocks.filter(b => b.type === 'tool-call')
    if (!calls.length || !canCallTools) {
      telemetry.answerMs += performance.now() - t0
      return blocks.flatMap(b => b.type === 'text' ? [b.text] : []).join('').trim()
    }
    messages.push(assembler.message({
      provider: DEEPSEEK_DEFAULT.provider,
      model: DEEPSEEK_DEFAULT.model,
      ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }),
    }))
    for (const call of calls) {
      if (usedToolCalls >= maxToolCalls) {
        messages.push(createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text: JSON.stringify({ status: 'budget_exhausted', message: `Tool call budget (${maxToolCalls}) reached. Provide your final answer now.` }) }],
          isError: true,
        }))
        continue
      }
      usedToolCalls++
      telemetry.toolCalls++
      telemetry.toolNames[call.name] = (telemetry.toolNames[call.name] ?? 0) + 1
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(call.arguments) as Record<string, unknown> } catch { /* empty */ }
      let content = '{"status":"rejected"}'
      if (call.name === 'add_draft') {
        drafts.push(String(args.text ?? ''))
        content = JSON.stringify({ status: 'ok', count: drafts.length })
      } else if (call.name === 'read_all_draft') {
        content = JSON.stringify({ drafts })
      } else if (call.name === 'memory_recall') {
        content = await owner.runtime.handleModelRequest(
          {
            op: 'recall',
            session: readerSessionId,
            query: String(args.query ?? ''),
            ...(typeof args.start_date === 'string' ? { start_date: args.start_date } : {}),
            ...(typeof args.end_date === 'string' ? { end_date: args.end_date } : {}),
            ...(typeof args.asOf === 'string' ? { asOf: args.asOf } : {}),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            ...(typeof args.deep === 'boolean' ? { deep: args.deep } : {}),
          },
          origin,
          () => true,
          AbortSignal.timeout(20_000),
        )
      } else if (call.name === 'memory_read') {
        content = owner.runtime.handle(
          {
            op: 'file_read',
            session: readerSessionId,
            id: String(args.id ?? ''),
            ...(typeof args.start_line === 'number' ? { start_line: args.start_line } : {}),
            ...(typeof args.end_line === 'number' ? { end_line: args.end_line } : {}),
          },
          origin,
        )
      } else if (call.name === 'memory_node_search') {
        content = await owner.runtime.handleModelRequest(
          {
            op: 'node_search',
            session: readerSessionId,
            query: String(args.query ?? ''),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          },
          origin,
          () => true,
          AbortSignal.timeout(20_000),
        )
      }
      messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: content }], isError: false }))
    }
  }
  telemetry.answerMs += performance.now() - t0
  return 'Information not found.'
}

type EvalPhase = 'ingest' | 'dream' | 'answer'

function emptyTelemetry(): LiveTelemetry {
  return {
    llmCalls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    ingestMs: 0,
    dreamMs: 0,
    answerMs: 0,
    toolCalls: 0,
    toolNames: {},
    phaseTokens: {
      ingest: { calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      dream: { calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      answer: { calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    },
  }
}

/** Intercept every real HTTP ctx.llm.stream() call to record exact call count & disjoint token usage (normalized to total prompt tokens = uncached + cacheRead). */
function createMeteringLlmCtx(
  base: Pick<Context, 'llm'>,
  telemetry: LiveTelemetry,
  getPhase: () => EvalPhase,
): Pick<Context, 'llm'> {
  const metered = Object.create(base.llm) as Context['llm']
  metered.stream = (async function* (request) {
    const phase = getPhase()
    const bucket = telemetry.phaseTokens?.[phase]
    telemetry.llmCalls++
    if (bucket) bucket.calls++
    for await (const chunk of base.llm.stream(request)) {
      if (chunk.type === 'usage') {
        const cached = chunk.usage.cacheReadTokens ?? 0
        const totalIn = chunk.usage.inputTokens + cached
        const out = chunk.usage.outputTokens
        telemetry.inputTokens += totalIn
        telemetry.cacheReadTokens = (telemetry.cacheReadTokens ?? 0) + cached
        telemetry.outputTokens += out
        if (bucket) {
          bucket.inputTokens += totalIn
          bucket.cacheReadTokens += cached
          bucket.outputTokens += out
        }
      }
      yield chunk
    }
  }) as Context['llm']['stream']
  return { llm: metered }
}

function gitFixture(directory: string) {
  mkdirSync(path.join(directory, '.git', 'objects'), { recursive: true })
  writeFileSync(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/eval-project\n')
}

export function checkPatterns(text: string, patterns: { allOf: readonly string[], anyOf?: readonly string[], noneOf?: readonly string[] }): boolean {
  const allOk = patterns.allOf.every(p => new RegExp(p, 'iu').test(text))
  const anyOk = !patterns.anyOf?.length || patterns.anyOf.some(p => new RegExp(p, 'iu').test(text))
  const noneOk = !patterns.noneOf?.length || patterns.noneOf.every(p => !new RegExp(p, 'iu').test(text))
  return allOk && anyOk && noneOk
}

/** Build a safe subdirectory strictly inside workDir even for untrusted IDs containing `..` or path separators. */
export function safeWorkSubdir(workDir: string, id: string): string {
  const base = path.resolve(workDir)
  const prefix = id.replaceAll(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 40) || 'item'
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 12)
  const target = path.resolve(base, `${prefix}-${digest}`)
  if (!target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Refusing unsafe work directory outside root: ${id}`)
  }
  return target
}

/** Wait for pending memory.note / memory.dream retries (e.g. transient API/JSON retry with 1-4s backoff); throws if jobs remain unfinished. */
async function drainVivaJobs(
  owner: ReturnType<typeof openMemoryOwner>,
  dbPath: string,
  kinds: readonly string[],
  maxPasses = 4,
  now: () => number = Date.now,
) {
  const inspectPending = (): Array<{ kind: string, due_at: number, attempts: number }> => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare(`SELECT kind, due_at, attempts FROM effects WHERE kind IN (${kinds.map(() => '?').join(',')})`).all(...kinds) as Array<{ kind: string, due_at: number, attempts: number }>
      const horizon = now() + 15_000
      return rows.filter(row => row.attempts > 0 || row.due_at <= horizon)
    } finally { db.close() }
  }
  await owner.runtime.wake()
  for (let pass = 0; pass < maxPasses; pass++) {
    const pending = inspectPending()
    if (!pending.length) return
    const nextDue = Math.min(...pending.map(row => row.due_at))
    const waitMs = Math.max(0, Math.min(15_000, nextDue - now() + 100))
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
    await owner.runtime.wake()
  }
  const remaining = inspectPending()
  if (remaining.length) {
    const summary = remaining.map(row => `${row.kind}(attempts=${row.attempts})`).join(', ')
    throw new Error(`Viva background jobs still pending/retrying after ${maxPasses} drain passes: ${summary}`)
  }
}

/** Ensure Viva background vector index is active AND covers every currently published chunk before QA begins; throws on failure/timeout. */
async function ensureVivaVectorsReady(
  owner: ReturnType<typeof openMemoryOwner>,
  readerSessionId: string,
  dbPath: string,
  maxWaitMs = 60_000,
) {
  const origin = owner.sessionContext(readerSessionId)
  const inspectVectorCoverage = (): { chunkCount: number, active: boolean, missingChunks: number } => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const metaRow = db.prepare("SELECT value FROM memory_file_index_meta WHERE key = 'vectors'").get() as { value?: string } | undefined
      const state = metaRow?.value ? JSON.parse(metaRow.value) as { active?: boolean, generation?: number } : { active: false, generation: 0 }
      const chunkRows = db.prepare('SELECT payload FROM memory_file_index_chunks').all() as Array<{ payload: string }>
      if (!chunkRows.length) return { chunkCount: 0, active: Boolean(state.active), missingChunks: 0 }
      const generation = state.generation ?? 0
      const coveredRefs = new Set(
        (db.prepare('SELECT DISTINCT ref FROM memory_file_index_vectors WHERE generation = ?').all(generation) as Array<{ ref: string }>)
          .map(row => row.ref),
      )
      let missingChunks = 0
      for (const row of chunkRows) {
        const ref = (JSON.parse(row.payload) as { ref: { workspace: string, fileId: string, ordinal: number, revision: string, usageVersion: number, policyToken: string } }).ref
        const refKey = JSON.stringify([ref.workspace, ref.fileId, ref.ordinal, ref.revision, ref.usageVersion, ref.policyToken])
        if (!coveredRefs.has(refKey)) missingChunks++
      }
      return { chunkCount: chunkRows.length, active: Boolean(state.active), missingChunks }
    } finally { db.close() }
  }
  await owner.runtime.wake()
  const deadline = performance.now() + maxWaitMs
  let lastReasons: string[] = []
  let lastCoverage = { chunkCount: 0, active: false, missingChunks: 0 }
  while (performance.now() < deadline) {
    lastCoverage = inspectVectorCoverage()
    const raw = await owner.runtime.handleModelRequest(
      { op: 'recall', session: readerSessionId, query: 'warmup check', limit: 1 },
      origin,
      () => true,
      AbortSignal.timeout(15_000),
    )
    const parsed = JSON.parse(raw) as { status?: string, reasons?: string[] }
    const reasons = parsed.reasons ?? []
    lastReasons = reasons
    const fatal = reasons.filter(r => r.startsWith('semantic-') && r !== 'semantic-index-incomplete')
    if (fatal.length) {
      throw new Error(`Viva vector index preparation failed: ${fatal.join(', ')}`)
    }
    if (parsed.status === 'unavailable') {
      throw new Error(`Viva retrieval unavailable during vector warmup: ${reasons.join(', ') || 'unavailable'}`)
    }
    const coverageAfter = inspectVectorCoverage()
    lastCoverage = coverageAfter
    if (
      !reasons.includes('semantic-index-incomplete')
      && (coverageAfter.chunkCount === 0 || (coverageAfter.active && coverageAfter.missingChunks === 0))
    ) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(
    `Viva vector index not ready within ${maxWaitMs}ms (active=${lastCoverage.active}, missingChunks=${lastCoverage.missingChunks}/${lastCoverage.chunkCount}, reasons=${lastReasons.join(', ') || 'timeout'})`,
  )
}

export async function runVivaChineseEval(
  ctx: Pick<Context, 'llm'>,
  cases: readonly MemorySemanticCase[],
  opts: { workDir: string, modelRoot?: string, runtimeRoot?: string, modeLabel: string, includeAutoContext?: boolean },
): Promise<ChineseCaseSystemResult[]> {
  const results: ChineseCaseSystemResult[] = []
  for (const fixture of cases) {
    const dir = safeWorkSubdir(opts.workDir, fixture.id)
    rmSync(dir, { recursive: true, force: true })
    const projectDir = path.join(dir, 'project')
    mkdirSync(projectDir, { recursive: true })
    if (fixture.scope.kind === 'project') gitFixture(projectDir)
    const project = memoryProjectScope(projectDir)
    const telemetry = emptyTelemetry()
    let activePhase: EvalPhase = 'ingest'
    const meteredCtx = createMeteringLlmCtx(ctx, telemetry, () => activePhase)
    // Use a controlled phase clock so Dream scans each simulated 2026-11 phase day regardless of host wall-clock date.
    let simOffsetMs = Date.parse('2026-11-10T23:30:00Z') - Date.now()
    const simNow = () => Date.now() + simOffsetMs
    const owner = openMemoryOwner({
      root: path.join(dir, 'memory'),
      now: simNow,
      dailyNotes: { noteInterval: 5, timezone: 'UTC', scanDays: 3650, dreamUnits: 5 },
      ...(opts.modelRoot && opts.runtimeRoot ? { embedding: { modelRoot: opts.modelRoot, runtimeRoot: opts.runtimeRoot } } : {}),
      route: () => ({ ...DEEPSEEK_DEFAULT }),

      async compute(job, signal, tools) {
        return completeMemoryModel(meteredCtx, job, AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]), tools)
      },
    })
    const phases: ChineseCaseSystemResult['phases'] = []
    let caseError: string | undefined
    try {
      await owner.recover()
      const sessionId = randomUUID()
      owner.bindIntakeSession(sessionId, projectDir)
      let turn = 0
      for (let pIdx = 0; pIdx < fixture.phases.length; pIdx++) {
        const phase = fixture.phases[pIdx]!
        const baseMs = Date.parse(`2026-11-${String(10 + pIdx).padStart(2, '0')}T10:00:00Z`)
        simOffsetMs = Date.parse(`2026-11-${String(10 + pIdx).padStart(2, '0')}T23:30:00Z`) - Date.now()
        activePhase = 'ingest'
        const tIng = performance.now()
        for (let tIdx = 0; tIdx < phase.turns.length; tIdx++) {
          const pair = phase.turns[tIdx]!
          const at = baseMs + tIdx * 300_000
          turn++
          const receipt = await owner.receiveSource({
            sessionId,
            messageId: randomUUID(),
            text: pair.user,
            at,
            timezone: 'UTC',
            turn,
            cwd: projectDir,
          })
          await owner.completeTurn({
            sessionId,
            turn,
            eventSeq: turn * 2 + 1,
            sourceIds: [receipt.sourceId],
            assistant: pair.assistant,
            completed: true,
            at,
            timezone: 'UTC',
          })
        }
        owner.runtime.flushNoteTurns?.(sessionId)
        await drainVivaJobs(owner, path.join(dir, 'memory', 'memory.db'), ['memory.note'], 4, simNow)
        telemetry.ingestMs += performance.now() - tIng

        activePhase = 'dream'
        const tDr = performance.now()
        await owner.runtime.runDocumentDream()
        await drainVivaJobs(owner, path.join(dir, 'memory', 'memory.db'), ['memory.dream'], 4, simNow)
        telemetry.dreamMs += performance.now() - tDr

        const reader = randomUUID()
        owner.bindIntakeSession(reader, projectDir)
        if (opts.modelRoot) await ensureVivaVectorsReady(owner, reader, path.join(dir, 'memory', 'memory.db'))
        const recallRaw = await owner.runtime.handleModelRequest(
          { op: 'recall', session: reader, query: phase.recallQuery, limit: 5 },
          owner.sessionContext(reader),
          () => true,
          AbortSignal.timeout(15_000),
        )
        const recallParsed = JSON.parse(recallRaw) as { notes?: unknown[] }
        activePhase = 'answer'
        const answer = await runVivaAgenticAnswer(
          meteredCtx,
          owner,
          reader,
          phase.recallQuery,
          `2026-11-${String(10 + pIdx).padStart(2, '0')}T23:30:00`,
          telemetry,
          { includeAutoContext: opts.includeAutoContext ?? true },
        )

        let isolationLeaks: number | undefined
        if (project) {
          isolationLeaks = 0
          const foreignDir = path.join(dir, 'foreign-project')
          gitFixture(foreignDir)
          const foreign = randomUUID()
          owner.bindIntakeSession(foreign, foreignDir)
          const fRes = JSON.parse(await owner.runtime.handleModelRequest(
            { op: 'recall', session: foreign, query: phase.recallQuery, limit: 5 },
            owner.sessionContext(foreign),
            () => true,
            AbortSignal.timeout(15_000),
          )) as { notes?: unknown[] }
          isolationLeaks += fRes.notes?.length ?? 0
          const userOnly = randomUUID()
          owner.bindIntakeSession(userOnly, null)
          const uRes = JSON.parse(await owner.runtime.handleModelRequest(
            { op: 'recall', session: userOnly, query: phase.recallQuery, limit: 5 },
            owner.sessionContext(userOnly),
            () => true,
            AbortSignal.timeout(15_000),
          )) as { notes?: unknown[] }
          isolationLeaks += uRes.notes?.length ?? 0
        }

        const required = phase.expectations.filter(e => e.disposition === 'required')
        const patternHits = required.filter(e => checkPatterns(answer, e.claimPatterns)).length
        const forbiddenHits = phase.forbidden.filter(f => checkPatterns(answer, f.claimPatterns)).length
        const judge = await judgeChineseSemanticAnswer(ctx, {
          question: phase.recallQuery,
          requiredSemantics: required.map(e => e.semantic),
          forbiddenSemantics: phase.forbidden.map(f => f.semantic),
          answer,
        })
        phases.push({
          phaseId: phase.id,
          recallQuery: phase.recallQuery,
          recallSnippetCount: recallParsed.notes?.length ?? 0,
          answer,
          judgeVerdict: judge.verdict,
          judgeReason: judge.reason,
          patternHits,
          patternTotal: required.length,
          forbiddenHits,
          ...(isolationLeaks !== undefined ? { isolationLeaks } : {}),
        })
      }
    } catch (error) {
      caseError = error instanceof Error ? error.message : String(error)
    } finally {
      await owner.close()
    }
    const workspace = collectWorkspaceStats(path.join(dir, 'memory'))
    results.push({
      system: 'viva',
      mode: opts.modeLabel,
      caseId: fixture.id,
      category: fixture.category,
      phases,
      workspace,
      telemetry,
      ...(caseError ? { error: caseError } : {}),
    })
  }
  return results
}

export interface PreparedLmeTask {
  questionId: string
  questionType: string
  isAbstention: boolean
  evidenceTruncated?: boolean
  question: string
  groundTruth: string
  queryTimeIso: string
  sessions: SortedLmeSession[]
}

export async function runVivaLmeEval(
  ctx: Pick<Context, 'llm'>,
  tasks: readonly PreparedLmeTask[],
  opts: {
    workDir: string
    modelRoot?: string
    runtimeRoot?: string
    modeLabel: string
    enableDream: boolean
    includeAutoContext: boolean
    concurrency: number
  },
): Promise<LmeCaseSystemResult[]> {
  const results: LmeCaseSystemResult[] = new Array(tasks.length)
  let cursor = 0

  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++
      const task = tasks[idx]!
      process.stderr.write(`[viva-lme] (${idx + 1}/${tasks.length}) starting ${task.questionId} (${task.questionType}, ${task.sessions.length} sessions)\n`)
      const dir = safeWorkSubdir(opts.workDir, task.questionId)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const telemetry = emptyTelemetry()
      let activePhase: EvalPhase = 'ingest'
      const meteredCtx = createMeteringLlmCtx(ctx, telemetry, () => activePhase)
      // Inject a controlled replay clock so Dream and note jobs always align with session timestamps regardless of host date.
      const firstSessionMs = task.sessions[0]?.timestampMs ?? Date.now()
      let simOffsetMs = firstSessionMs - Date.now()
      const simNow = () => Date.now() + simOffsetMs
      const owner = openMemoryOwner({
        root: path.join(dir, 'memory'),
        now: simNow,
        dailyNotes: { noteInterval: 5, timezone: 'UTC', scanDays: 3650, dreamUnits: 5 },
        ...(opts.modelRoot && opts.runtimeRoot ? { embedding: { modelRoot: opts.modelRoot, runtimeRoot: opts.runtimeRoot } } : {}),
        route: () => ({ ...DEEPSEEK_DEFAULT }),

        async compute(job, signal, tools) {
          return completeMemoryModel(meteredCtx, job, AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]), tools)
        },
      })
      let sessionsIngested = 0
      let dreamTriggers = 0
      let answer = ''
      let err: string | undefined
      try {
        await owner.recover()
        let prevDate: string | null = null
        let daysSinceDream = 0
        const dreamedDates = new Set<string>()
        for (const sess of task.sessions) {
          if (prevDate !== null && prevDate !== sess.dateStr) {
            daysSinceDream++
            if (opts.enableDream && daysSinceDream >= 4 && !dreamedDates.has(prevDate)) {
              simOffsetMs = Date.parse(`${prevDate}T23:30:00Z`) - Date.now()
              activePhase = 'dream'
              const tDr = performance.now()
              await owner.runtime.runDocumentDream()
              await drainVivaJobs(owner, path.join(dir, 'memory', 'memory.db'), ['memory.dream'], 2, simNow)
              telemetry.dreamMs += performance.now() - tDr
              dreamedDates.add(prevDate)
              daysSinceDream = 0
              dreamTriggers++
            }
          }
          simOffsetMs = (sess.timestampMs + Math.max(1, sess.messages.length) * 1000) - Date.now()
          const sessionId = sess.sessionId || randomUUID()
          owner.bindIntakeSession(sessionId, null)
          activePhase = 'ingest'
          const tIng = performance.now()
          let turn = 0
          for (let i = 0; i < sess.messages.length; i++) {
            const msg = sess.messages[i]!
            if (msg.role !== 'user') continue
            const nextMsg = sess.messages[i + 1]
            const assistantText = nextMsg?.role === 'assistant' ? nextMsg.content : ''
            if (nextMsg?.role === 'assistant') i++
            turn++
            const at = sess.timestampMs + turn * 1000
            const receipt = await owner.receiveSource({
              sessionId,
              messageId: randomUUID(),
              text: msg.content,
              at,
              timezone: 'UTC',
              turn,
              cwd: null,
            })
            await owner.completeTurn({
              sessionId,
              turn,
              eventSeq: turn * 2 + 1,
              sourceIds: [receipt.sourceId],
              assistant: assistantText,
              completed: true,
              at,
              timezone: 'UTC',
            })
          }
          owner.runtime.flushNoteTurns?.(sessionId)
          await drainVivaJobs(owner, path.join(dir, 'memory', 'memory.db'), ['memory.note'], 2, simNow)
          telemetry.ingestMs += performance.now() - tIng
          sessionsIngested++
          prevDate = sess.dateStr
        }
        if (opts.enableDream && prevDate !== null && !dreamedDates.has(prevDate)) {
          simOffsetMs = Date.parse(`${prevDate}T23:30:00Z`) - Date.now()
          activePhase = 'dream'
          const tDr = performance.now()
          await owner.runtime.runDocumentDream()
          await drainVivaJobs(owner, path.join(dir, 'memory', 'memory.db'), ['memory.dream'], 2, simNow)
          telemetry.dreamMs += performance.now() - tDr
          dreamedDates.add(prevDate)
          dreamTriggers++
        }

        if (task.queryTimeIso) {
          const parsedQueryMs = Date.parse(`${task.queryTimeIso}Z`)
          if (Number.isFinite(parsedQueryMs)) simOffsetMs = parsedQueryMs - Date.now()
        }
        const reader = randomUUID()
        owner.bindIntakeSession(reader, null)
        if (opts.modelRoot) await ensureVivaVectorsReady(owner, reader, path.join(dir, 'memory', 'memory.db'))
        activePhase = 'answer'
        answer = await runVivaAgenticAnswer(
          meteredCtx,
          owner,
          reader,
          task.question,
          task.queryTimeIso,
          telemetry,
          { includeAutoContext: opts.includeAutoContext },
        )
      } catch (error) {
        err = error instanceof Error ? error.message : String(error)
      } finally {
        await owner.close()
      }

      const judge = err
        ? { verdict: 'error' as const, reason: err }
        : await judgeLmeAnswer(ctx, {
            question: task.question,
            groundTruth: task.groundTruth,
            answer,
            questionType: task.questionType,
            isAbstention: task.isAbstention,
          })
      const workspace = collectWorkspaceStats(path.join(dir, 'memory'))
      results[idx] = {
        system: 'viva',
        mode: opts.modeLabel,
        questionId: task.questionId,
        questionType: task.questionType,
        isAbstention: task.isAbstention,
        question: task.question,
        groundTruth: task.groundTruth,
        answer,
        verdict: judge.verdict,
        judgeReason: judge.reason,
        sessionsIngested,
        dreamTriggers,
        ...(task.evidenceTruncated ? { evidenceTruncated: true } : {}),
        workspace,
        telemetry,
        ...(err ? { error: err } : {}),
      }
      process.stderr.write(`[viva-lme] (${idx + 1}/${tasks.length}) done ${task.questionId} verdict=${judge.verdict}\n`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, tasks.length) }, () => worker()))
  return results
}
