/** Measures Viva's actual DSH tool calls through backend, IPC, owner and a localhost model. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { installedDshVersion, PERSONA, resolvePlugins } from '../src/backend/app-plugins.ts'
import { DSH_PROFILE } from '../src/backend/config.ts'
import { createDesktopMemoryOwner } from '../src/backend/desktop-memory-owner.ts'
import { ensureDshProfile, vivaLayerFile } from '../src/backend/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../src/backend/dsh-runtime.ts'
import { removeTree } from '../src/backend/remove-tree.ts'
import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'
import { MEMORY_OWNER_RPC, ownerRpcFrame } from '../src/memory/contracts/owner-rpc.ts'
import { DREAM_CONSOLIDATE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { looksSecret } from '../src/memory/core/memory-sensitive.ts'
import { CODE_ROOT } from '../src/shared/node/app-roots.ts'
import { routeFixtureTools, startFakeLlm } from '../test/fixtures/fake-llm.ts'
import { prepareEmbeddingFixture } from '../test/fixtures/memory-embedding-assets.ts'
import { createVenueModelFixture, venue } from '../test/fixtures/memory-plugin-venue.ts'
import { modelToolResults } from '../test/fixtures/model-tool-results.ts'
import { testRequests } from '../test/fixtures/request-routing.ts'
import { objectOf } from '../src/shared/unknown-value.ts'

type Request = Awaited<ReturnType<typeof startFakeLlm>>['requests'][number]
type Tool = 'memory_recall' | 'memory_read' | 'memory_node_search'
type Sample = { firstModelMs: number, automaticHit: boolean, tools: { name: Tool, elapsedMs: number, status?: string, reasons: string[] }[],
  acpTools: { name: Tool, elapsedMs: number }[] }
type Trial = { prompt: string, started: number, first?: number, automaticHit: boolean, fault: boolean, measureTools: boolean,
  sent?: { name: Tool, at: number }, results: Sample['tools'], seen: Map<Tool, number>, error?: unknown,
  acpStarts: Map<string, { name: Tool, at: number }>, acpTools: Sample['acpTools'] }
const toolSequence: Tool[] = ['memory_recall', 'memory_read', 'memory_node_search', 'memory_recall']
const output = path.resolve('smoke/memory-latency.json')
function argument(name: string, fallback: number) {
  const arg = process.argv.find(value => value.startsWith('--' + name + '='))
  const number = arg ? Number(arg.slice(arg.indexOf('=') + 1)) : fallback
  assert.ok(Number.isSafeInteger(number) && number >= 1 && number <= 512, 'Invalid benchmark argument ' + name)
  return number
}
const samples = argument('samples', 24), cold = argument('cold', 12), large = argument('catalog', 96)
const target = { title: 'Quartz lighthouse maintenance', text: 'Quartz lighthouse maintenance beacon checklist requires an amber panel.' }
const query = 'quartz lighthouse maintenance beacon checklist'
assert.ok(!looksSecret(query))
function toolPayload(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return toolPayload(value.map(part => objectOf(part)?.text ?? '').join(''))
  if (typeof value === 'string') return toolPayload(JSON.parse(value))
  const record = objectOf(value)
  assert.ok(record)
  if (!record.status && typeof record.text === 'string') return toolPayload(record.text)
  return record
}
function quantiles(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b)
  const select = (p: number) => ordered.length ? Number(ordered[Math.ceil(p * ordered.length) - 1]!.toFixed(2)) : null
  return { n: ordered.length, p50Ms: select(.5), p95Ms: select(.95) }
}
function summary(rows: Sample[]) {
  const timings = (field: 'tools' | 'acpTools') => Object.fromEntries(toolSequence.map((name, index) => [
    name + (index === 3 ? '_again' : ''), quantiles(rows.flatMap(row => row[field][index] ? [row[field][index].elapsedMs] : [])),
  ]))
  return { firstModel: quantiles(rows.map(row => row.firstModelMs)), automaticHits: rows.filter(row => row.automaticHit).length,
    acpToolCallToResult: timings('acpTools'), modelToolCallToNextRequest: timings('tools'), outcomes: rows.flatMap(row => row.tools).reduce<Record<string, number>>((counts, tool) => {
        for (const key of [tool.name + ':' + (tool.status ?? 'unlabeled'), ...tool.reasons]) counts[key] = (counts[key] ?? 0) + 1
        return counts
      }, {}) }
}
async function until(condition: () => boolean | Promise<boolean>, label: string) {
  const deadline = performance.now() + 30_000
  while (!await condition()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for ' + label)
    await delay(25)
  }
}
function vectorState(root: string) {
  const db = new DatabaseSync(path.join(root, 'memory', 'memory.db'), { readOnly: true })
  try {
    const state = db.prepare("SELECT value FROM memory_file_index_meta WHERE key='vectors'").get()
    const rows = Number(db.prepare('SELECT count(*) AS n FROM memory_file_index_vectors').get()?.n)
    return { active: Boolean(state && (JSON.parse(String(state.value)) as { active: boolean }).active), rows }
  } finally { db.close() }
}

async function workload(root: string, embedding: { modelRoot: string, runtimeRoot: string }, catalog: number, background: boolean) {
  const dshHome = path.join(root, 'dsh'), memoryRoot = path.join(root, 'memory'), workspace = path.join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const { plugins } = resolvePlugins({ codeRoot: CODE_ROOT, userData: root, dshVersion: installedDshVersion(CODE_ROOT),
    memory: { ...embedding, dailyNotes: background } })
  ensureDshProfile({ dshHome, profile: DSH_PROFILE, plugins, persona: PERSONA })
  const runtime = process.versions.electron ? dshRuntime({ env: {}, execPath: process.execPath }) : { nodeBin: process.execPath, electron: false }
  let current: Trial | undefined, fileId = '', dreamStarted = false
  let releaseDream!: () => void
  const dreamGate = new Promise<void>(resolve => { releaseDream = resolve })
  const venueModel = createVenueModelFixture()
  const model = await startFakeLlm({ decideFirst: routeFixtureTools((request: Request) => {
    const fixture = venueModel.decide(request)
    if (fixture) {
      if (request.system === DREAM_CONSOLIDATE_SYSTEM || JSON.stringify(request.system).includes(DREAM_CONSOLIDATE_SYSTEM)) {
        dreamStarted = true
        return { ...fixture, waitFor: dreamGate }
      }
      return fixture
    }
    const trial = current
    if (!trial || !request.tools?.some(tool => tool.name === 'memory_recall')) return null
    if (trial.first === undefined) {
      if (!JSON.stringify(request.messages).includes(trial.prompt)) return null
      trial.first = performance.now()
      const serialized = JSON.stringify(request.messages)
      trial.automaticHit = serialized.includes('<memory-recall') && serialized.includes(target.text)
    }
    if (!trial.measureTools) return { text: 'benchmark reply' }
    if (trial.sent) {
      const { name, at } = trial.sent
      const results = modelToolResults(request, name), previous = trial.seen.get(name) ?? 0
      if (results.length <= previous) return null
      try {
        const packet = toolPayload(results.at(-1))
        trial.seen.set(name, results.length)
        trial.results.push({ name, elapsedMs: performance.now() - at, status: typeof packet.status === 'string' ? packet.status : undefined,
          reasons: Array.isArray(packet.reasons) ? packet.reasons.filter((reason): reason is string => typeof reason === 'string') : [] })
        if (trial.results.length === 1 || name === 'memory_read' || name === 'memory_node_search') {
          assert.ok(JSON.stringify(packet).includes(name === 'memory_read' ? target.text : fileId), `${name} did not return the fixed matching file`)
        }
      } catch (error) {
        trial.error = error
        return { text: 'benchmark result was invalid' }
      }
      trial.sent = undefined
    }
    const name = toolSequence[trial.results.length]
    if (!name) return { text: 'benchmark sequence complete' }
    trial.sent = { name, at: performance.now() }
    return { tool: { name, input: name === 'memory_read' ? { id: fileId } : { query: trial.fault && name === 'memory_recall' ? query + ' stop worker' : query } } }
  }) })
  let running: { bridge: ReturnType<typeof createAcpBridge>, owner: ReturnType<typeof createDesktopMemoryOwner> } | undefined
  async function stop() {
    const instance = running
    running = undefined
    if (!instance) return
    try { await instance.bridge.dispose() } finally { await instance.owner.close() }
  }
  async function launch() {
    let bypassAutomaticRecall = false
    const rawOwner = createDesktopMemoryOwner({ root: memoryRoot, embedding, dailyNotes: background }, {})
    // Benchmark-only toggle: runs the exact same known-hit query in both arms while switching automatic recall independently.
    const owner: ReturnType<typeof createDesktopMemoryOwner> = {
      ...rawOwner,
      startPrefetch(input) {
        if (bypassAutomaticRecall) return
        rawOwner.startPrefetch(input)
      },
      bindDsh(send, exited, foregroundSignal, onReady) {
        const bound = rawOwner.bindDsh(send, exited, foregroundSignal, onReady)
        return {
          ...bound,
          receive(raw) {
            if (bypassAutomaticRecall) {
              const frame = ownerRpcFrame(raw)
              if (frame?.kind === 'request' && frame.method === 'claimPrefetch') {
                send({ type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: { found: true, result: { status: 'skipped' } } })
                return true
              }
              if (frame?.kind === 'request' && frame.method === 'claimPrefetchBatch') {
                const reqs = Array.isArray(objectOf(frame.input)?.requestIds) ? (objectOf(frame.input)!.requestIds as unknown[]) : []
                send({ type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id, ok: true, result: reqs.map(() => ({ found: true, result: { status: 'skipped' } })) })
                return true
              }
            }
            return bound.receive(raw)
          },
        }
      },
    }
    const errors: string[] = []
    const bridge = createAcpBridge({
      routing: testRequests(), dshBin: path.join(CODE_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), nodeBin: runtime.nodeBin,
      profile: DSH_PROFILE, overlay: vivaLayerFile(dshHome), cwd: workspace, memoryOwner: owner,
      recordSource: async ({ session, sourceId, text, wireText, wireSpans }) => {
        if (sourceId) await owner.channel.callIntake('sourceAlias', { operationId: sourceId, sourceId, session,
          conversation: session, text, wireText, wireSpans, cwd: workspace })
      },
      env: dshEnv({ base: process.env, dshHome, runtime, settings: { DEEPSEEK_API_KEY: 'fixture-only', DEEPSEEK_BASE_URL: model.url, NO_PROXY: '127.0.0.1,localhost' } }),
      emit(event) {
        if (event.type === 'error') errors.push(String(event.message))
        const requestId = event.requestId
        if (event.type === 'permission' && typeof requestId === 'string') setImmediate(() => bridge.respondPermission(requestId, null))
        if (event.type !== 'update' || !current?.measureTools) return
        const update = objectOf(event.update)
        if (!update || typeof update.toolCallId !== 'string') return
        const { toolCallId, sessionUpdate, title } = update
        const name = toolSequence.find(tool => tool === title)
        if (sessionUpdate === 'tool_call' && name) current.acpStarts.set(toolCallId, { name, at: performance.now() })
        if (sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
          const started = current.acpStarts.get(toolCallId)
          if (!started) return
          current.acpStarts.delete(toolCallId)
          current.acpTools.push({ name: started.name, elapsedMs: performance.now() - started.at })
        }
      },
    })
    running = { bridge, owner }
    const start = performance.now()
    await owner.prepare()
    await bridge.start()
    await bridge.memory.waitReady()
    assert.ok(owner.pid() && bridge.pid() && owner.pid() !== bridge.pid())
    const startup = performance.now() - start
    async function ask(text: string) {
      const session = bridge.currentSession()
      assert.ok(session)
      const sourceId = randomUUID()
      await bridge.prompt(text, [], { sourceId, sourceText: text })
    }
    async function measure({ fault = false, skipAutomatic = false, measureTools = true } = {}) {
      const trial: Trial = { prompt: query, started: performance.now(), automaticHit: false,
        fault, measureTools, results: [], seen: new Map(), acpStarts: new Map(), acpTools: [] }
      const offset = errors.length
      current = trial
      bypassAutomaticRecall = skipAutomatic
      try { await ask(trial.prompt) } finally { bypassAutomaticRecall = false; current = undefined }
      if (trial.error) throw trial.error
      assert.ok(trial.first !== undefined, JSON.stringify(errors.slice(offset)))
      if (skipAutomatic) assert.equal(trial.automaticHit, false, 'bypass arm must not inject automatic recall')
      assert.equal(trial.results.length, measureTools ? toolSequence.length : 0, JSON.stringify(errors.slice(offset)))
      if (measureTools) assert.deepEqual(trial.acpTools.map(tool => tool.name), toolSequence, 'ACP call/result boundaries')
      assert.equal(errors.length, offset, JSON.stringify(errors.slice(offset)))
      return { firstModelMs: trial.first - trial.started, automaticHit: trial.automaticHit, tools: trial.results, acpTools: trial.acpTools }
    }
    return { bridge, ask, measure, startup }
  }
  try {
    let run = await launch()
    fileId = (await run.bridge.memory.call('createFile', { args: [{ operationId: randomUUID(), ...target }] })).identity.id
    for (let index = 1; index < catalog; index++) {
      await run.bridge.memory.call('createFile', { args: [{ operationId: randomUUID(), title: 'Unrelated tide catalog ' + index,
        text: 'Harbor tides and maps. '.repeat(12) + 'Volume ' + index + '.' }] })
    }
    await until(() => { const state = vectorState(root); return state.active && state.rows >= catalog }, 'published vector index')
    const coldSamples = [], coldOn = [], coldOff = [], coldDeltas = [], startup = []
    for (let index = 0; index < cold; index++) {
      await stop()
      run = await launch()
      startup.push(run.startup)
      coldSamples.push(await run.measure())
      const coldPaired = new Map<boolean, Sample>()
      for (const skipAutomatic of index % 2 ? [true, false] : [false, true]) {
        await stop()
        run = await launch()
        coldPaired.set(skipAutomatic, await run.measure({ skipAutomatic, measureTools: false }))
      }
      const cEnabled = coldPaired.get(false)!, cBypass = coldPaired.get(true)!
      coldOn.push(cEnabled); coldOff.push(cBypass); coldDeltas.push(cEnabled.firstModelMs - cBypass.firstModelMs)
    }
    const warm = [], on = [], off = [], deltas = []
    for (let index = 0; index < samples; index++) {
      await run.bridge.newSession()
      warm.push(await run.measure())
      const paired = new Map<boolean, Sample>()
      for (const skipAutomatic of index % 2 ? [true, false] : [false, true]) {
        await run.bridge.newSession()
        paired.set(skipAutomatic, await run.measure({ skipAutomatic, measureTools: false }))
      }
      const enabled = paired.get(false)!, bypass = paired.get(true)!
      on.push(enabled); off.push(bypass); deltas.push(enabled.firstModelMs - bypass.firstModelMs)
    }
    const dream = []
    if (background) {
      await run.bridge.newSession()
      for (const fact of venue.facts) await run.ask(fact)
      await until(async () => {
        const page = await run.bridge.memory.call('listFiles', { args: [{ kind: 'daily', limit: 100 }] })
        for (const note of page.items) {
          const detail = await run.bridge.memory.call('readFile', { args: [note.identity] })
          if (venue.facts.every(fact => detail?.markdown.includes(fact))) return true
        }
        return false
      }, 'published Dream input')
      await run.bridge.memory.call('requestDream', { args: [randomUUID()] })
      await until(async () => dreamStarted && (await run.bridge.memory.call('dreamStatus', { args: [] })).state === 'running', 'held Dream model response')
      for (let index = 0; index < samples; index++) {
        await run.bridge.newSession()
        dream.push(await run.measure())
      }
      assert.equal((await run.bridge.memory.call('dreamStatus', { args: [] })).state, 'running')
      releaseDream()
      await until(async () => (await run.bridge.memory.call('dreamStatus', { args: [] })).lastCheckResult === 'processed', 'Dream checkpoint')
    }
    await run.bridge.newSession()
    const firstVectorFault = await run.measure({ fault: true })
    assert.ok(firstVectorFault.tools[0]?.reasons.includes('semantic-unavailable'))
    const fault = []
    for (let index = 0; index < samples; index++) {
      await run.bridge.newSession()
      fault.push(await run.measure({ fault: true }))
    }
    return { catalog, vectors: vectorState(root), startup: quantiles(startup), cold: summary(coldSamples), warm: summary(warm),
      coldAutomatic: { actual: summary(coldOn).firstModel, shortCircuit: summary(coldOff).firstModel, pairedDifference: quantiles(coldDeltas), evidenceHits: coldOn.filter(row => row.automaticHit).length, total: coldOn.length },
      automatic: { actual: summary(on).firstModel, shortCircuit: summary(off).firstModel, pairedDifference: quantiles(deltas), evidenceHits: on.filter(row => row.automaticHit).length, total: on.length },
      dream: dream.length ? summary(dream) : null, firstVectorFault, vectorFaultCooldown: summary(fault) }
  } finally {
    releaseDream()
    try { await stop() } finally { await model.close() }
  }
}

const root = await mkdtemp(path.join(tmpdir(), 'viva-memory-latency-'))
try {
  const embedding = await prepareEmbeddingFixture(path.join(root, 'embedding'))
  const results = []
  for (const catalog of new Set([8, large])) {
    console.error('Measuring ' + catalog + ' documents')
    results.push(await workload(path.join(root, String(catalog)), embedding, catalog, catalog === large))
  }
  const result = { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, versions: { node: process.version, electron: process.versions.electron },
    budgetMs: { automatic: DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs, recallP95: 300, readP95: 100 }, samples, cold, results }
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { removeTree(root) }
