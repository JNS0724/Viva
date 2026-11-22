/** Unified Viva vs. ReMe memory evaluation CLI runner.
 * Usage:
 *   cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/memory-eval/run.ts \
 *     --suite=offline|scale|chinese|lme|all \
 *     --reme-python=/path/to/reme-venv/bin/python \
 *     --reme-repo=/path/to/reme-repo \
 *     --lme-dataset=/path/to/longmemeval_s_reme_cleaned.json \
 *     --lme-per-type=2 --lme-max-sessions=0 --output=/path/to/out
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, PUBLIC_BASE_URL, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { DEEPSEEK_DEFAULT } from '../../src/backend/model-providers.ts'
import { readLiveMemoryKey } from '../live-memory.ts'
import { memorySemanticCases } from '../memory-semantic-cases.ts'
import { startLocalEmbeddingServer } from './embedding-server.ts'
import type { LocalEmbeddingServer } from './embedding-server.ts'
import { judgeChineseSemanticAnswer, judgeLmeAnswer } from './judge.ts'
import { loadLmeDataset, LME_QUESTION_TYPES, parseLmeDate, selectStratifiedLmeSlice, sortAndFilterLmeSessions } from './lme-slice.ts'
import {
  buildOfflineBundle,
  checkPatterns,
  runVivaChineseEval,
  runVivaLmeEval,
  runVivaOfflineEval,
  runVivaScaleBench,
  scoreOfflineQueries,
} from './viva-runner.ts'
import type { PreparedLmeTask } from './viva-runner.ts'
import type {
  ChineseCaseSystemResult,
  EvalManifest,
  LiveTelemetry,
  LmeCaseSystemResult,
  OfflineModeSummary,
  ScaleBenchmarkResult,
  WorkspaceStats,
} from './types.ts'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BRIDGE = path.join(ROOT, 'scripts', 'memory-eval', 'reme-bridge.py')

function argValue(prefix: string): string | undefined {
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length)
}

async function runRemeBridge<T>(pythonBin: string, command: string, payload: object, workDir: string): Promise<T> {
  mkdirSync(workDir, { recursive: true })
  const inputPath = path.join(workDir, `${command}-input.json`)
  const outputPath = path.join(workDir, `${command}-output.json`)
  writeFileSync(inputPath, `${JSON.stringify(payload, null, 2)}\n`)
  const { stderr } = await execFileAsync(pythonBin, [BRIDGE, command, '--input', inputPath, '--output', outputPath], {
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 45 * 60 * 1000,
  })
  if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`)
  return JSON.parse(readFileSync(outputPath, 'utf8')) as T
}

export function renderSummaryMarkdown(report: {
  manifest: EvalManifest
  offline?: OfflineModeSummary[]
  scale?: ScaleBenchmarkResult[]
  chinese?: ChineseCaseSystemResult[]
  lme?: { sliceSha256: string, perType: number, maxSessions: number, results: LmeCaseSystemResult[] }
}): string {
  const lines: string[] = []
  lines.push('# Viva vs. ReMe 记忆系统摸底测评报告')
  lines.push('')
  lines.push(`- **Run ID**: \`${report.manifest.runId}\``)
  lines.push(`- **Viva Commit**: \`${report.manifest.vivaCommit}\``)
  lines.push(`- **ReMe Commit / Version**: \`${report.manifest.remeCommit}\` (\`${report.manifest.remeVersion}\`)`)
  lines.push(`- **统一 LLM 模型**: \`${report.manifest.llmModel}\``)
  lines.push(`- **本地 Embedding 模型**: \`${report.manifest.embeddingModel}\``)
  lines.push(`- **执行时间**: ${report.manifest.startedAt} → ${report.manifest.finishedAt ?? ''}`)
  lines.push('')

  if (report.offline?.length) {
    lines.push('## 1. M4 离线检索对照（双语 120 文档 × 60 查询）')
    lines.push('')
    lines.push('| 数据集 | 系统 / 模式 | Hit@1 | Hit@5 | MRR@5 | 中文改写 | 跨语言 | 尾部结构 | 条件时间 | 歧义全召回 | 无答案返回 | node_search Hit@5 | 索引(ms) | 向量准备(ms) | p50(ms) | p95(ms) | 安全泄漏 |')
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const row of report.offline) {
      const g = (k: string) => row.groups[k] ? `${row.groups[k]!.hit5}/${row.groups[k]!.count}` : '-'
      const ns = row.nodeSearchCount ? `${row.nodeSearchHit5}/${row.nodeSearchCount}` : '-'
      lines.push(
        `| ${row.dataset} | \`${row.mode}\` | ${row.hit1}/${row.answerCount} (${(row.hit1 / row.answerCount * 100).toFixed(1)}%) | ` +
        `${row.hit5}/${row.answerCount} (${(row.hit5 / row.answerCount * 100).toFixed(1)}%) | ${row.mrr5.toFixed(3)} | ` +
        `${g('chinese-paraphrase')} | ${g('cross-language')} | ${g('tail-structure')} | ${g('condition-time')} | ` +
        `${row.ambiguousAllEvidenceHit5}/${row.ambiguousCount} | ${row.absentReturnedAny}/${row.absentCount} | ${ns} | ` +
        `${row.indexMs} | ${row.vectorPrepMs} | ${row.p50Ms} | ${row.p95Ms} | ${row.safetyLeaks} |`,
      )
    }
    lines.push('')
  }

  if (report.scale?.length) {
    lines.push('## 2. M2 本地规模与延迟压测（100 ~ 3,000 篇文档）')
    lines.push('')
    lines.push('| 系统 / 模式 | 文档数 | 索引构建(ms) | 向量准备(ms) | Lexical p50/p95(ms) | Hybrid p50/p95(ms) | Auto p50/p95(ms) | Auto 超时率 | RSS(MB) |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const bench of report.scale) {
      for (const p of bench.points) {
        const lex = p.lexicalP50Ms > 0 ? `${p.lexicalP50Ms} / ${p.lexicalP95Ms}` : '-'
        const hyb = p.hybridP50Ms !== null ? `${p.hybridP50Ms} / ${p.hybridP95Ms}` : '-'
        const auto = p.automaticP50Ms !== undefined && p.automaticP50Ms !== null ? `${p.automaticP50Ms} / ${p.automaticP95Ms}` : '-'
        const timeout = p.automaticTimeoutRate !== undefined && p.automaticTimeoutRate !== null ? `${(p.automaticTimeoutRate * 100).toFixed(1)}%` : '-'
        lines.push(`| \`${bench.mode}\` | ${p.docCount} | ${p.indexMs} | ${p.vectorPrepMs} | ${lex} | ${hyb} | ${auto} | ${timeout} | ${p.rssMb} |`)
      }
    }
    lines.push('')
  }

  if (report.chinese?.length) {
    lines.push('## 3. M3 中文语义与忠实度真实模型对照（7 类 / 8 阶段 / 40 回合）')
    lines.push('')
    const modes = [...new Set(report.chinese.map(r => r.mode))]
    lines.push('| 系统 / 模式 | 阶段通过率 (Judge) | 必要模式命中 | 禁止违规 | 跨项目/跨范围泄漏 | Daily 文件数 | Digest 文件数 | 总耗时(s) | LLM 调用 |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const mode of modes) {
      const items = report.chinese.filter(r => r.mode === mode)
      const phases = items.flatMap(i => i.phases)
      const yes = phases.filter(p => p.judgeVerdict === 'yes').length
      const patHit = phases.reduce((s, p) => s + p.patternHits, 0)
      const patTot = phases.reduce((s, p) => s + p.patternTotal, 0)
      const forb = phases.reduce((s, p) => s + p.forbiddenHits, 0)
      const leaks = phases.reduce((s, p) => s + (p.isolationLeaks ?? 0), 0)
      const hasIso = phases.some(p => p.isolationLeaks !== undefined)
      const daily = items.reduce((s, i) => s + i.workspace.dailyFiles, 0)
      const digest = items.reduce((s, i) => s + i.workspace.digestFiles, 0)
      const totalS = items.reduce((s, i) => s + i.telemetry.ingestMs + i.telemetry.dreamMs + i.telemetry.answerMs, 0) / 1000
      const calls = items.reduce((s, i) => s + i.telemetry.llmCalls, 0)
      lines.push(`| \`${mode}\` | ${yes}/${phases.length} (${(yes / Math.max(phases.length, 1) * 100).toFixed(1)}%) | ${patHit}/${patTot} | ${forb} | ${hasIso ? leaks : 'N/A (无原生项目隔离)'} | ${daily} | ${digest} | ${totalS.toFixed(1)} | ${calls} |`)
    }
    lines.push('')
    lines.push('### 中文语义逐题明细')
    lines.push('')
    lines.push('| Case / Phase | ' + modes.map(m => `\`${m}\``).join(' | ') + ' |')
    lines.push('| --- | ' + modes.map(() => '---').join(' | ') + ' |')
    const caseIds = [...new Set(report.chinese.map(r => r.caseId))]
    for (const cid of caseIds) {
      const ref = report.chinese.find(r => r.caseId === cid)!
      for (const p of ref.phases) {
        const cols = modes.map(m => {
          const hit = report.chinese!.find(r => r.caseId === cid && r.mode === m)?.phases.find(x => x.phaseId === p.phaseId)
          if (!hit) return 'ERR'
          const mark = hit.judgeVerdict === 'yes' ? 'PASS' : hit.judgeVerdict === 'no' ? 'FAIL' : 'ERR'
          return `${mark} (${hit.judgeReason.slice(0, 48).replaceAll('|', '/')})`
        })
        lines.push(`| \`${cid}/${p.phaseId}\` | ${cols.join(' | ')} |`)
      }
    }
    lines.push('')
  }

  if (report.lme?.results.length) {
    lines.push(`## 4. M1 LongMemEval cleaned-s 真实模型摸底（冻结分层切片 SHA256 \`${report.lme.sliceSha256.slice(0, 12)}\`）`)
    lines.push('')
    const modes = [...new Set(report.lme.results.map(r => r.mode))]
    lines.push('| 题目类别 | ' + modes.map(m => `\`${m}\``).join(' | ') + ' |')
    lines.push('| --- | ' + modes.map(() => '---:').join(' | ') + ' |')
    for (const type of LME_QUESTION_TYPES) {
      const cols = modes.map(m => {
        const sub = report.lme!.results.filter(r => r.mode === m && r.questionType === type)
        const yes = sub.filter(r => r.verdict === 'yes').length
        return sub.length ? `${yes}/${sub.length} (${(yes / sub.length * 100).toFixed(0)}%)` : '-'
      })
      lines.push(`| ${type} | ${cols.join(' | ')} |`)
    }
    const overallCols = modes.map(m => {
      const sub = report.lme!.results.filter(r => r.mode === m)
      const yes = sub.filter(r => r.verdict === 'yes').length
      return `**${yes}/${sub.length} (${(yes / Math.max(sub.length, 1) * 100).toFixed(1)}%)**`
    })
    lines.push(`| **OVERALL** | ${overallCols.join(' | ')} |`)
    lines.push('')
    lines.push('### 效率与工作区产出对比')
    lines.push('')
    lines.push('| 系统 / 模式 | 平均 Ingest(s/题) | 平均 Dream(s/题) | 平均 Answer(s/题) | 平均工具调用 | 平均 Daily 文件 | 平均 Digest 文件 | 错误数 |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const m of modes) {
      const sub = report.lme.results.filter(r => r.mode === m)
      const n = Math.max(sub.length, 1)
      const avg = (fn: (r: LmeCaseSystemResult) => number) => (sub.reduce((s, r) => s + fn(r), 0) / n)
      lines.push(
        `| \`${m}\` | ${(avg(r => r.telemetry.ingestMs) / 1000).toFixed(1)} | ${(avg(r => r.telemetry.dreamMs) / 1000).toFixed(1)} | ` +
        `${(avg(r => r.telemetry.answerMs) / 1000).toFixed(1)} | ${avg(r => r.telemetry.toolCalls).toFixed(2)} | ` +
        `${avg(r => r.workspace.dailyFiles).toFixed(1)} | ${avg(r => r.workspace.digestFiles).toFixed(1)} | ${sub.filter(r => r.error).length} |`,
      )
    }
    lines.push('')
    lines.push('### LongMemEval 逐题胜负对比')
    lines.push('')
    lines.push('| Question ID | Type | Abs? | ' + modes.map(m => `\`${m}\``).join(' | ') + ' |')
    lines.push('| --- | --- | :---: | ' + modes.map(() => '---').join(' | ') + ' |')
    const qids = [...new Set(report.lme.results.map(r => r.questionId))]
    for (const qid of qids) {
      const ref = report.lme.results.find(r => r.questionId === qid)!
      const cols = modes.map(m => {
        const hit = report.lme!.results.find(r => r.questionId === qid && r.mode === m)
        if (!hit) return '-'
        const tag = hit.verdict === 'yes' ? 'PASS' : hit.verdict === 'no' ? 'FAIL' : 'ERR'
        return `${tag}: ${hit.answer.slice(0, 60).replaceAll('\n', ' ').replaceAll('|', '/')}`
      })
      lines.push(`| \`${qid}\` | ${ref.questionType} | ${ref.isAbstention ? 'Y' : ''} | ${cols.join(' | ')} |`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

async function main() {
  const suiteArg = argValue('--suite=') ?? 'all'
  const suites = suiteArg === 'all' ? ['offline', 'scale', 'chinese', 'lme'] : suiteArg.split(',').map(s => s.trim()).filter(Boolean)
  const remePython = argValue('--reme-python=') ?? 'python3'
  const remeRepo = argValue('--reme-repo=') ?? ''
  const lmeDatasetPath = argValue('--lme-dataset=') ?? (remeRepo ? path.join(remeRepo, 'benchmark', 'longmemeval', 'dataset', 'longmemeval_s_reme_cleaned.json') : '')
  const lmePerType = Number(argValue('--lme-per-type=') ?? '2')
  const lmeMaxSessions = Number(argValue('--lme-max-sessions=') ?? '0')
  const concurrency = Number(argValue('--concurrency=') ?? '3')
  const vivaOnly = process.argv.includes('--viva-only')
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  const outputDir = path.resolve(argValue('--output=') ?? path.join(ROOT, 'smoke', `memory-eval-${runId}`))
  mkdirSync(outputDir, { recursive: true })

  const preparedDir = path.join(ROOT, 'build', 'memory-embedding', 'prepared')
  const modelRoot = path.join(preparedDir, 'model')
  const runtimeRoot = path.join(preparedDir, 'runtime')
  const hasEmbedding = existsSync(modelRoot) && existsSync(runtimeRoot)

  const vivaCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const remeCommit = !vivaOnly && remeRepo && existsSync(remeRepo)
    ? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: remeRepo, encoding: 'utf8' }).trim()
    : 'skipped'
  const remeVersion = !vivaOnly
    ? execFileSync(remePython, ['-c', 'import reme; print(reme.__version__)'], { encoding: 'utf8' }).trim()
    : 'skipped'

  const manifest: EvalManifest = {
    runId,
    startedAt: new Date().toISOString(),
    vivaCommit,
    remeCommit,
    remeVersion,
    llmModel: DEEPSEEK_DEFAULT.model,
    embeddingModel: hasEmbedding ? 'granite-embedding-97m-multilingual-r2-ONNX (q8, 384d)' : 'disabled',
    suites,
  }

  let embeddingServer: LocalEmbeddingServer | null = null
  if (!vivaOnly && hasEmbedding && (suites.includes('offline') || suites.includes('chinese') || suites.includes('lme'))) {
    process.stderr.write('[eval] starting local Granite-97M OpenAI proxy for ReMe iso-embedding...\n')
    embeddingServer = await startLocalEmbeddingServer(modelRoot, runtimeRoot)
    process.stderr.write(`[eval] Granite-97M proxy ready at ${embeddingServer.url} (${embeddingServer.dimensions}d)\n`)
  }

  let llmCtx: Context | null = null
  let unregisterLlm: (() => void) | null = null
  if (suites.includes('chinese') || suites.includes('lme')) {
    const key = readLiveMemoryKey()
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    const connection = resolveAdapterOptions({})
    if (connection.baseURL !== PUBLIC_BASE_URL) throw new Error('Expected official DeepSeek endpoint')
    const anonymous = getOrCreateAnonymousUserId({ env: { DSH_HOME: path.join(outputDir, 'isolated-dsh-home') } })
    unregisterLlm = llm.registerAdapter([DEEPSEEK_DEFAULT.provider], new DeepSeekAdapter({
      options: () => connection,
      resolveAuth: async () => ({ headers: { 'x-api-key': key } }),
      resolveUserId: () => anonymous,
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    }))
    llmCtx = ctx
  }

  const report: {
    manifest: EvalManifest
    offline?: OfflineModeSummary[]
    scale?: ScaleBenchmarkResult[]
    chinese?: ChineseCaseSystemResult[]
    lme?: { sliceSha256: string, perType: number, maxSessions: number, results: LmeCaseSystemResult[] }
  } = { manifest }

  const save = () => {
    writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(path.join(outputDir, 'summary.md'), renderSummaryMarkdown(report))
  }

  try {
    // ── M4: Offline Retrieval Comparison ────────────────────────────────────
    if (suites.includes('offline')) {
      report.offline = []
      for (const dataset of ['evaluation', 'validation'] as const) {
        process.stderr.write(`[eval][offline] running Viva on ${dataset}...\n`)
        report.offline.push(await runVivaOfflineEval(dataset, { mode: 'viva-bm25' }))
        if (hasEmbedding) {
          report.offline.push(await runVivaOfflineEval(dataset, { mode: 'viva-hybrid-granite', modelRoot, runtimeRoot }))
        }
        if (vivaOnly) {
          save()
          continue
        }
        const bundle = buildOfflineBundle(dataset)
        const nodeExpected = new Map(bundle.nodeQueries.map(q => [q.id, q.expectedIds]))

        process.stderr.write(`[eval][offline] running ReMe (BM25) on ${dataset}...\n`)
        const remeBm25 = await runRemeBridge<{
          indexMs: number
          queries: Array<{ id: string, elapsedMs: number, hits: Array<{ id: string, text: string, score: number }> }>
          nodeQueries: Array<{ id: string, elapsedMs: number, nodes: Array<{ id: string }> }>
        }>(
          remePython,
          'offline-eval',
          {
            workDir: path.join(outputDir, 'reme-work', `offline-${dataset}-bm25`),
            documents: bundle.remeDocuments,
            queries: bundle.remeQueries,
            nodeQueries: bundle.nodeQueries.map(q => ({ id: q.id, text: q.text })),
            limit: 5,
          },
          path.join(outputDir, 'bridge', `offline-${dataset}-bm25`),
        )
        report.offline.push(scoreOfflineQueries(bundle.queries, remeBm25.queries, {
          system: 'reme',
          mode: 'reme-bm25',
          dataset,
          indexMs: remeBm25.indexMs,
          vectorPrepMs: 0,
          nodeHits: remeBm25.nodeQueries.map(nq => ({
            id: nq.id,
            expectedIds: nodeExpected.get(nq.id) ?? [],
            returnedIds: nq.nodes.map(n => n.id),
          })),
        }))

        if (embeddingServer) {
          process.stderr.write(`[eval][offline] running ReMe (Hybrid Granite-97M) on ${dataset}...\n`)
          const remeHybrid = await runRemeBridge<{
            indexMs: number
            queries: Array<{ id: string, elapsedMs: number, hits: Array<{ id: string, text: string, score: number }> }>
            nodeQueries: Array<{ id: string, elapsedMs: number, nodes: Array<{ id: string }> }>
          }>(
            remePython,
            'offline-eval',
            {
              workDir: path.join(outputDir, 'reme-work', `offline-${dataset}-hybrid`),
              documents: bundle.remeDocuments,
              queries: bundle.remeQueries,
              nodeQueries: bundle.nodeQueries.map(q => ({ id: q.id, text: q.text })),
              limit: 5,
              embeddingUrl: embeddingServer.url,
              embeddingDims: embeddingServer.dimensions,
            },
            path.join(outputDir, 'bridge', `offline-${dataset}-hybrid`),
          )
          report.offline.push(scoreOfflineQueries(bundle.queries, remeHybrid.queries, {
            system: 'reme',
            mode: 'reme-hybrid-granite',
            dataset,
            indexMs: remeHybrid.indexMs,
            vectorPrepMs: 0,
            nodeHits: remeHybrid.nodeQueries.map(nq => ({
              id: nq.id,
              expectedIds: nodeExpected.get(nq.id) ?? [],
              returnedIds: nq.nodes.map(n => n.id),
            })),
          }))
        }
        save()
      }
    }

    // ── M2: Scale & Latency Benchmark ───────────────────────────────────────
    if (suites.includes('scale')) {
      const docCounts = [100, 1000, 3000]
      report.scale = []
      process.stderr.write('[eval][scale] running Viva scale bench (BM25 + Granite-97M)...\n')
      report.scale.push(await runVivaScaleBench(docCounts, {
        modelRoot: hasEmbedding ? modelRoot : undefined,
        runtimeRoot: hasEmbedding ? runtimeRoot : undefined,
        includeHybrid: hasEmbedding,
      }))
      if (!vivaOnly) {
        process.stderr.write('[eval][scale] running ReMe scale bench (BM25)...\n')
        const remeScale = await runRemeBridge<{ points: ScaleBenchmarkResult['points'] }>(
          remePython,
          'scale-bench',
          { workDir: path.join(outputDir, 'reme-work', 'scale-bm25'), docCounts },
          path.join(outputDir, 'bridge', 'scale-bm25'),
        )
        report.scale.push({ system: 'reme', mode: 'reme-bm25', points: remeScale.points })
      }
      save()
    }

    // ── M3: Chinese Semantic Real-Model Comparison ──────────────────────────
    if (suites.includes('chinese')) {
      if (!llmCtx) throw new Error('LLM context not initialized')
      report.chinese = []
      process.stderr.write('[eval][chinese] running Viva (Granite-97M + Dream) on 7 frozen Chinese cases...\n')
      const vivaCn = await runVivaChineseEval(llmCtx, memorySemanticCases, {
        workDir: path.join(outputDir, 'viva-work', 'chinese'),
        modelRoot: hasEmbedding ? modelRoot : undefined,
        runtimeRoot: hasEmbedding ? runtimeRoot : undefined,
        modeLabel: hasEmbedding ? 'viva-hybrid-granite' : 'viva-bm25',
      })
      report.chinese.push(...vivaCn)
      save()

      if (!vivaOnly) {
        process.stderr.write('[eval][chinese] running ReMe (Hybrid Granite-97M + Dream) on 7 frozen Chinese cases...\n')
        const remeCnRaw = await runRemeBridge<{
          cases: Array<{
            caseId: string
            phases: Array<{ phaseId: string, recallQuery: string, recallSnippetCount: number, answer: string }>
            workspace: WorkspaceStats
            telemetry: LiveTelemetry
            error?: string
          }>
        }>(
          remePython,
          'chinese-eval',
          {
            workDir: path.join(outputDir, 'reme-work', 'chinese-hybrid'),
            cases: memorySemanticCases,
            llmModel: DEEPSEEK_DEFAULT.model,
            llmBaseUrl: 'https://api.deepseek.com/v1',
            ...(embeddingServer ? { embeddingUrl: embeddingServer.url, embeddingDims: embeddingServer.dimensions } : {}),
            indexSessions: true,
          },
          path.join(outputDir, 'bridge', 'chinese-hybrid'),
        )
        for (const raw of remeCnRaw.cases) {
          const fixture = memorySemanticCases.find(c => c.id === raw.caseId)!
          const judgedPhases: ChineseCaseSystemResult['phases'] = []
          for (const p of raw.phases) {
            const phaseDef = fixture.phases.find(x => x.id === p.phaseId)!
            const required = phaseDef.expectations.filter(e => e.disposition === 'required')
            const judge = await judgeChineseSemanticAnswer(llmCtx, {
              question: phaseDef.recallQuery,
              requiredSemantics: required.map(e => e.semantic),
              forbiddenSemantics: phaseDef.forbidden.map(f => f.semantic),
              answer: p.answer,
            })
            judgedPhases.push({
              ...p,
              judgeVerdict: judge.verdict,
              judgeReason: judge.reason,
              patternHits: required.filter(e => checkPatterns(p.answer, e.claimPatterns)).length,
              patternTotal: required.length,
              forbiddenHits: phaseDef.forbidden.filter(f => checkPatterns(p.answer, f.claimPatterns)).length,
            })
          }
          report.chinese.push({
            system: 'reme',
            mode: embeddingServer ? 'reme-hybrid-granite' : 'reme-bm25',
            caseId: raw.caseId,
            category: fixture.category,
            phases: judgedPhases,
            workspace: raw.workspace,
            telemetry: raw.telemetry,
            ...(raw.error ? { error: raw.error } : {}),
          })
        }
        save()
      }
    }

    // ── M1: LongMemEval Stratified Real-Model Scouting Pass ─────────────────
    if (suites.includes('lme')) {
      if (!llmCtx) throw new Error('LLM context not initialized')
      if (!lmeDatasetPath || !existsSync(lmeDatasetPath)) {
        throw new Error(`LongMemEval dataset not found: ${lmeDatasetPath}`)
      }
      const allItems = loadLmeDataset(lmeDatasetPath)
      const { items, sliceSha256 } = selectStratifiedLmeSlice(allItems, lmePerType)
      const tasks: PreparedLmeTask[] = items.map(item => ({
        questionId: item.question_id,
        questionType: item.question_type,
        isAbstention: String(item.question_id).endsWith('_abs'),
        question: item.question,
        groundTruth: String(item.answer),
        queryTimeIso: item.question_date ? parseLmeDate(item.question_date).isoStr : '',
        sessions: sortAndFilterLmeSessions(item, lmeMaxSessions),
      }))
      report.lme = { sliceSha256, perType: lmePerType, maxSessions: lmeMaxSessions, results: [] }
      save()

      process.stderr.write(`[eval][lme] running Viva (${tasks.length} items, slice=${sliceSha256.slice(0, 12)})...\n`)
      const vivaLme = await runVivaLmeEval(llmCtx, tasks, {
        workDir: path.join(outputDir, 'viva-work', 'lme'),
        modelRoot: hasEmbedding ? modelRoot : undefined,
        runtimeRoot: hasEmbedding ? runtimeRoot : undefined,
        modeLabel: hasEmbedding ? 'viva-hybrid-granite' : 'viva-bm25',
        enableDream: true,
        includeAutoContext: true,
        concurrency,
      })
      report.lme.results.push(...vivaLme)
      save()

      if (!vivaOnly) {
        process.stderr.write(`[eval][lme] running ReMe (${tasks.length} items, slice=${sliceSha256.slice(0, 12)})...\n`)
        const remeLmeRaw = await runRemeBridge<{
          items: Array<{
            questionId: string
            answer: string
            sessionsIngested: number
            dreamTriggers: number
            workspace: WorkspaceStats
            telemetry: LiveTelemetry
            error?: string
          }>
        }>(
          remePython,
          'lme-eval',
          {
            workDir: path.join(outputDir, 'reme-work', 'lme-hybrid'),
            items: tasks.map(t => ({
              question_id: t.questionId,
              question_type: t.questionType,
              question: t.question,
              queryTimeIso: t.queryTimeIso,
              sessions: t.sessions,
            })),
            llmModel: DEEPSEEK_DEFAULT.model,
            llmBaseUrl: 'https://api.deepseek.com/v1',
            ...(embeddingServer ? { embeddingUrl: embeddingServer.url, embeddingDims: embeddingServer.dimensions } : {}),
            enableDream: false, // ReMe official LongMemEval benchmark preset leaves auto_dream disabled
            indexSessions: true,
            concurrency,
          },
          path.join(outputDir, 'bridge', 'lme-hybrid'),
        )
        for (const raw of remeLmeRaw.items) {
          const task = tasks.find(t => t.questionId === raw.questionId)!
          const judge = raw.error
            ? { verdict: 'error' as const, reason: raw.error }
            : await judgeLmeAnswer(llmCtx, {
                question: task.question,
                groundTruth: task.groundTruth,
                answer: raw.answer,
                questionType: task.questionType,
                isAbstention: task.isAbstention,
              })
          report.lme.results.push({
            system: 'reme',
            mode: embeddingServer ? 'reme-lme-granite' : 'reme-lme-bm25',
            questionId: task.questionId,
            questionType: task.questionType,
            isAbstention: task.isAbstention,
            question: task.question,
            groundTruth: task.groundTruth,
            answer: raw.answer,
            verdict: judge.verdict,
            judgeReason: judge.reason,
            sessionsIngested: raw.sessionsIngested,
            dreamTriggers: raw.dreamTriggers,
            workspace: raw.workspace,
            telemetry: raw.telemetry,
            ...(raw.error ? { error: raw.error } : {}),
          })
        }
        save()
      }
    }
  } finally {
    manifest.finishedAt = new Date().toISOString()
    save()
    unregisterLlm?.()
    await embeddingServer?.close()
  }

  process.stdout.write(`[eval] completed. Summary: ${path.join(outputDir, 'summary.md')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`[eval] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
