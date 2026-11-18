/** Real memory:get: production HTTP -> IPC channel -> independent Node owner and SQLite/file reads. */
import { diagnosticLatencyBudget, healthyDiagnosticSample, reportInteractionReview } from './diagnostic-performance-budget.ts'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createNodeDiagnostics } from '../src/diagnostics/node/logger.ts'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import { NO_DIAGNOSTICS } from '../src/diagnostics/contracts.ts'
import { createRemoteMemoryChannel } from '../src/backend/remote-memory-channel.ts'
import { createVivaMemoryClient } from '../src/backend/memory-client.ts'
import { registerRuntimeMemoryIpc } from '../src/backend/memory-ipc.ts'
import { createRpcServer } from '../src/backend/rpc-server.ts'
import type { ChannelListener } from '../src/backend/rpc-server.ts'
import { createRemoteHost } from '../src/backend/remote-host.ts'
import { createEnvelope } from '../src/backend/envelope.ts'
import { connect } from '../src/shell/backend-client.ts'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import { START } from '../test/fixtures/backend-wire.ts'

const root = await mkdtemp(path.join(tmpdir(), 'viva-memory-diagnostic-benchmark-'))
const contextOnly = process.argv.includes('--context-only')
const contextOnlyPort = { emit: () => undefined }
const logger = createNodeDiagnostics({ directory: path.join(root, 'diagnostics'), component: 'backend', version: '0.4.0' })
const child = fork(fileURLToPath(new URL('../test/fixtures/diagnostic-memory-owner.ts', import.meta.url)), [root], {
  execPath: process.execPath, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
})
let ready!: () => void, rejectReady!: (error: Error) => void
const started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject })
let changedMode: ((value: { stats: unknown; cpu: NodeJS.CpuUsage }) => void) | undefined
const channel = createRemoteMemoryChannel({ send: message => child.send(message) })
const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
child.once('error', rejectReady)
child.on('message', (raw: unknown) => {
  channel.receive(raw)
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return
  if (raw.type === 'memory_owner_state') ready()
  if (raw.type === 'benchmark.mode' && 'stats' in raw && 'cpu' in raw) {
    const cpu = raw.cpu
    if (cpu && typeof cpu === 'object' && 'user' in cpu && 'system' in cpu && typeof cpu.user === 'number' && typeof cpu.system === 'number') changedMode?.({ stats: raw.stats, cpu: { user: cpu.user, system: cpu.system } })
  }
})
function mode(enabled: boolean): Promise<{ stats: unknown; cpu: NodeJS.CpuUsage }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Benchmark owner mode deadline')), 5000)
    changedMode = value => { clearTimeout(timeout); changedMode = undefined; resolve(value) }
    installDiagnosticPort(enabled ? contextOnly ? contextOnlyPort : logger : NO_DIAGNOSTICS)
    child.send({ type: 'benchmark.mode', enabled, contextOnly })
  })
}
const handlers = new Map<string, { kind: 'handle' | 'on'; listener: ChannelListener }>()
registerRuntimeMemoryIpc(checkedIpc({ handle: (key, listener) => { handlers.set(key, { kind: 'handle', listener }) }, on() {} }), {
  client: createVivaMemoryClient(channel.call, channel.readBatch), cwd: () => '', habits: () => ({ text: '', samples: 0 }), chooseDocs: async () => null,
})
const remote = createRemoteHost({ start: START, secrets: createEnvelope({ key: randomBytes(32) }) })
const token = randomBytes(32).toString('hex')
const server = createRpcServer({ token, channels: handlers, controls: {}, remote, since: () => [], image: () => new Response(null, { status: 404 }) })
const samples = { disabled: [] as number[], enabled: [] as number[] }
const mainCpu = { disabled: 0, enabled: 0 }, ownerCpu = { disabled: 0, enabled: 0 }
const intervalMs = process.argv.includes('--saturated') ? 0 : 20
let ownerStats: unknown, expected: string | undefined
let startupTimer: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([started, new Promise<never>((_resolve, reject) => { startupTimer = setTimeout(() => reject(new Error('Benchmark owner startup deadline')), 30_000) })])
  clearTimeout(startupTimer)
  const connection = connect({ port: await server.listen(), token })
  await logger.ready
  for (const enabled of [false, true]) {
    await mode(enabled)
    for (let i = 0; i < 15; i++) { await connection.rpc('memory:get', []); if (intervalMs) await delay(intervalMs) }
  }
  for (let round = 0; round < 100; round++) for (const enabled of (round % 2 ? [true, false] : [false, true])) {
    const key = enabled ? 'enabled' : 'disabled'
    const before = await mode(enabled), cpu = process.cpuUsage()
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      const result = await connection.rpc('memory:get', [])
      samples[key].push(performance.now() - start)
      const encoded = JSON.stringify(result)
      expected ??= encoded
      if (encoded !== expected) throw new Error('Diagnostics changed memory:get output')
      if (intervalMs) await delay(intervalMs)
    }
    const after = await mode(enabled), used = process.cpuUsage(cpu)
    mainCpu[key] += used.user + used.system
    ownerCpu[key] += after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system
    ownerStats = after.stats
  }
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!
  const disabled = p95(samples.disabled), enabled = p95(samples.enabled)
  const budget = diagnosticLatencyBudget(disabled, enabled)
  reportInteractionReview('memory:get', budget)
  const { deltaMs, deltaPercent, originalTarget, acceptableLatency, reviewInteraction } = budget
  const mainStats = logger.snapshot().stats
  const healthy = healthyDiagnosticSample(mainStats) && healthyDiagnosticSample(ownerStats)
  const passed = acceptableLatency && healthy
  console.log(JSON.stringify({ platform: process.platform, node: process.version, workload: 'production-memory-get-empty-owner', intervalMs, contextOnly,
    samplesPerMode: samples.enabled.length, rounds: 100, requestsPerModePerRound: 5, p95Ms: { disabled, enabled }, deltaMs, deltaPercent, meetsOriginalLatencyTarget: originalTarget, acceptableLatency, reviewInteraction, healthy, meetsDefaultLatencyGate: passed,
    mainCpuMs: Object.fromEntries(Object.entries(mainCpu).map(([key, value]) => [key, value / 1000])),
    ownerCpuMs: Object.fromEntries(Object.entries(ownerCpu).map(([key, value]) => [key, value / 1000])), mainStats, ownerStats }, null, 2))
  if (intervalMs && !passed) process.exitCode = 1
} finally {
  clearTimeout(startupTimer)
  channel.close()
  await server.close()
  child.send({ type: 'benchmark.close' })
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
  await logger.close()
  await rm(root, { recursive: true, force: true })
}
