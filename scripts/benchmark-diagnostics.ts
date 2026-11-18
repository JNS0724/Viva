// Fixed local five-read workload. This measures diagnostics overhead, not model/network latency.
import { diagnosticLatencyBudget, healthyDiagnosticSample, reportInteractionReview } from './diagnostic-performance-budget.ts'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { createNodeDiagnostics } from '../src/diagnostics/node/logger.ts'
import { installDiagnosticPort, withOperation } from '../src/diagnostics/node/context.ts'
import { NO_DIAGNOSTICS } from '../src/diagnostics/contracts.ts'
import type { DiagnosticStage } from '../src/diagnostics/contracts.ts'

const directory = await mkdtemp(path.join(tmpdir(), 'viva-diagnostics-benchmark-'))
const stages: DiagnosticStage[] = ['profile', 'onboarding', 'cleanup', 'revision', 'file-profile']
const fixture = path.join(directory, 'profile.json')
const payload = JSON.stringify(Array.from({ length: 512 }, (_, index) => ({ id: index, revision: 1, enabled: true, text: 'fixed local benchmark fixture '.repeat(4) })))
await writeFile(fixture, payload)
const logger = createNodeDiagnostics({ directory: path.join(directory, 'logs'), component: 'backend', version: '0.4.0' })
await logger.ready
const lag = monitorEventLoopDelay({ resolution: 10 })
lag.enable()
type Mode = 'baseline' | 'noop' | 'logging'
const samples: Record<Mode, number[]> = { baseline: [], noop: [], logging: [] }
const cpu: Record<Mode, number> = { baseline: 0, noop: 0, logging: 0 }
const intervalMs = process.argv.includes('--saturated') ? 0 : 20
async function work(mode: Mode) {
  const instrumented = mode !== 'baseline'
  const run = <T>(operation: () => T, stage?: DiagnosticStage) => instrumented
    ? withOperation('memory.get', operation, stage ? { stage } : {}) : operation()
  return run(async () => {
    let count = 0
    for (const stage of stages) count += await run(async () => {
      const records = JSON.parse(await readFile(fixture, 'utf8')) as Array<{ enabled: boolean; revision: number }>
      return records.filter(record => record.enabled && record.revision > 0).length
    }, stage)
    return count
  })
}
try {
  for (const mode of ['baseline', 'noop', 'logging'] as const) {
    const restore = installDiagnosticPort(mode === 'logging' ? logger : NO_DIAGNOSTICS)
    for (let i = 0; i < 30; i++) { await work(mode); if (intervalMs) await delay(intervalMs) }
    restore()
  }
  // Alternate rounds to limit warm-cache and scheduling bias. No artificial sleeps or model delay.
  for (let round = 0; round < 10; round++) for (const mode of (round % 2 ? ['logging', 'noop', 'baseline'] : ['baseline', 'noop', 'logging']) as Mode[]) {
    const restore = installDiagnosticPort(mode === 'logging' ? logger : NO_DIAGNOSTICS)
    const startedCpu = process.cpuUsage()
    for (let i = 0; i < 50; i++) {
      const start = performance.now()
      if (await work(mode) !== 512 * 5) throw new Error('Benchmark business output changed')
      samples[mode].push(performance.now() - start)
      if (intervalMs) await delay(intervalMs)
    }
    const used = process.cpuUsage(startedCpu)
    cpu[mode] += used.user + used.system
    restore()
  }
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!
  const base = p95(samples.baseline), enabled = p95(samples.logging)
  const budget = diagnosticLatencyBudget(base, enabled)
  reportInteractionReview('diagnostic framework', budget)
  const { deltaMs, deltaPercent, originalTarget, acceptableLatency, reviewInteraction } = budget
  await logger.close()
  const stats = logger.snapshot().stats
  const passed = acceptableLatency && healthyDiagnosticSample(stats)
  console.log(JSON.stringify({ platform: process.platform, node: process.version, samplesPerMode: samples.baseline.length, intervalMs,
    fixtureBytes: Buffer.byteLength(payload), readsPerRequest: 5, p95Ms: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, p95(values)])),
    deltaMs, deltaPercent, cpuMs: Object.fromEntries(Object.entries(cpu).map(([key, value]) => [key, value / 1000])),
    emittedEvents: (samples.logging.length + 30) * 12, eventLoopP95Ms: lag.percentile(95) / 1e6,
    stats, meetsOriginalLatencyTarget: originalTarget, acceptableLatency, reviewInteraction, meetsDefaultLatencyGate: passed, workload: intervalMs ? 'paced' : 'saturated' }, null, 2))
  if (intervalMs && !passed) process.exitCode = 1
} finally {
  lag.disable()
  await logger.close()
  await rm(directory, { recursive: true, force: true })
}
