/** Local product boundaries with deterministic model replies; no provider latency is added to the baseline. */
import { diagnosticLatencyBudget, healthyDiagnosticSample, reportInteractionReview } from './diagnostic-performance-budget.ts'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createNodeDiagnostics } from '../src/diagnostics/node/logger.ts'
import { diagnosticPort, installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import { NO_DIAGNOSTICS } from '../src/diagnostics/contracts.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { openAppDb } from '../src/backend/app-db.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createTaskStore } from '../src/backend/task-store.ts'
import { createTaskRuntime } from '../src/backend/task-runtime.ts'
import { createScheduleRuns } from '../src/backend/schedule-runs.ts'
import { openScheduleStore } from '../src/backend/schedule-store.ts'
import { openFeedStore } from '../src/backend/feed-store.ts'
import { createAcpOperations } from '../src/backend/acp-operations.ts'
import { createAssistantStream } from '../src/backend/assistant-stream.ts'
import { openMemoryFileIndex } from '../src/memory/node/memory-file-index.ts'
import { createMemoryFileRetrieval } from '../src/memory/core/memory-file-retrieval.ts'
import type { MemoryDocumentView } from '../src/memory/core/memory-document-read-policy.ts'

const root = await mkdtemp(path.join(tmpdir(), 'viva-diagnostic-flows-'))
const writer = createNodeDiagnostics({ directory: path.join(root, 'logs'), component: 'backend' })
const app = openAppDb({ file: path.join(root, 'main.db') })
const db = app.db, history = openHistoryDb({ db }), current = history.create({ sessionId: 'main', cwd: root })
const events = createEventCore({ app, publish() {} })
const tasks = createTaskRuntime({ db: history, store: createTaskStore({ db }), current: () => current,
  apply: (kind, data, write) => events.apply(kind, data, write), agentInfo: () => ({ mode: 'live' }),
  agent: { startTask: () => ({ ok: true, taskId: randomUUID() }), promptTask() {}, closeTask() {}, cancelTask() {},
    steerTask: () => ({ ok: true }), resumeTask: () => ({ ok: true }) } })
let now = Date.UTC(2026, 0, 1), delivered = () => {}
const store = openScheduleStore({ db, now: () => now }), feed = openFeedStore({ db })
const schedules = createScheduleRuns({ db, store, feed, apply: (kind, data, write) => events.apply(kind, data, write), now: () => now, later: () => null, cancel() {},
  run: async () => ({ ok: true, text: 'done' }), keep() {}, delivered: () => delivered() })
const streams = createAssistantStream({ emit() {}, send(raw) {
  const { type, operation } = raw as { type: string, operation: string }
  if (type === 'assistant_stream_bind') streams.receive({ type: 'assistant_stream_bound', version: 1, operation })
  if (type === 'assistant_stream_flush') streams.receive({ type: 'assistant_stream_flushed', version: 1, operation, messages: [], finalReply: false })
} })
streams.receive({ type: 'assistant_stream_ready', version: 1 })
const operations = createAcpOperations({ streams, connection: () => ({ prompt: async () => ({ stopReason: 'end_turn' }), cancel: async () => {} }),
  cancelPermissions() {}, streamUpdate() {} })
const hash = (data: string) => createHash('sha256').update(data).digest('hex')
const workspace = hash('workspace')
const docs: MemoryDocumentView[] = Array.from({ length: 32 }, (_, i) => {
  const markdown = '---\nname: Reference ' + i + '\ndescription: search fixture\n---\nrelease notes'
  return { id: String(i), workspace, kind: 'digest', path: 'digest/wiki/' + i + '.md', revision: hash(markdown),
    usageVersion: 1, policyToken: hash(markdown), updatedAt: 1, markdown, currentMarkdown: markdown, sources: [],
    sourceTokens: [{ id: 'source-' + i, token: '1' }], backing: null, supporting: [], applicability: { state: 'current', supersessions: [] } }
})
const retrieval = createMemoryFileRetrieval({ index: openMemoryFileIndex({ db }), hash, workspaces: () => [workspace],
  policy: { list: () => docs, read: (_, name) => docs.find(doc => doc.path === name) ?? null }, diagnostics: diagnosticPort })
type Mode = 'enabled' | 'disabled'
let measuredMode: Mode | undefined
const phaseTimes = { launch: { enabled: [] as number[], disabled: [] as number[] }, finish: { enabled: [] as number[], disabled: [] as number[] } }
const flows = {
  async conversation() {
    let ended = false
    await operations.run({ sessionId: 'foreground', prompt: [{ type: 'text', text: 'hello' }],
      onEnd: response => { ended = response.stopReason === 'end_turn' }, onError: error => { throw error } })
    assert.ok(ended)
  },
  async task() {
    const start = performance.now()
    const task = await tasks.agent.start('prepare summary')
    const launched = performance.now()
    if (measuredMode) phaseTimes.launch[measuredMode].push(launched - start)
    tasks.dsh.receive({ type: 'task_end', taskId: task.taskId, stopReason: 'end_turn' })
    assert.ok(tasks.window.finished().some(item => item.task.id === task.taskId && item.status === 'done'))
    await tasks.window.close(task.taskId)
    if (measuredMode) phaseTimes.finish[measuredMode].push(performance.now() - launched)
  },
  async schedule() {
    const due = now + 60_000
    store.create({ title: 'summary', prompt: 'prepare summary', cwd: root, rule: { kind: 'at', at: new Date(due).toISOString() } })
    now = due
    const result = new Promise<void>(resolve => { delivered = resolve })
    schedules.wake()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([result, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('schedule did not deliver')), 3000) })]) }
    finally { clearTimeout(timer) }
  },
  async recall() {
    const result = await retrieval.search({ query: 'release notes', allows: () => true })
    assert.ok(result.hits.length)
  },
}
const p95 = (samples: number[]) => samples.sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1]!
const results = []
try {
  await writer.ready
  for (const [name, work] of Object.entries(flows)) {
    const times = { disabled: [] as number[], enabled: [] as number[] }
    // Disk-backed task start/end/close samples include checkpoint jitter; retain a larger tail.
    const samplesPerMode = name === 'task' ? 300 : 100
    for (let round = 0; round < samplesPerMode + 2; round++) {
      for (const enabled of round % 2 ? [true, false] : [false, true]) {
        measuredMode = round < 2 ? undefined : enabled ? 'enabled' : 'disabled'
        const restore = installDiagnosticPort(enabled ? writer : NO_DIAGNOSTICS)
        try {
          const start = performance.now()
          await work()
          if (round >= 2) times[enabled ? 'enabled' : 'disabled'].push(performance.now() - start)
        } finally { restore() }
        await delay(20)
      }
    }
    const disabled = p95(times.disabled), enabled = p95(times.enabled)
    const budget = diagnosticLatencyBudget(disabled, enabled)
    reportInteractionReview(name, budget)
    results.push({ name, samplesPerMode, disabled, enabled, ...budget })
  }
  assert.equal(await writer.close(), true)
  const taskPhases = Object.fromEntries(Object.entries(phaseTimes).map(([phase, samples]) =>
    [phase, { disabled: p95(samples.disabled), enabled: p95(samples.enabled) }]))
  const stats = writer.snapshot().stats
  console.log(JSON.stringify({ platform: process.platform, results, taskPhases, stats }, null, 2))
  if (results.some(result => !result.acceptableLatency) || !healthyDiagnosticSample(stats)) process.exitCode = 1
} finally {
  operations.dispose(); schedules.close(); tasks.dispose(); retrieval.close(); app.close()
  await writer.close()
  await rm(root, { recursive: true, force: true })
}
