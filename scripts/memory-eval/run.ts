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
import { hasTruncatedAnswerEvidence, loadLmeDataset, LME_QUESTION_TYPES, parseLmeDate, selectStratifiedLmeSlice, sortAndFilterLmeSessions } from './lme-slice.ts'
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
  LmeSessionSampling,
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

async function runRemeBridge<T>(
  pythonBin: string,
  command: string,
  payload: object,
  workDir: string,
  extraEnv?: Record<string, string>,
): Promise<T> {
  mkdirSync(workDir, { recursive: true })
  const inputPath = path.join(workDir, `${command}-input.json`)
  const outputPath = path.join(workDir, `${command}-output.json`)
  writeFileSync(inputPath, `${JSON.stringify(payload, null, 2)}\n`)
  const { stderr } = await execFileAsync(pythonBin, [BRIDGE, command, '--input', inputPath, '--output', outputPath], {
    env: { ...process.env, ...(extraEnv ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 90 * 60 * 1000,
  })
  if (stderr.trim()) process.stderr.write(`${stderr.trim()}\n`)
  return JSON.parse(readFileSync(outputPath, 'utf8')) as T
}

export function renderSummaryMarkdown(report: {
  manifest: EvalManifest
  offline?: OfflineModeSummary[]
  scale?: ScaleBenchmarkResult[]
  chinese?: ChineseCaseSystemResult[]
  lme?: { sliceSha256: string, perType: number, maxSessions: number, sessionSampling?: LmeSessionSampling, results: LmeCaseSystemResult[] }
}): string {
  const lines: string[] = []
  lines.push('# Viva vs. ReMe 记忆系统摸底测评报告')
  lines.push('')
  lines.push(`- **Run ID**: \`${report.manifest.runId}\``)
  lines.push(`- **Viva Commit**: \`${report.manifest.vivaCommit}\``)
  lines.push(`- **ReMe Commit / Version**: \`${report.manifest.remeCommit}\` (\`${report.manifest.remeVersion}\`)`)
  lines.push(`- **统一 LLM 模型**: \`${report.manifest.llmModel}\``)
  lines.push(`- **本地 Embedding 模型**: \`${report.manifest.embeddingModel}\``)
  if (report.manifest.vivaAutoContext !== undefined) {
    lines.push(`- **Viva Auto Context**: \`${report.manifest.vivaAutoContext}\``)
  }
  if (report.manifest.remeEnableDream !== undefined) {
    lines.push(`- **ReMe LME Dream**: \`${report.manifest.remeEnableDream}\``)
  }
  if (report.manifest.lmeSessionSampling !== undefined) {
    lines.push(`- **LME 会话截取策略**: \`${report.manifest.lmeSessionSampling}\``)
  }
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
      const vecPrep = row.vectorPrepMs === null ? 'N/A (含于索引)' : String(row.vectorPrepMs)
      lines.push(
        `| ${row.dataset} | \`${row.mode}\` | ${row.hit1}/${row.answerCount} (${(row.hit1 / row.answerCount * 100).toFixed(1)}%) | ` +
        `${row.hit5}/${row.answerCount} (${(row.hit5 / row.answerCount * 100).toFixed(1)}%) | ${row.mrr5.toFixed(3)} | ` +
        `${g('chinese-paraphrase')} | ${g('cross-language')} | ${g('tail-structure')} | ${g('condition-time')} | ` +
        `${row.ambiguousAllEvidenceHit5}/${row.ambiguousCount} | ${row.absentReturnedAny}/${row.absentCount} | ${ns} | ` +
        `${row.indexMs} | ${vecPrep} | ${row.p50Ms} | ${row.p95Ms} | ${row.safetyLeaks} |`,
      )
    }
    if (report.offline.some(row => row.vectorPrepMs === null)) {
      lines.push('')
      lines.push('> 注：`N/A (含于索引)` 表示该系统的 `index_update` 同时执行全文索引与向量准备，无法独立拆分计时。')
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
    const caseIds = [...new Set(report.chinese.map(r => r.caseId))]
    const expectedByCase = new Map<string, string[]>()
    for (const cid of caseIds) {
      const fixture = memorySemanticCases.find(c => c.id === cid)
      const observedIds = [...new Set(report.chinese.filter(r => r.caseId === cid).flatMap(r => r.phases.map(p => p.phaseId)))]
      const phaseIds = fixture
        ? [...fixture.phases.map(p => p.id), ...observedIds.filter(id => !fixture.phases.some(p => p.id === id))]
        : observedIds
      expectedByCase.set(cid, phaseIds)
    }
    const totalExpectedPhases = [...expectedByCase.values()].reduce((sum, list) => sum + list.length, 0)
    lines.push('| 系统 / 模式 | 阶段通过率 (Judge) | 裁判错误 | 必要模式命中 | 禁止违规 | 跨项目/跨范围泄漏 | Daily / Digest | 总耗时(s) | HTTP LLM 调用 | Input Tokens (Cache命中) | Output Tokens |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const mode of modes) {
      const items = report.chinese.filter(r => r.mode === mode)
      const phases = items.flatMap(i => i.phases)
      const yes = phases.filter(p => p.judgeVerdict === 'yes').length
      const judgeErrors = phases.filter(p => p.judgeVerdict === 'error').length
      const denominator = Math.max(totalExpectedPhases, phases.length) - judgeErrors
      const passRate = denominator > 0 ? `${yes}/${denominator} (${(yes / denominator * 100).toFixed(1)}%)` : '-'
      const patHit = phases.reduce((s, p) => s + p.patternHits, 0)
      const patTot = phases.reduce((s, p) => s + p.patternTotal, 0)
      const forb = phases.reduce((s, p) => s + p.forbiddenHits, 0)
      const leaks = phases.reduce((s, p) => s + (p.isolationLeaks ?? 0), 0)
      const hasIso = phases.some(p => p.isolationLeaks !== undefined)
      const daily = items.reduce((s, i) => s + i.workspace.dailyFiles, 0)
      const digest = items.reduce((s, i) => s + i.workspace.digestFiles, 0)
      const totalS = items.reduce((s, i) => s + i.telemetry.ingestMs + i.telemetry.dreamMs + i.telemetry.answerMs, 0) / 1000
      const calls = items.reduce((s, i) => s + i.telemetry.llmCalls, 0)
      const inTok = items.reduce((s, i) => s + i.telemetry.inputTokens, 0)
      const cacheTok = items.reduce((s, i) => s + (i.telemetry.cacheReadTokens ?? 0), 0)
      const outTok = items.reduce((s, i) => s + i.telemetry.outputTokens, 0)
      const cachePct = inTok > 0 ? `${(cacheTok / inTok * 100).toFixed(0)}%` : '-'
      lines.push(`| \`${mode}\` | ${passRate} | ${judgeErrors} | ${patHit}/${patTot} | ${forb} | ${hasIso ? leaks : 'N/A (无原生项目隔离)'} | ${daily} / ${digest} | ${totalS.toFixed(1)} | ${calls} | ${inTok.toLocaleString()} (${cachePct}) | ${outTok.toLocaleString()} |`)
    }
    lines.push('')
    lines.push('### 中文语义逐题明细')
    lines.push('')
    lines.push('| Case / Phase | ' + modes.map(m => `\`${m}\``).join(' | ') + ' |')
    lines.push('| --- | ' + modes.map(() => '---').join(' | ') + ' |')
    for (const cid of caseIds) {
      const phaseIds = expectedByCase.get(cid) ?? []
      for (const phaseId of phaseIds) {
        const cols = modes.map(m => {
          const caseRes = report.chinese!.find(r => r.caseId === cid && r.mode === m)
          const hit = caseRes?.phases.find(x => x.phaseId === phaseId)
          if (!hit) {
            const reason = caseRes?.error ? caseRes.error.slice(0, 48).replaceAll('|', '/') : 'missing'
            return `ERR (${reason})`
          }
          const mark = hit.judgeVerdict === 'yes' ? 'PASS' : hit.judgeVerdict === 'no' ? 'FAIL' : 'ERR'
          return `${mark} (${hit.judgeReason.slice(0, 48).replaceAll('|', '/')})`
        })
        lines.push(`| \`${cid}/${phaseId}\` | ${cols.join(' | ')} |`)
      }
    }
    lines.push('')
  }

  if (report.lme?.results.length) {
    const samplingLabel = report.lme.maxSessions > 0 ? `, sampling=${report.lme.sessionSampling ?? 'recent'}` : ''
    lines.push(`## 4. M1 LongMemEval cleaned-s 真实模型摸底（冻结分层切片 SHA256 \`${report.lme.sliceSha256.slice(0, 12)}\`, maxSessions=${report.lme.maxSessions}${samplingLabel}）`)
    if (report.lme.maxSessions > 0 && report.lme.sessionSampling === 'answer-aware') {
      lines.push('')
      lines.push('> 注意：本次运行显式启用了 `answer-aware` 截断（按答案会话标签保底并均匀补齐干扰会话），属于受控上下文长度实验，不代表无标签全历史检索分数。')
    }
    const isJudgeError = (r: LmeCaseSystemResult) => r.verdict === 'error' && !r.error
    const hasTruncated = report.lme.results.some(r => r.evidenceTruncated)
    const hasJudgeErrors = report.lme.results.some(isJudgeError)
    if (hasTruncated) {
      lines.push('')
      lines.push('> 注意：以下准确率仅统计保留了全部答案会话的**完整证据样本**；被 `recent` 截断丢弃答案会话的题目已从准确率分母中排除并单独列示。')
    }
    if (hasJudgeErrors) {
      lines.push('')
      lines.push('> 注意：裁判请求失败/超时的题目已从准确率分母中排除，并在「裁判错误排除」及错误列中单独统计。')
    }
    lines.push('')
    const modes = [...new Set(report.lme.results.map(r => r.mode))]
    lines.push('| 题目类别 | ' + modes.map(m => `\`${m}\``).join(' | ') + ' |')
    lines.push('| --- | ' + modes.map(() => '---:').join(' | ') + ' |')
    for (const type of LME_QUESTION_TYPES) {
      const cols = modes.map(m => {
        const sub = report.lme!.results.filter(r => r.mode === m && r.questionType === type && !r.evidenceTruncated && !isJudgeError(r))
        const yes = sub.filter(r => r.verdict === 'yes').length
        return sub.length ? `${yes}/${sub.length} (${(yes / sub.length * 100).toFixed(0)}%)` : '-'
      })
      lines.push(`| ${type} | ${cols.join(' | ')} |`)
    }
    const overallCols = modes.map(m => {
      const sub = report.lme!.results.filter(r => r.mode === m && !r.evidenceTruncated && !isJudgeError(r))
      const yes = sub.filter(r => r.verdict === 'yes').length
      return sub.length ? `**${yes}/${sub.length} (${(yes / sub.length * 100).toFixed(1)}%)**` : '-'
    })
    lines.push(`| **${hasTruncated ? 'OVERALL (完整证据)' : 'OVERALL'}** | ${overallCols.join(' | ')} |`)
    if (hasTruncated) {
      const truncCols = modes.map(m => {
        const dropped = report.lme!.results.filter(r => r.mode === m && r.evidenceTruncated).length
        return `${dropped} 题`
      })
      lines.push(`| 证据被截断跳过 | ${truncCols.join(' | ')} |`)
    }
    if (hasJudgeErrors) {
      const judgeErrCols = modes.map(m => {
        const count = report.lme!.results.filter(r => r.mode === m && !r.evidenceTruncated && isJudgeError(r)).length
        return `${count} 题`
      })
      lines.push(`| 裁判错误排除 | ${judgeErrCols.join(' | ')} |`)
    }
    lines.push('')
    lines.push('### 效率、Token 成本与工作区产出对比（单题均值）')
    lines.push('')
    lines.push('| 系统 / 模式 | Ingest(s) | Dream(s) | Answer(s) | HTTP 调用(Ing/Drm/Ans) | Input Tokens (Cache命中) | Output Tokens | 工具调用 | Daily / Digest | 错误数(系统/裁判) |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const m of modes) {
      const sub = report.lme.results.filter(r => r.mode === m)
      const n = Math.max(sub.length, 1)
      const avg = (fn: (r: LmeCaseSystemResult) => number) => (sub.reduce((s, r) => s + fn(r), 0) / n)
      const inAvg = avg(r => r.telemetry.inputTokens)
      const cacheAvg = avg(r => r.telemetry.cacheReadTokens ?? 0)
      const outAvg = avg(r => r.telemetry.outputTokens)
      const cachePct = inAvg > 0 ? `${(cacheAvg / inAvg * 100).toFixed(0)}%` : '-'
      const ingCalls = avg(r => r.telemetry.phaseTokens?.ingest.calls ?? 0)
      const drmCalls = avg(r => r.telemetry.phaseTokens?.dream.calls ?? 0)
      const ansCalls = avg(r => r.telemetry.phaseTokens?.answer.calls ?? 0)
      const callsStr = `${avg(r => r.telemetry.llmCalls).toFixed(1)} (${ingCalls.toFixed(1)}/${drmCalls.toFixed(1)}/${ansCalls.toFixed(1)})`
      const sysErrors = sub.filter(r => Boolean(r.error)).length
      const judgeErrors = sub.filter(isJudgeError).length
      lines.push(
        `| \`${m}\` | ${(avg(r => r.telemetry.ingestMs) / 1000).toFixed(1)} | ${(avg(r => r.telemetry.dreamMs) / 1000).toFixed(1)} | ` +
        `${(avg(r => r.telemetry.answerMs) / 1000).toFixed(1)} | ${callsStr} | ${Math.round(inAvg).toLocaleString()} (${cachePct}) | ` +
        `${Math.round(outAvg).toLocaleString()} | ${avg(r => r.telemetry.toolCalls).toFixed(2)} | ` +
        `${avg(r => r.workspace.dailyFiles).toFixed(1)} / ${avg(r => r.workspace.digestFiles).toFixed(1)} | ${sysErrors} / ${judgeErrors} |`,
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
        const tag = hit.evidenceTruncated
          ? 'TRUNCATED'
          : isJudgeError(hit)
            ? 'JUDGE_ERR'
            : hit.verdict === 'yes' ? 'PASS' : hit.verdict === 'no' ? 'FAIL' : 'ERR'
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
  const lmeExcludeReport = argValue('--lme-exclude-report=') ?? ''
  const concurrency = Number(argValue('--concurrency=') ?? '3')
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid --concurrency value (must be a positive integer): ${argValue('--concurrency=')}`)
  }
  if (!Number.isSafeInteger(lmePerType) || lmePerType < 1) {
    throw new Error(`Invalid --lme-per-type value (must be a positive integer): ${argValue('--lme-per-type=')}`)
  }
  if (!Number.isSafeInteger(lmeMaxSessions) || lmeMaxSessions < 0) {
    throw new Error(`Invalid --lme-max-sessions value (must be a non-negative integer): ${argValue('--lme-max-sessions=')}`)
  }
  const vivaOnly = process.argv.includes('--viva-only')
  const vivaIncludeAutoContext = !process.argv.includes('--viva-no-auto-context')
  const remeEnableDream = process.argv.includes('--reme-enable-dream')
  const rawSampling = argValue('--lme-session-sampling=') ?? 'recent'
  if (rawSampling !== 'recent' && rawSampling !== 'answer-aware') {
    throw new Error(`Invalid --lme-session-sampling value (expected "recent" or "answer-aware"): ${rawSampling}`)
  }
  const lmeSessionSampling: LmeSessionSampling = rawSampling
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  const outputDir = path.resolve(argValue('--output=') ?? path.join(ROOT, 'smoke', `memory-eval-${runId}`))
  mkdirSync(outputDir, { recursive: true })

  const preparedDir = path.join(ROOT, 'build', 'memory-embedding', 'prepared')
  const modelRoot = path.join(preparedDir, 'model')
  const runtimeRoot = path.join(preparedDir, 'runtime')
  const hasEmbedding = existsSync(modelRoot) && existsSync(runtimeRoot)

  const vivaCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  let remeVersion = 'skipped'
  let remeCommit = 'skipped'
  if (!vivaOnly) {
    const info = JSON.parse(execFileSync(
      remePython,
      ['-c', 'import json, pathlib, reme; print(json.dumps({"version": getattr(reme, "__version__", "unknown"), "file": str(pathlib.Path(reme.__file__).resolve())}))'],
      { encoding: 'utf8' },
    ).trim()) as { version: string, file: string }
    remeVersion = info.version
    const importedDir = path.dirname(info.file)
    let importedGitRoot: string | null = null
    let importedCommit: string | null = null
    try {
      importedGitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: importedDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      importedCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: importedDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { /* Installed outside a git checkout (e.g. wheel/site-packages). */ }
    remeCommit = importedCommit ?? 'non-git-install'
    if (remeRepo && existsSync(remeRepo)) {
      try {
        const argRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: remeRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        const argCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: remeRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (!importedGitRoot || path.resolve(importedGitRoot) !== path.resolve(argRoot)) {
          process.stderr.write(`[eval][warn] --reme-python imports ${info.file} (${remeCommit}), which differs from --reme-repo ${remeRepo} (${argCommit})\n`)
          remeCommit = `${remeCommit} (differs from --reme-repo ${argCommit})`
        }
      } catch { /* Ignore non-git --reme-repo. */ }
    }
  }

  const manifest: EvalManifest = {
    runId,
    startedAt: new Date().toISOString(),
    vivaCommit,
    remeCommit,
    remeVersion,
    llmModel: DEEPSEEK_DEFAULT.model,
    embeddingModel: hasEmbedding ? 'granite-embedding-97m-multilingual-r2-ONNX (q8, 384d)' : 'disabled',
    suites,
    vivaAutoContext: vivaIncludeAutoContext,
    remeEnableDream,
    ...(suites.includes('lme') ? { lmeSessionSampling } : {}),
  }

  let embeddingServer: LocalEmbeddingServer | null = null
  let llmCtx: Context | null = null
  let unregisterLlm: (() => void) | null = null
  let remeApiEnv: Record<string, string> | undefined

  const report: {
    manifest: EvalManifest
    offline?: OfflineModeSummary[]
    scale?: ScaleBenchmarkResult[]
    chinese?: ChineseCaseSystemResult[]
    lme?: { sliceSha256: string, perType: number, maxSessions: number, sessionSampling?: LmeSessionSampling, results: LmeCaseSystemResult[] }
  } = { manifest }

  const save = () => {
    writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(path.join(outputDir, 'summary.md'), renderSummaryMarkdown(report))
  }

  try {
    if (!vivaOnly && hasEmbedding && (suites.includes('offline') || suites.includes('chinese') || suites.includes('lme'))) {
      process.stderr.write('[eval] starting local Granite-97M OpenAI proxy for ReMe iso-embedding...\n')
      embeddingServer = await startLocalEmbeddingServer(modelRoot, runtimeRoot)
      process.stderr.write(`[eval] Granite-97M proxy ready at ${embeddingServer.url} (${embeddingServer.dimensions}d)\n`)
    }

    if (suites.includes('chinese') || suites.includes('lme')) {
      const key = readLiveMemoryKey()
      remeApiEnv = { DEEPSEEK_API_KEY: key }
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
            vectorPrepMs: null,
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
          remeApiEnv,
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
      const excludeIds = new Set<string>()
      if (lmeExcludeReport) {
        if (!existsSync(lmeExcludeReport)) {
          throw new Error(`--lme-exclude-report file not found: ${lmeExcludeReport}`)
        }
        const prior = JSON.parse(readFileSync(lmeExcludeReport, 'utf8')) as { lme?: { results?: Array<{ questionId?: string }> } }
        for (const r of prior.lme?.results ?? []) {
          if (typeof r.questionId === 'string' && r.questionId.trim()) excludeIds.add(r.questionId)
        }
        if (excludeIds.size === 0) {
          throw new Error(`--lme-exclude-report contains no valid questionId entries: ${lmeExcludeReport}`)
        }
        process.stderr.write(`[eval][lme] excluding ${excludeIds.size} previously-evaluated dev IDs for strict held-out blind test\n`)
      }
      const { items, sliceSha256 } = selectStratifiedLmeSlice(allItems, lmePerType, excludeIds.size ? excludeIds : undefined)
      const tasks: PreparedLmeTask[] = items.map(item => {
        const sessions = sortAndFilterLmeSessions(item, lmeMaxSessions, lmeSessionSampling)
        const evidenceTruncated = hasTruncatedAnswerEvidence(item, sessions)
        return {
          questionId: item.question_id,
          questionType: item.question_type,
          isAbstention: String(item.question_id).endsWith('_abs'),
          ...(evidenceTruncated ? { evidenceTruncated: true } : {}),
          question: item.question,
          groundTruth: String(item.answer),
          queryTimeIso: item.question_date ? parseLmeDate(item.question_date).isoStr : '',
          sessions,
        }
      })
      report.lme = { sliceSha256, perType: lmePerType, maxSessions: lmeMaxSessions, sessionSampling: lmeSessionSampling, results: [] }
      save()

      process.stderr.write(`[eval][lme] running Viva (${tasks.length} items, slice=${sliceSha256.slice(0, 12)}, autoCtx=${vivaIncludeAutoContext}, sampling=${lmeSessionSampling})...\n`)
      const vivaLme = await runVivaLmeEval(llmCtx, tasks, {
        workDir: path.join(outputDir, 'viva-work', 'lme'),
        modelRoot: hasEmbedding ? modelRoot : undefined,
        runtimeRoot: hasEmbedding ? runtimeRoot : undefined,
        modeLabel: hasEmbedding
          ? (vivaIncludeAutoContext ? 'viva-hybrid-granite' : 'viva-hybrid-react-only')
          : (vivaIncludeAutoContext ? 'viva-bm25' : 'viva-bm25-react-only'),
        enableDream: true,
        includeAutoContext: vivaIncludeAutoContext,
        concurrency,
      })
      report.lme.results.push(...vivaLme)
      save()

      if (!vivaOnly) {
        process.stderr.write(`[eval][lme] running ReMe (${tasks.length} items, slice=${sliceSha256.slice(0, 12)}, dream=${remeEnableDream})...\n`)
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
            enableDream: remeEnableDream, // ReMe official LongMemEval benchmark preset leaves auto_dream disabled by default
            indexSessions: true,
            concurrency,
          },
          path.join(outputDir, 'bridge', 'lme-hybrid'),
          remeApiEnv,
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
            mode: (embeddingServer ? 'reme-lme-granite' : 'reme-lme-bm25') + (remeEnableDream ? '-dream' : ''),
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
            ...(task.evidenceTruncated ? { evidenceTruncated: true } : {}),
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
