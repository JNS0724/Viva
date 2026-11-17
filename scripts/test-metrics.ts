import fs from 'node:fs'
import path from 'node:path'

export interface MetricCase {
  name: string
  outcome: 'passed' | 'failed' | 'skipped' | 'todo'
  durationMs: number
}

export interface MetricFile {
  file: string
  wallMs: number
  caseDurationMs: number
  cases: MetricCase[]
}

export interface TestMetrics {
  schemaVersion: 1
  startedAt: string
  durationMs: number
  platform: string
  files: MetricFile[]
  totals: { files: number, cases: number, passed: number, failed: number, skipped: number, todo: number, caseDurationMs: number }
}

export function createTestMetrics(root: string, platform = process.platform) {
  const startedMs = performance.now()
  const startedAt = new Date().toISOString()
  const files = new Map<string, MetricFile>()
  function fileFor(filePath: string): MetricFile {
    const file = path.relative(root, filePath).replaceAll(path.sep, '/')
    let current = files.get(file)
    if (!current) {
      current = { file, wallMs: 0, caseDurationMs: 0, cases: [] }
      files.set(file, current)
    }
    return current
  }
  function record(filePath: string, name: string, outcome: MetricCase['outcome'], durationMs: number) {
    if (path.resolve(name) === filePath) return
    const current = fileFor(filePath)
    current.caseDurationMs += durationMs
    current.cases.push({ name, outcome, durationMs })
  }
  function completeFile(filePath: string, durationMs: number) {
    fileFor(filePath).wallMs = durationMs
  }
  function finish(): TestMetrics {
    const rows = [...files.values()].sort((a, b) => b.wallMs - a.wallMs || a.file.localeCompare(b.file))
    const cases = rows.flatMap(file => file.cases)
    return {
      schemaVersion: 1, startedAt, durationMs: performance.now() - startedMs, platform, files: rows,
      totals: {
        files: rows.length, cases: cases.length,
        passed: cases.filter(item => item.outcome === 'passed').length,
        failed: cases.filter(item => item.outcome === 'failed').length,
        skipped: cases.filter(item => item.outcome === 'skipped').length,
        todo: cases.filter(item => item.outcome === 'todo').length,
        caseDurationMs: cases.reduce((sum, item) => sum + item.durationMs, 0),
      },
    }
  }
  return { record, completeFile, finish }
}

export function metricsSummary(report: TestMetrics, limit = 20): string {
  const lines = [
    '## Test metrics', '',
    `Files: ${report.totals.files}; cases: ${report.totals.cases}; passed: ${report.totals.passed}; failed: ${report.totals.failed}; skipped: ${report.totals.skipped}; todo: ${report.totals.todo}; wall: ${(report.durationMs / 1000).toFixed(1)}s`, '',
    '| File | Wall (s) | Case duration (s) | Cases |', '| --- | ---: | ---: | ---: |',
    ...report.files.slice(0, limit).map(file => `| ${file.file} | ${(file.wallMs / 1000).toFixed(1)} | ${(file.caseDurationMs / 1000).toFixed(1)} | ${file.cases.length} |`),
  ]
  return lines.join('\n') + '\n'
}

export function writeTestMetrics(report: TestMetrics, output: string, summaryOutput?: string) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  if (summaryOutput) fs.appendFileSync(summaryOutput, metricsSummary(report))
}
