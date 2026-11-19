import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'
import { MemoryComputeError } from '../src/memory/contracts/compute.ts'
import type { DiagnosticEvent, DiagnosticPort } from '../src/diagnostics/contracts.ts'
import { createMemoryDreamJobs, batchDreamNotes } from '../src/memory/core/memory-dream-jobs.ts'
import type { DreamCalculate } from '../src/memory/core/memory-dream-jobs.ts'
import { validateDreamReview } from '../src/memory/core/memory-dream-evidence.ts'
import { inspectMemoryDocumentText } from '../src/memory/core/memory-dream-material.ts'
import { formatMemoryDocument, updateMemoryFrontmatter } from '../src/memory/core/memory-document.ts'
import { looksSecret } from '../src/memory/core/memory-sensitive.ts'
import { createEffects } from '../src/memory/node/effects.ts'
import { createMemorySendFence } from '../src/memory/core/send-fence.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { openMemoryStore, memoryHash } from '../src/memory/node/memory-store.ts'
import type { DocumentReceipt } from '../src/memory/core/ports/documents.ts'
import type { MemorySource } from '../src/memory/core/ports/store.ts'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { dreamModelStep } from './fixtures/dream-model.ts'

function harness(t: TestContext, options: { units?: number, budget?: number, checkpoint?: Parameters<typeof openMemoryDocuments>[0]['checkpoint'], diagnostics?: DiagnosticPort,
  mutate?: <T>(work: () => T) => Promise<T>, eligible?: () => boolean } = {}) {
  let now = Date.parse('2026-11-16T12:00:00Z')
  const store = openMemoryStore(':memory:', () => now)
  const readable = (id: string) => Boolean(store.readSource(id)?.text && !store.readSource(id)?.withdrawn)
  const notes = openMemoryNotes(store, readable)
  const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, now: () => now, checkpoint: options.checkpoint,
    source(id) {
      const original = store.readSource(id)
      return original?.text && readable(id) ? { token: memorySourceToken(original), workspace: memorySourceWorkspace(original), text: original.text } : undefined
    },
  })
  let effects = createEffects({ db: store.db, now: () => now, later: () => null, cancel: () => {} })
  const requests: Parameters<DreamCalculate>[0][] = []
  let fixtureOptions: Parameters<typeof dreamModelStep>[2] = {}
  const defaultModel: DreamCalculate = async request => {
    const job: MemoryCompute = { id: randomUUID(), sourceId: request.sourceIds()[0]!, stage: 'dream', generation: request.job.generation,
      provider: 'fixture', model: 'fixture', system: request.system, input: JSON.stringify(request.input) }
    return dreamModelStep(job, request.tools, fixtureOptions)
  }
  let model: DreamCalculate = defaultModel
  let beforeMutation = () => {}
  let afterCommit: (receipt: DocumentReceipt) => void = () => {}
  const start = () => createMemoryDreamJobs({ store, notes, documents, effects, identity: { newId: randomUUID, hash: memoryHash }, now: () => now,
    diagnostics: options.diagnostics,
    settings: { timezone: 'UTC', dreamUnits: options.units ?? 5, dreamBatchBytes: options.budget ?? 40_000 },
    readable, eligible: options.eligible ?? (() => true), source: id => store.readSource(id) ?? undefined,
    reference: id => { const original = store.readSource(id); return original ? { namespace: 'canonical', sourceId: id, revision: original.version } : null },
    transaction: store.tx, mutate: options.mutate ?? (async work => { beforeMutation(); return work() }), committed: receipt => afterCommit(receipt),
    allowsText: text => !looksSecret(text),
    calculate: async request => { requests.push(request); assert.equal(request.current(), true); return model(request) },
  })
  let jobs = start()
  t.after(() => { effects.close(); store.close() })
  const addSource = (text: string, props: Partial<MemorySource> = {}) => noteSource(store, {
    text, hash: memoryHash(text), length: text.length, at: now, timezone: 'UTC', ...props,
  })
  const add = (text: string, title = 'Report', props: Partial<MemorySource> = {}, spans?: Array<{ start: number, end: number }>) => {
    const original = addSource(text, { session: randomUUID(), ...props })
    const key = notes.add(original.session!, '2026-11-16', [original], '')!
    assert(notes.commit(key, notes.pending(key), { status: 'write', title, markdown: text }, 1, now, notes.snapshot([original.id]).map(ref => spans ? { ...ref, spans } : ref), undefined))
    return { source: original, key, note: notes.read(key)! }
  }
  const seedDigest = (note: ReturnType<typeof add>['note'], name = 'Report') =>
    documents.commit({ operationId: randomUUID(), workspace: note.workspace, path: `digest/personal/${name}.md`, action: 'CREATE', expectedRevision: null,
      markdown: formatMemoryDocument({ metadata: { name, description: 'Original arrangement' }, body: 'Original arrangement.' }),
      sources: notes.references(note.key), reads: [] })
  const run = async () => { jobs.run(); await effects.wake() }
  return { store, notes, documents, requests, addSource, add, seedDigest, run, defaultModel,
    status: () => jobs.status(), request: (operationId?: string) => jobs.request(operationId), settle: () => effects.wake(),
    setFixture(options: Parameters<typeof dreamModelStep>[2]) { fixtureOptions = options },
    setModel(next: DreamCalculate) { model = next },
    beforeMutation(next: () => void) { beforeMutation = next }, afterCommit(next: (receipt: DocumentReceipt) => void) { afterCommit = next },
    advance(ms: number) { now += ms },
    replaceGeneration() { effects.queue('memory.dream', 'daily', null, now + 60_000) },
    async retry() { now += 60_000; await effects.wake() },
    restart() { effects.close(); effects = createEffects({ db: store.db, now: () => now, later: () => null, cancel: () => {} }); jobs = start() },
    sourceRef: (original: MemorySource) => ({ id: original.id, token: memorySourceToken(original) }),
  }
}

test('manual Dream acknowledges immediately, joins the scheduled job and keeps actual processing time across empty checks and restart', async t => {
  const h = harness(t)
  assert.deepEqual(h.status(), { state: 'idle', lastCheckResult: null, lastCheckedAt: null, lastProcessedAt: null })
  h.add('The team files reports every Friday.')
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  h.setModel(async request => {
    if (request.stage === 'extract') { entered(); await gate }
    return h.defaultModel(request)
  })
  const operationId = randomUUID(), joined = randomUUID()
  const queued = h.request(operationId)
  assert.equal(queued.state, 'queued')
  assert.equal(queued.jobId, operationId)
  assert.equal(h.request(joined).jobId, operationId)
  await started
  assert.equal(h.request().state, 'running')
  release()
  await h.settle()
  const done = h.status()
  assert.equal(done.state, 'idle')
  assert.ok(done.lastProcessedAt)
  assert.equal(done.lastCheckedAt, done.lastProcessedAt)
  assert.equal(h.requests.filter(request => request.stage === 'extract').length, 1)
  h.advance(60_000)
  h.request()
  await h.settle()
  h.restart()
  assert.deepEqual(h.status(), { state: 'idle', lastCheckResult: 'empty', lastCheckedAt: done.lastProcessedAt + 60_000, lastProcessedAt: done.lastProcessedAt })
  const retried = h.request(operationId)
  assert.deepEqual(retried, { ...done, jobId: operationId, completedAt: done.lastCheckedAt })
  assert.deepEqual(h.request(joined), retried)
  assert.equal(h.status().state, 'idle')
})

test('an oversized singleton is recorded as skipped without moving the last processing time', async t => {
  const h = harness(t)
  h.add('A very large note.')
  h.setModel(async () => { throw new MemoryComputeError('context-window-exceeded') })
  h.request()
  await h.settle()
  h.restart()
  assert.equal(h.status().lastCheckResult, 'size-limit')
  assert.ok(h.status().lastCheckedAt)
  assert.equal(h.status().lastProcessedAt, null)
})

test('a failed Dream stays retryable and leaves the last successful check untouched', async t => {
  const h = harness(t)
  h.add('Remember the report.')
  h.setModel(async () => { throw new MemoryComputeError('timeout') })
  h.request()
  await h.settle()
  assert.deepEqual(h.status(), { state: 'retry', lastCheckResult: null, lastCheckedAt: null, lastProcessedAt: null })
  h.restart()
  assert.equal(h.status().state, 'retry')
  h.setModel(h.defaultModel)
  assert.equal(h.request().state, 'queued')
  await h.settle()
  assert.ok(h.status().lastProcessedAt)
})

test('dream diagnostics distinguish invalid model output, provider failures and retries without changing recovery', async t => {
  const events: DiagnosticEvent[] = []
  const h = harness(t, { diagnostics: { emit(event) { events.push(event); return undefined } } })
  const first = h.add('The report is due Friday.')
  h.setModel(async () => '{SECRET_INVALID_JSON')
  await h.run()
  assert.equal(events.filter(event => event.reason === 'validation_failed' && event.stage === 'extract').length, 2)
  assert.ok(events.some(event => event.reason === 'retry'))
  events.length = 0
  h.setModel(async () => { throw new MemoryComputeError('timeout') })
  await h.retry()
  assert.ok(events.some(event => event.reason === 'timeout' && event.stage === 'extract'))
  h.setModel(h.defaultModel)
  await h.retry()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(JSON.stringify(events).includes('SECRET_INVALID_JSON'), false)
})

test('timeout on a later batch defers remaining batches and workspaces without losing the successful extraction', async t => {
  const h = harness(t, { budget: 1 })
  h.add('One'); h.add('Two'); h.add('Three')
  h.add('Another workspace', 'Independent', { project: { kind: 'project', id: 'other' } })
  let calls = 0
  const notes: string[] = []
  h.setModel(async request => {
    assert.equal(request.stage, 'extract')
    const batch = request.input as { notes: Array<{ path: string }> }
    notes.push(...batch.notes.map(note => note.path))
    if (++calls === 2) throw new MemoryComputeError('timeout')
    return '{"units":[]}'
  })
  await h.run()
  assert.equal(calls, 2)
  await h.retry(); await h.retry()
  assert.equal(calls, 5)
  assert.equal(new Set(notes).size, 4)
  assert.equal(h.notes.changed('2026-11-16', '2026-11-16').length, 0)
})

for (const reason of ['error', 'call-failed', 'timeout', 'max-tokens'] as const) {
  test(`extract stops after one failed multi-note request for ${reason}`, async t => {
    const h = harness(t)
    h.add('One'); h.add('Two')
    h.add('Another workspace', 'Three', { project: { kind: 'project', id: 'other' } })
    h.setModel(async () => { throw new MemoryComputeError(reason) })
    await h.run()
    assert.equal(h.requests.length, 1)
    assert.equal(h.notes.changed('2026-11-16', '2026-11-16').length, 3)
    h.restart()
    h.setModel(async () => '{"units":[]}')
    await h.retry()
    assert.equal(h.requests.length, 3)
    assert.equal(h.notes.changed('2026-11-16', '2026-11-16').length, 0)
  })
}

test('extract splits before the provider when the actual JSON exceeds the batch byte budget', async t => {
  const budget = 600, h = harness(t, { budget })
  const first = h.add('Plan', 'First'), second = h.add('Plan', 'Second')
  assert.ok(Buffer.byteLength(first.note.document + second.note.document) <= budget)
  const sizes: number[] = []
  h.setModel(async request => {
    const input = request.input as { notes: unknown[] }
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= budget)
    sizes.push(input.notes.length)
    return '{"units":[]}'
  })
  await h.run()
  assert.deepEqual(sizes, [1, 1])
  assert.equal(h.notes.changed(first.note.day, first.note.day).length, 0)
})

test('a large single note still reaches the provider once with the truncated markdown', async t => {
  const h = harness(t, { budget: 100 })
  const entry = h.add('🌿'.repeat(61_000))
  h.setModel(async request => {
    const [note] = (request.input as { notes: Array<{ markdown: string }> }).notes
    assert.ok(note!.markdown.endsWith('[truncated]'))
    return '{"units":[]}'
  })
  await h.run()
  assert.equal(h.requests.length, 1)
  assert.equal(h.notes.read(entry.key)?.processed, entry.note.revision)
})

test('explicit context overflow splits batches and checkpoints an oversized singleton until its revision changes', async t => {
  const h = harness(t)
  const bad = h.add('Oversized'); h.add('Second'); h.add('Third')
  const sizes: number[] = []
  h.setModel(async request => {
    assert.equal(request.stage, 'extract')
    const batch = (request.input as { notes: Array<{ path: string }> }).notes
    sizes.push(batch.length)
    if (batch.length > 1 || batch[0]!.path === bad.note.path) throw new MemoryComputeError('context-window-exceeded')
    return '{"units":[]}'
  })
  await h.run()
  assert.deepEqual(sizes, [3, 1, 2, 1, 1])
  assert.equal(h.notes.changed('2026-11-16', '2026-11-16').length, 0)
  h.restart()
  await h.retry()
  await h.run()
  assert.equal(h.requests.length, 5)
  const extra = h.addSource('Revised note', { session: bad.source.session })
  h.notes.add(bad.source.session!, bad.note.day, [extra], '')
  const rows = h.notes.pending(bad.key)
  h.notes.commit(bad.key, rows, { status: 'write', title: 'Revised', markdown: 'Now fits.' }, 2,
    Date.now(), h.notes.snapshot([bad.source.id, extra.id]), h.notes.read(bad.key))
  h.setModel(async () => '{"units":[]}')
  await h.run()
  assert.equal(h.requests.length, 6)
  assert.equal(h.notes.read(bad.key)?.processed, h.notes.read(bad.key)?.revision)
})

for (const stage of ['integrate', 'verify'] as const) {
  test(`Dream pauses when ${stage} times out and resumes only pending units and tags after restart`, async t => {
    const events: DiagnosticEvent[] = []
    const h = harness(t, { diagnostics: { emit(event) { events.push(event); return undefined } } })
    const names = ['Alpha', 'Beta', 'Gamma']
    const inputs = names.map(name => h.add(`${name} report arrangement.`, name))
    inputs.forEach(({ note }, i) => h.seedDigest(note, names[i]))
    let calls = 0
    h.setModel(async request => {
      if (request.stage === 'extract') {
        return JSON.stringify({ units: inputs.map(({ note }, i) => ({
          name: names[i], summary: 'Recurring report arrangement', bucket: 'personal', paths: [note.path],
        })) })
      }
      if (request.stage === stage && ++calls === 2) throw new MemoryComputeError('timeout')
      return h.defaultModel(request)
    })
    await h.run()
    const firstPass = h.requests.map(request => request.stage)
    const expected = ['extract', 'integrate', 'verify']
    expected.push('integrate')
    if (stage === 'verify') expected.push('verify')
    assert.deepEqual(firstPass, expected)
    assert.ok(events.some(event => event.stage === stage && event.reason === 'timeout'))
    const workspace = inputs[0]!.note.workspace
    assert.equal(h.documents.list(workspace).filter(doc => !doc.markdown.includes('Original arrangement.')).length, 1)
    assert.equal(h.notes.read(inputs[0]!.key)?.processed, inputs[0]!.note.revision)
    h.restart()
    await h.retry()
    assert.equal(h.requests.filter(request => request.stage === 'extract').length, 1)
    const resumed = h.requests.slice(firstPass.length).map(request => request.stage)
    assert.deepEqual(resumed, ['integrate', 'verify', 'integrate', 'verify', 'tag', 'tag', 'tag'])
    const documents = h.documents.list(workspace)
    assert.equal(documents.length, 3)
    assert.ok(documents.every(doc => doc.markdown.includes('memory_tags:')))
    assert.ok(inputs.every(({ key, note }) => h.notes.read(key)?.processed === note.revision))
  })
}

test('a failing diagnostic port cannot interrupt dream publication', async t => {
  const h = harness(t, { diagnostics: { emit() { throw new Error('broken diagnostic sink') } } })
  const first = h.add('The report is due Friday.')
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('an unavailable model result is not mislabeled as changed source evidence', async t => {
  const events: DiagnosticEvent[] = []
  const h = harness(t, { diagnostics: { emit(event) { events.push(event); return undefined } } })
  h.add('The report is due Friday.')
  h.setModel(async () => undefined)
  await h.run()
  assert.ok(events.some(event => event.stage === 'extract' && event.reason === 'unavailable'))
  assert.equal(events.some(event => event.reason === 'source_changed'), false)
})

test('dream timeout retries leave unrelated foreground sends admitted when no recovery is pending', async t => {
  const fence = createMemorySendFence({ epoch: 'owner', admit: () => ({ current: () => true, deadline: null }) })
  t.after(() => fence.close())
  const h = harness(t, { mutate: work => fence.mutate(work) })
  h.add('The report is due Friday.')
  h.setModel(async () => { throw new MemoryComputeError('timeout') })
  const foreground = fence.acquire('foreground', { session: 'main' }, 'foreground payload')
  foreground.signal.addEventListener('abort', () => foreground.settled(), { once: true })
  try {
    await h.run()
    await h.retry()
    assert.equal(foreground.signal.aborted, false)
    assert.equal(fence.blocked(), false)
    const next = fence.acquire('next-foreground', { session: 'main' }, 'next foreground payload')
    next.settled()
  } finally { foreground.settled() }
})

for (const failure of ['invalid-json', 'semantic-rejection', 'aborted'] as const) {
  test(`dream ${failure} retries and runner recovery preserve unrelated physical foreground sends`, async t => {
    const fence = createMemorySendFence({ epoch: 'owner', admit: () => ({ current: () => true, deadline: null }) })
    t.after(() => fence.close())
    const h = harness(t, { mutate: work => fence.mutate(work) })
    const first = h.add('The report is due Friday.')
    if (failure === 'semantic-rejection') h.seedDigest(first.note)
    h.setModel(request => {
      if (failure === 'invalid-json') return Promise.resolve('not JSON')
      if (failure === 'aborted') return Promise.reject(new MemoryComputeError('aborted'))
      return request.stage === 'verify' ? Promise.resolve('{"verdict":"rejected","reason":"The generated instruction is unsupported."}') : h.defaultModel(request)
    })
    const foreground = fence.acquire('held-main', { session: 'main' }, 'authorized current evidence')
    foreground.signal.addEventListener('abort', () => foreground.settled(), { once: true })
    try {
      await h.run(); await h.retry(); h.restart(); await h.retry()
      assert.equal(foreground.signal.aborted, false)
      assert.equal(fence.blocked(), false)
      assert.equal(h.store.db.prepare("SELECT count(*) n FROM effects WHERE kind='memory.dream'").get()?.n, 1)
      const next = fence.acquire('new-main', { session: 'main' }, 'authorized current evidence'); next.settled()
    } finally { foreground.settled() }
  })
}

test('temporary recovery admission preserves the same pending dream until the next wake', async t => {
  let ready = false
  const h = harness(t, { eligible: () => ready })
  const note = h.add('The report is due Friday.')
  await h.run()
  assert.equal(h.requests.length, 0)
  const before = h.store.db.prepare("SELECT generation,due_at,attempts FROM effects WHERE kind='memory.dream'").get()
  assert.equal(before?.attempts, 0, 'waiting for admission is not a provider failure')
  assert.equal(h.notes.read(note.key)?.processed, 0)
  assert.equal(h.status().state, 'waiting')
  ready = true
  await h.retry()
  assert.ok(h.requests.some(request => request.stage === 'extract'))
  assert.ok(h.notes.read(note.key)!.processed > 0)
})

test('dream still fences foreground sends when a prepared document needs recovery', async t => {
  const fence = createMemorySendFence({ epoch: 'owner', admit: () => ({ current: () => true, deadline: null }) })
  t.after(() => fence.close())
  let interrupted = false
  const h = harness(t, { mutate: work => fence.mutate(work), checkpoint(at) {
    if (at === 'intent' && !interrupted) { interrupted = true; throw new Error('interrupted document publication') }
  } })
  h.add('The report is due Friday.')
  await h.run()
  assert.equal(interrupted, true)
  assert.equal(h.documents.needsRecovery(), true)
  const foreground = fence.acquire('foreground-recovery', { session: 'main' }, 'foreground payload')
  foreground.signal.addEventListener('abort', () => foreground.settled(), { once: true })
  try {
    await h.retry()
    assert.equal(foreground.signal.aborted, true)
    assert.equal(h.documents.needsRecovery(), false)
  } finally { foreground.settled() }
})

test('a new digest combines original evidence and checkpoints without independent review', async t => {
  const h = harness(t)
  const first = h.add('The report is due each Friday.'), second = h.add('Include the reviewed totals in the report.')
  await h.run()
  assert.deepEqual(h.requests.map(item => item.stage), ['extract', 'integrate', 'tag'])
  const docs = h.documents.list(first.note.workspace)
  assert.equal(docs.length, 1)
  assert.match(docs[0]!.markdown, /memory_tags:/u)
  assert.deepEqual(new Set(docs[0]!.sources.map(ref => ref.id)), new Set([first.source.id, second.source.id]))
  assert.deepEqual(new Set(docs[0]!.sources.map(ref => ref.token)), new Set([...h.notes.references(first.key), ...h.notes.references(second.key)].map(ref => ref.token)))
  assert.deepEqual(new Set(h.requests.find(item => item.stage === 'integrate')!.sourceIds()), new Set([first.source.id, second.source.id]))
  assert.equal(h.notes.changed('2026-11-16', '2026-11-16').length, 0)
  assert.equal(h.store.db.prepare("SELECT COUNT(*) n FROM effects WHERE kind='memory.extract'").get()?.n, 0)
})

for (const response of [{ status: 'skip' }, { status: 'deferred', reason: 'Which deadline applies?' }]) {
  test(`a ${response.status} candidate is checkpointed with no queued question or restart replay`, async t => {
    const h = harness(t), first = h.add('The deadline may be Tuesday or Thursday.')
    h.setModel(request => request.stage === 'integrate' ? Promise.resolve(JSON.stringify(response)) : h.defaultModel(request))
    await h.run()
    assert.deepEqual(h.documents.pending(first.note.workspace), [])
    assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
    const count = h.requests.length
    h.restart(); await h.run()
    assert.equal(h.requests.length, count)
    assert.deepEqual(h.documents.list(first.note.workspace), [])
  })
}
test('a rejected generated draft gets one precise repair with a fresh target and one recoverable commit', async t => {
  const h = harness(t), first = h.add('The report is due Friday.')
  h.seedDigest(first.note)
  const reason = 'The generated draft adds an unsupported permanent confirmation rule.'
  let integrates = 0, verifies = 0, lost = true
  h.afterCommit(() => { if (lost) { lost = false; throw new Error('lost completion after repaired commit') } })
  h.setModel(async request => {
    if (request.stage === 'integrate') {
      integrates++
      const input = request.input as { unit: { name: string }, repair?: { reason: string, rejected: { markdown: string } } }
      if (integrates === 1) return h.defaultModel(request)
      assert.equal(input.repair?.reason, reason)
      assert.match(input.repair?.rejected.markdown ?? '', /Recurring report arrangement/u)
    }
    if (request.stage === 'verify' && ++verifies === 1) return JSON.stringify({ verdict: 'rejected', reason })
    return h.defaultModel(request)
  })
  await h.run()
  assert.equal(integrates, 2); assert.equal(verifies, 2)
  assert.deepEqual(h.documents.list(first.note.workspace).map(doc => doc.path), ['digest/personal/Report.md'])
  assert.equal(h.documents.pending(first.note.workspace).length, 0, 'a generated error must not ask the user to clarify')
  h.restart(); await h.retry()
  assert.equal(integrates, 2); assert.equal(verifies, 2, 'the durable repaired receipt must skip another model pass')
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM memory_document_revisions WHERE before IS NULL').get()?.n, 1)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('a contradictory verified classification is repaired as a draft defect without a user question', async t => {
  const h = harness(t), first = h.add('The report is due Friday.')
  h.seedDigest(first.note)
  let verifies = 0
  h.setModel(async request => {
    const result = await h.defaultModel(request)
    if (request.stage === 'verify' && ++verifies === 1) return JSON.stringify({ ...JSON.parse(result!), classification: 'unrelated' })
    if (request.stage === 'integrate' && verifies) assert.match((request.input as { repair: { reason: string } }).repair.reason, /classification contradicts/u)
    return result
  })
  await h.run()
  assert.equal(verifies, 2)
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.documents.pending(first.note.workspace).length, 0)
})

test('a second semantic rejection remains technical work after the bounded repair', async t => {
  const h = harness(t), first = h.add('The report is due Friday.')
  const original = h.seedDigest(first.note)
  h.setModel(request => request.stage === 'verify' ? Promise.resolve('{"verdict":"rejected","reason":"The generated instruction is unsupported."}') : h.defaultModel(request))
  await h.run()
  assert.equal(h.requests.filter(request => request.stage === 'integrate').length, 2)
  assert.equal(h.requests.filter(request => request.stage === 'verify').length, 2)
  assert.equal(h.documents.read(first.note.workspace, original.path)?.revision, original.revision)
  assert.equal(h.documents.pending(first.note.workspace).length, 0)
  assert.equal(h.notes.read(first.key)?.processed, 0)
  assert.ok(h.store.db.prepare("SELECT 1 FROM effects WHERE kind='memory.dream'").get())
})

test('a late rejected review cannot repair or commit a replaced effect generation', async t => {
  const h = harness(t), first = h.add('The report is due Friday.')
  const original = h.seedDigest(first.note)
  h.setModel(async request => {
    if (request.stage === 'verify') { h.replaceGeneration(); return '{"verdict":"rejected","reason":"Old generated draft is unsupported."}' }
    return h.defaultModel(request)
  })
  await h.run()
  assert.equal(h.requests.filter(request => request.stage === 'integrate').length, 1)
  assert.equal(h.documents.read(first.note.workspace, original.path)?.revision, original.revision)
  assert.equal(h.documents.pending(first.note.workspace).length, 0)
  h.setModel(h.defaultModel)
  await h.retry()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM memory_document_revisions WHERE before IS NULL').get()?.n, 1)
})

test('a repair retains the first draft attempt file policy even when the second attempt does not read it', async t => {
  const h = harness(t), first = h.add('The report is due Friday.')
  const original = h.seedDigest(first.note)
  const extra = h.addSource('An independent review checklist exists.')
  const doc = h.documents.commit({ operationId: 'independent-review', workspace: first.note.workspace, path: 'digest/personal/checklist.md',
    action: 'CREATE', expectedRevision: null, markdown: 'Independent checklist.', sources: [h.sourceRef(extra)], reads: [] })
  let integrates = 0, verifies = 0
  h.setModel(async request => {
    if (request.stage === 'integrate') {
      if (++integrates === 1) {
        const result = await request.tools!.executeTool({ callId: 'prior-policy', name: 'read', input: { path: doc.path } })
        assert.equal(result.state, 'completed')
      } else {
        h.documents.setEnabled({ operationId: 'disable-prior-read', workspace: first.note.workspace, documentId: doc.documentId,
          expectedRevision: doc.revision!, expectedUsageVersion: doc.usageVersion, enabled: false })
      }
    }
    if (request.stage === 'verify' && ++verifies === 1) return '{"verdict":"rejected","reason":"Remove the unsupported draft claim."}'
    return h.defaultModel(request)
  })
  await h.run()
  assert.equal(integrates, 2); assert.equal(verifies, 1)
  assert.equal(h.documents.read(first.note.workspace, original.path)?.revision, original.revision)
  assert.equal(h.documents.pending(first.note.workspace).length, 0)
  assert.equal(h.notes.read(first.key)?.processed, 0)
})

for (const point of ['intent', 'replace'] as const) test(`a repaired draft ${point} recovery retains a first-attempt-only daily physical fence`, async t => {
  let armed = false, interrupted = false
  const h = harness(t, { checkpoint(at, path) {
    if (armed && !interrupted && at === point && (at === 'intent' || path === 'digest/personal/Report.md')) {
      interrupted = true
      throw new Error('prepared repaired-draft publication interrupted')
    }
  } })
  const first = h.add('The report is due Friday.'), extra = h.add('An independent checklist is available.', 'Checklist')
  const original = h.seedDigest(first.note)
  armed = true
  h.notes.markProcessed(extra.key, extra.note.revision)
  let integrates = 0, verifies = 0
  h.setModel(async request => {
    if (request.stage === 'integrate' && ++integrates === 1) {
      const result = await request.tools!.executeTool({ callId: 'extra-daily', name: 'read', input: { path: extra.note.path } })
      assert.equal(result.state, 'completed')
    }
    if (request.stage === 'verify' && ++verifies === 1) return '{"verdict":"rejected","reason":"Remove an unsupported generated instruction."}'
    return h.defaultModel(request)
  })
  await h.run()
  assert.equal(interrupted, true)
  const row = h.store.db.prepare("SELECT plan FROM memory_file_intents WHERE namespace='documents' AND plan IS NOT NULL").get()
  assert.ok(row?.plan)
  const plan = JSON.parse(String(row.plan)) as { data: { receipt: DocumentReceipt, files: Array<{ path: string, revision: string }> } }
  writeFileSync(join(h.store.fileRoot, extra.note.workspace, extra.note.path), 'Independent external rewrite after the interrupted publication.\n')
  h.documents.recover()
  assert.equal(h.documents.receipt(first.note.workspace, plan.data.receipt.operationId), null,
    'cold recovery must recheck every daily read that influenced either draft attempt')
  assert.equal(h.documents.read(first.note.workspace, original.path)?.revision, original.revision)
  assert.equal(existsSync(join(h.store.fileRoot, first.note.workspace, 'digest/personal/Report.md')), true)
  assert.ok(plan.data.files.some(file => file.path === extra.note.path && file.revision === extra.note.fileRevision))
})

test('a refused rejection reason never becomes another model request or user question', async t => {
  const h = harness(t), first = h.add('The report is due Friday.')
  const original = h.seedDigest(first.note)
  h.setModel(request => request.stage === 'verify' ? Promise.resolve('{"verdict":"rejected","reason":"Use sk-abcdefghijklmnopqrstuv in the next draft."}') : h.defaultModel(request))
  await h.run()
  assert.equal(h.requests.filter(request => request.stage === 'integrate').length, 1)
  assert.equal(h.documents.read(first.note.workspace, original.path)?.revision, original.revision)
  assert.equal(h.documents.pending(first.note.workspace).length, 0)
  assert.ok(h.requests.every(request => !JSON.stringify(request.input).includes('sk-abcdefghijklmnopqrstuv')))
})

for (const state of ['pending', 'deferred'] as const) {
  test(`a recovered ${state} plan leaves its legacy clarification unit closed`, async t => {
    const h = harness(t), note = h.add('The deadline may be Tuesday.')
    h.setModel(async request => {
      if (request.stage === 'integrate') throw new MemoryComputeError('timeout')
      return h.defaultModel(request)
    })
    await h.run()
    const db = h.store.db
    const plan = JSON.parse(String(db.prepare("SELECT payload FROM effects WHERE kind='memory.dream' AND key='daily'").get()!.payload)) as {
      units: Array<{ workspace: string, operationId: string, state: string }>
    }
    const item = plan.units[0]!
    item.state = state
    db.prepare("UPDATE effects SET payload=? WHERE kind='memory.dream' AND key='daily'").run(JSON.stringify(plan))
    if (state === 'pending') {
      // Recovery of an already answered waiting unit can persist a pending plan entry.
      db.prepare("INSERT INTO memory_document_deferred(operation,workspace,input,state,payload) VALUES(?,?,?,'expired',NULL)")
        .run(item.operationId, item.workspace, 'old-fingerprint')
    }
    const requests = h.requests.length
    h.restart(); await h.retry()
    assert.equal(h.requests.length, requests)
    assert.deepEqual(h.documents.list(note.note.workspace), [])
    assert.equal(h.notes.read(note.key)?.processed, h.notes.read(note.key)?.revision)
  })
}

test('an ambiguous candidate does not prevent an independent digest from the same batch', async t => {
  const h = harness(t), first = h.add('The meeting may be Tuesday.', 'Unclear'), second = h.add('The report is due Friday.', 'Report')
  h.setModel(async request => {
    if (request.stage === 'extract') return JSON.stringify({ units: [
      { name: 'Unclear', bucket: 'personal', summary: 'Resolve ambiguity.', paths: [first.note.path] },
      { name: 'Report', bucket: 'personal', summary: 'Report schedule.', paths: [second.note.path] },
    ] })
    if (request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'Unclear') return '{"status":"skip"}'
    return h.defaultModel(request)
  })
  await h.run()
  assert.deepEqual(h.documents.pending(first.note.workspace), [])
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
  assert.equal(h.notes.read(second.key)?.processed, h.notes.read(second.key)?.revision)
})
test('successful paths checkpoint independently while a failed unit remains durable and retries once', async t => {
  const h = harness(t), first = h.add('First report arrangement.', 'First'), second = h.add('Second report arrangement.', 'Second')
  let failed = true
  h.setModel(async request => {
    if (request.stage === 'extract') {
      const input = request.input as { notes: Array<{ path: string, title: string }> }
      return JSON.stringify({ units: input.notes.map(note => ({ name: note.title, summary: note.title + ' report arrangement', bucket: 'personal', paths: [note.path] })) })
    }
    if (request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'Second' && failed) throw new Error('model transport failed')
    return h.defaultModel(request)
  })
  await h.run()
  assert.ok(h.status().lastProcessedAt)
  assert.equal(h.status().lastCheckedAt, null)
  assert.equal(h.status().state, 'retry')
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
  assert.equal(h.notes.read(second.key)?.processed, 0)
  failed = false; h.restart(); await h.retry()
  assert.equal(h.documents.list(first.note.workspace).length, 2)
  assert.equal(h.notes.read(second.key)?.processed, h.notes.read(second.key)?.revision)
  assert.equal(h.requests.filter(request => request.stage === 'extract').length, 1)
  assert.equal(h.requests.filter(request => request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'First').length, 1)
})

test('unit budget does not checkpoint files that were never scanned or integrated', async t => {
  const h = harness(t, { units: 1, budget: 1 }), first = h.add('First report.'), second = h.add('Second report.')
  await h.run()
  const rows = [h.notes.read(first.key)!, h.notes.read(second.key)!]
  assert.equal(rows.filter(note => note.processed === note.revision).length, 1)
  assert.equal(rows.filter(note => note.processed === 0).length, 1)
  assert.equal(h.requests.filter(request => request.stage === 'extract').length, 1)
})

test('a committed document survives a lost completion callback; restart replays receipt without another model integration', async t => {
  const h = harness(t), first = h.add('Report on Friday.')
  let lost = true
  h.afterCommit(() => { if (lost) { lost = false; throw new Error('lost post-commit completion') } })
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.notes.read(first.key)?.processed, 0)
  h.restart(); await h.retry()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert.equal(h.requests.filter(request => request.stage === 'integrate').length, 1)
  assert.equal(h.requests.filter(request => request.stage === 'verify').length, 0)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('restart closes a tag interrupted after its durable attempt and before model IO', async t => {
  const h = harness(t), input = h.add('Report on Friday.')
  const record = h.documents.recordTagAttempt
  h.documents.recordTagAttempt = attempt => {
    record(attempt)
    if (attempt.state === 'attempted') throw new Error('stopped before tag model IO')
  }
  await h.run()
  const doc = h.documents.list(input.note.workspace)[0]!
  const id = `tag:${memoryHash(JSON.stringify([doc.workspace, doc.id, doc.revision]))}`
  assert.equal(h.documents.tagAttempt(doc.workspace, id)?.state, 'attempted')
  h.documents.recordTagAttempt = record
  h.restart()
  await h.retry()
  const closed = h.documents.tagAttempt(doc.workspace, id)
  assert.equal(closed?.state, 'failed')
  assert.equal(closed?.reason, 'interrupted')
  assert.equal(h.requests.filter(request => request.stage === 'tag').length, 0)
  assert.equal(h.notes.read(input.key)?.processed, input.note.revision)
})

test('a committed tag is published from its receipt after interruption without another model request', async t => {
  const h = harness(t), input = h.add('Report on Friday.')
  const published: DocumentReceipt[] = []
  h.afterCommit(receipt => {
    if (receipt.action === 'TAG') { published.push(receipt); throw new Error('tag publication stopped') }
  })
  await h.run()
  const receipt = published[0]!
  assert.equal(h.documents.tagAttempt(input.note.workspace, receipt.operationId)?.state, 'completed')
  assert.ok(h.documents.read(input.note.workspace, receipt.path)?.markdown.includes('memory_tags:'))
  // Previous releases could report a callback failure as a failed tag despite this exact receipt.
  h.store.db.prepare("UPDATE memory_document_tag_attempts SET state='failed', reason='failed' WHERE operation=?").run(receipt.operationId)
  h.afterCommit(item => { if (item.action === 'TAG') published.push(item) })
  h.restart()
  await h.retry()
  assert.deepEqual(published, [receipt, receipt])
  assert.equal(h.documents.tagAttempt(input.note.workspace, receipt.operationId)?.state, 'completed')
  assert.equal(h.requests.filter(request => request.stage === 'tag').length, 1)
  assert.equal(h.notes.read(input.key)?.processed, input.note.revision)
})

for (const reason of ['call-failed', 'timeout'] as const) test(`Auto Tag ${reason} preserves completed documents and checkpoints without retrying tags after restart`, async t => {
  const h = harness(t), first = h.add('Report on Friday.', 'Report'), second = h.add('Plan on Monday.', 'Plan')
  let calls = 0
  h.setModel(async request => {
    if (request.stage === 'extract') return JSON.stringify({ units: [first, second].map(({ note }) => ({
      name: note.title, bucket: 'personal', summary: 'Recurring report arrangement', paths: [note.path],
    })) })
    if (request.stage === 'tag' && ++calls === 1) throw new MemoryComputeError(reason)
    return h.defaultModel(request)
  })
  await h.run()
  assert.equal(calls, 2)
  const workspace = first.note.workspace
  const doc = h.documents.read(workspace, 'digest/personal/Report.md')!
  assert.ok(!doc.markdown.includes('memory_tags:'))
  assert.ok(h.documents.read(workspace, 'digest/personal/Plan.md')?.markdown.includes('memory_tags:'))
  const attempt = h.documents.tagAttempt(workspace, `tag:${memoryHash(JSON.stringify([workspace, doc.id, doc.revision]))}`)
  assert.equal(attempt?.state, 'failed')
  assert.equal(h.notes.changed(first.note.day, first.note.day).length, 0)
  const completed = h.requests.length
  h.restart()
  await h.retry()
  await h.run()
  assert.equal(h.requests.length, completed)
})

test('the commit checks sources again after waiting for a mutation/send fence', async t => {
  const h = harness(t), first = h.add('Report on Friday.')
  let verified = false
  h.setModel(async request => { const result = await h.defaultModel(request); if (request.stage === 'integrate') verified = true; return result })
  h.beforeMutation(() => {
    if (verified) h.store.db.prepare('UPDATE memory_sources SET withdrawn=1 WHERE id=?').run(first.source.id)
  })
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 0)
  assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 0)
})

test('a disabled fragment is never re-sent through a mixed daily file, while an independent source is eligible', async t => {
  const h = harness(t), first = h.add('Friday reporting. Monday planning.')
  await h.run()
  const doc = h.documents.list(first.note.workspace)[0]!
  h.documents.setEnabled({ operationId: randomUUID(), workspace: doc.workspace, documentId: doc.id,
    expectedRevision: doc.revision, expectedUsageVersion: doc.usageVersion, enabled: false })
  h.store.db.prepare('UPDATE memory_daily_notes SET processed=0').run()
  const count = h.requests.length
  await h.run()
  assert.equal(h.requests.length, count)
  h.add('An independent release schedule.', 'Release')
  h.setModel(async request => request.stage === 'extract'
    ? JSON.stringify({ units: [{ name: 'Release', summary: 'Independent release schedule', bucket: 'procedure', paths: (request.input as { notes: Array<{ path: string }> }).notes.map(note => note.path) }] })
    : h.defaultModel(request))
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  assert(h.requests.slice(count).every(request => !JSON.stringify(request.input).includes('Friday reporting')))
})

test('batching uses UTF-8 bytes, groups days when possible, and retains an oversized single file', () => {
  const notes = [{ day: 'one', document: '城城' }, { day: 'one', document: '城城' }, { day: 'two', document: 'z'.repeat(30) }]
  assert.deepEqual(batchDreamNotes(notes, 15).map(batch => batch.length), [2, 1])
  assert.deepEqual(batchDreamNotes(notes, 5).map(batch => batch.length), [1, 1, 1])
  assert.throws(() => batchDreamNotes(notes, -1))
})

test('only exact backend-issued file references are excluded from credential inspection', () => {
  const path = 'daily/2026-11-16/note-' + memoryHash('trusted note') + '.md'
  const session = 'session/dialog/' + memoryHash('trusted session') + '.jsonl'
  const markdown = `---\nsource_conversation: "[[${session}]]"\n---\nThe report is supported by [[${path}]].`
  assert.equal(looksSecret(markdown), true)
  assert.equal(looksSecret(inspectMemoryDocumentText(markdown, [path, session])), false)
  const secret = 'sk-abcdefghijklmnopqrstuv'
  assert.equal(looksSecret(inspectMemoryDocumentText(markdown + '\n' + secret, [path, session])), true)
  assert.equal(looksSecret(inspectMemoryDocumentText(markdown, [])), true)
})

test('semantic review retains a separate model verdict and deterministic evidence/attribution boundaries', () => {
  const original = { id: 'source', version: 1, text: 'The reviewer, not I, moved to Paris.', withdrawn: false } as MemorySource
  const value = { verdict: 'verified', action: 'CREATE', classification: 'unrelated',
    checks: { attribution: true, polarity: true, time: true, conditions: true, meaning: true, sources: true, action: true },
    evidence: [{ sourceId: original.id, sourceVersion: 1, start: 0, end: original.text!.length, text: original.text, claim: 'The reviewer moved.' }], changeEvidence: [], corrections: [] }
  const options = { value, action: 'CREATE' as const, sources: [{ id: 'source', token: 'version' }], source: () => original, reads: [], unitSources: [['source']] }
  assert.equal(validateDreamReview(options).verdict, 'verified')
  assert.throws(() => validateDreamReview({ ...options, value: { ...value, evidence: [{ ...value.evidence[0], text: 'I moved to Paris.' }] } }), /evidence-span/u)
  assert.equal(validateDreamReview({ ...options, value: { verdict: 'deferred', reason: 'Attribution is ambiguous.' } }).verdict, 'deferred')
  assert.equal(validateDreamReview({ ...options, value: { ...value, classification: 'same_abstraction' } }).verdict, 'rejected')
  assert.throws(() => validateDreamReview({ ...options, restricted: () => true }), /evidence-restricted/u)
})

for (const action of ['CORROBORATE', 'REFINE', 'CORRECT'] as const) test(`${action} uses the same logical node, retains old evidence and links, and commits only after review`, async t => {
  const h = harness(t)
  h.setFixture({ summary: 'The report is due Friday.' })
  const first = h.add('The report is due Friday.')
  await h.run()
  const before = h.documents.list(first.note.workspace)[0]!
  const newText = action === 'CORRECT' ? 'Correction: the report deadline is Monday, replacing Friday.'
    : action === 'REFINE' ? 'Include reviewed totals with the Friday report.' : 'I confirm that the report deadline is Friday.'
  const next = h.add(newText)
  h.setFixture({ summary: newText, action })
  h.setModel(async request => {
    const result = await h.defaultModel(request)
    if (request.stage !== 'verify' || action !== 'CORRECT') return result
    const review = JSON.parse(result!) as { evidence: Array<{ sourceId: string }>, changeEvidence: unknown[], corrections: unknown[] }
    const line = before.markdown.split('\n').findIndex(value => value === 'The report is due Friday.') + 1
    assert(line > 0)
    review.changeEvidence = review.evidence.filter(item => item.sourceId === next.source.id)
    review.corrections = [{ path: before.path, revision: before.revision, startLine: line, endLine: line,
      text: 'The report is due Friday.', condition: 'the weekly report', time: 'current deadline' }]
    return JSON.stringify(review)
  })
  await h.run()
  const docs = h.documents.list(first.note.workspace)
  assert.equal(docs.length, 1)
  assert.equal(docs[0]!.id, before.id)
  assert.notEqual(docs[0]!.revision, before.revision)
  assert.match(docs[0]!.markdown, new RegExp(first.note.path.replaceAll('.', '\\.')))
  assert.match(docs[0]!.markdown, new RegExp(next.note.path.replaceAll('.', '\\.')))
  assert.deepEqual(new Set(docs[0]!.sources.map(ref => ref.id)), new Set([first.source.id, next.source.id]))
  assert.equal(docs[0]!.corrections.length, action === 'CORRECT' ? 1 : 0)
  assert.equal(h.notes.read(next.key)?.processed, h.notes.read(next.key)?.revision)
  if (action === 'CORRECT') {
    // TAG has its own content hash; replacement validity follows the retained logical relation.
    const correction = docs[0]!.corrections[0]!
    assert.equal(correction.documentId, docs[0]!.id)
    h.setFixture({ action: 'REFINE', summary: 'Send the Monday report with a reviewed attachment.' })
    h.add('Add a reviewed attachment to the Monday report.')
    h.setModel(h.defaultModel)
    await h.run()
    assert.equal(h.documents.list(first.note.workspace)[0]?.corrections[0]?.operationId, correction.operationId)
  }
})



test('a question containing refused material is not reintroduced during independent semantic review', async t => {
  const h = harness(t), secret = 'sk-abcdefghijklmnopqrstuv'
  const first = h.add('The report is due Friday.', 'Report', { author: 'answer', question: `Does ${secret} affect the report?` })
  h.seedDigest(first.note)
  await h.run()
  const verify = h.requests.find(request => request.stage === 'verify')!
  assert.ok(verify)
  assert.equal(JSON.stringify(verify.input).includes(secret), false)
  assert.equal((verify.input as { canonicalSources: Array<{ questionUnavailable: boolean }> }).canonicalSources[0]?.questionUnavailable, true)
})

test('Extract presents replaced daily fragments together with current correction content and its live dependency set', async t => {
  const h = harness(t), first = h.add('The report is due Friday.')
  h.setFixture({ summary: 'The report is due Friday.' })
  await h.run()
  const before = h.documents.list(first.note.workspace)[0]!
  const correction = h.addSource('Correction: Monday replaces Friday as the report deadline.')
  const line = first.note.document.split('\n').findIndex(line => line === first.source.text) + 1
  const fixed = h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: before.path,
    expectedRevision: before.revision, markdown: before.markdown.replaceAll('The report is due Friday.', 'The report is due Monday.'),
    action: 'CORRECT', sources: [...before.sources, h.sourceRef(correction)], reads: [before],
    corrections: [{ path: first.note.path, revision: first.note.fileRevision, startLine: line, endLine: line,
      text: first.source.text!, condition: 'weekly report', time: 'current deadline' }] })
  const corrected = h.documents.read(first.note.workspace, fixed.path)!
  h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: corrected.path, expectedRevision: corrected.revision,
    markdown: updateMemoryFrontmatter(corrected.markdown, { memory_tags: ['weekly', 'report'] }), action: 'TAG', sources: corrected.sources, reads: [corrected] })
  h.store.db.prepare('UPDATE memory_daily_notes SET processed=0 WHERE key=?').run(first.key)
  const count = h.requests.length
  h.setModel(async request => {
    assert.equal(request.stage, 'extract')
    const input = request.input as { notes: Array<{ applicability: { state: string }, replacements: Array<{ markdown: string }> }> }
    assert.equal(input.notes[0]?.applicability.state, 'superseded')
    assert.match(input.notes[0]!.replacements[0]!.markdown, /Monday/u)
    assert(request.sourceIds().includes(correction.id))
    return '{"units":[]}'
  })
  await h.run()
  assert.equal(h.requests.length, count + 1)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

for (const substantive of [false, true]) test(`question provenance is retained for a ${substantive ? 'reviewed edit' : 'direct creation'} with short-answer evidence`, async t => {
  const h = harness(t)
  const context = h.addSource('Choose the deadline for the weekly report.')
  const answer = h.addSource('Friday', { author: 'answer', question: 'Which day is the weekly report due?', session: 'answer-session' })
  const key = h.notes.add(answer.session!, '2026-11-16', [answer], '', answer.id, [], '', { questionCurrent: true, questionSources: [context.id] })!
  assert(h.notes.commit(key, h.notes.pending(key), { status: 'write', title: 'Report', markdown: 'The weekly report is due Friday.' }, 1,
    Date.parse('2026-11-16T12:00:00Z'), h.notes.snapshot([answer.id]), undefined))
  const note = h.notes.read(key)!
  if (substantive) h.seedDigest(note)
  h.setFixture({ summary: 'The weekly report is due Friday.', evidenceId: answer.id })
  await h.run()
  const verify = h.requests.find(request => request.stage === 'verify')
  assert.equal(Boolean(verify), substantive)
  if (verify) {
    assert(verify.sourceIds().includes(context.id))
    const input = verify.input as { canonicalSources: Array<{ sourceId: string, question: string | null }> }
    assert.equal(input.canonicalSources.find(source => source.sourceId === answer.id)?.question, answer.question)
  }
  const document = h.documents.list(note.workspace)[0]!
  assert.deepEqual(new Set(document.sources.map(ref => ref.id)), new Set([answer.id, context.id]))
  h.store.db.prepare('UPDATE memory_sources SET withdrawn=1 WHERE id=?').run(context.id)
  h.documents.withdraw(context.id)
  assert.equal(h.documents.list(note.workspace).length, 0)
})

test('a TAG receipt recovers its own expanded readset after interruption while another unit is still retrying', async t => {
  const h = harness(t), first = h.add('The report is due Friday. Attach the reviewed totals.')
  h.setFixture({ summary: 'The report is due Friday. Attach the reviewed totals.' })
  await h.run()
  const before = h.documents.list(first.note.workspace)[0]!
  const correction = h.addSource('Correction: Monday replaces Friday as the report deadline. Reviewed totals are still required.')
  const line = first.note.document.split('\n').findIndex(line => line === first.source.text) + 1
  h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: before.path, expectedRevision: before.revision,
    markdown: before.markdown.replaceAll('Friday', 'Monday'), action: 'CORRECT', sources: [...before.sources, h.sourceRef(correction)], reads: [before],
    corrections: [{ path: first.note.path, revision: first.note.fileRevision, startLine: line, endLine: line,
      text: first.source.text!, condition: 'weekly report', time: 'current deadline' }] })
  h.store.db.prepare('UPDATE memory_daily_notes SET processed=0 WHERE key=?').run(first.key)
  const start = h.requests.length
  let failed = true, interrupted = true
  h.setFixture({})
  // Change the fixture's tag set so this update really writes another content revision.
  const originalModel = h.defaultModel
  h.setModel(async request => {
    if (request.stage === 'extract') return JSON.stringify({ units: [
      { name: 'Report', bucket: 'personal', summary: 'The report deadline is Monday.', paths: [first.note.path] },
      { name: 'Attachment', bucket: 'procedure', summary: 'Attach reviewed totals.', paths: [first.note.path] },
    ] })
    if (request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'Attachment' && failed) throw new Error('second unit transport failure')
    if (request.stage === 'tag') return '{"memory_tags":["weekly","reviewed"]}'
    return originalModel(request)
  })
  h.afterCommit(receipt => { if (receipt.action === 'TAG' && interrupted) { interrupted = false; throw new Error('interrupted after TAG journal receipt') } })
  await h.run()
  assert.equal(interrupted, false, 'the first unit reached a persisted TAG revision')
  assert.equal(h.notes.read(first.key)?.processed, 0)
  failed = false; h.restart(); await h.retry()
  assert.equal(h.requests.slice(start).filter(request => request.stage === 'extract').length, 1)
  assert.equal(h.requests.slice(start).filter(request => request.stage === 'integrate' && (request.input as { unit: { name: string } }).unit.name === 'Report').length, 1)
  assert.equal(h.documents.list(first.note.workspace).length, 2)
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

test('a new draft records only its cited unit with exact spans, even when search saw a broader and an unrelated source', async t => {
  const h = harness(t), text = 'Friday report. Private project.'
  const spans = [{ start: 0, end: 'Friday report.'.length }]
  const first = h.add(text, 'Report', {}, spans)
  const unrelated = h.addSource('An unrelated Report reference.')
  h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: 'digest/personal/related.md', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Report background', description: 'Report reference' }, body: 'Unrelated.' }),
    action: 'CREATE', sources: [h.sourceRef(unrelated), h.sourceRef(first.source)], reads: [] })
  h.setFixture({ summary: 'Friday report.' })
  await h.run()
  assert(h.requests.find(request => request.stage === 'integrate')!.sourceIds().includes(unrelated.id))
  assert.equal(h.requests.some(request => request.stage === 'verify'), false)
  assert.deepEqual(h.documents.read(first.note.workspace, 'digest/personal/Report.md')?.sources, [{ ...h.sourceRef(first.source), spans }])
})

test('a pure added citation skips review but an addition to the existing conclusion mislabeled as corroboration is reviewed', async t => {
  const h = harness(t), first = h.add('Report due Friday.')
  h.setFixture({ summary: 'Report due Friday.' })
  await h.run()
  const second = h.add('I confirm the Friday deadline.')
  h.setFixture({ summary: 'Report due Friday.', action: 'CORROBORATE' })
  await h.run()
  assert.equal(h.requests.filter(request => request.stage === 'verify').length, 0)
  const supported = h.documents.read(first.note.workspace, 'digest/personal/Report.md')!
  assert(supported.sources.some(ref => ref.id === second.source.id))
  h.add('Actually the deadline has changed.')
  h.setFixture({ summary: 'Report due Monday.', action: 'CORROBORATE' })
  h.setModel(request => request.stage === 'verify' ? Promise.resolve('{"verdict":"rejected","reason":"The proposed replacement is unsupported."}') : h.defaultModel(request))
  await h.run()
  assert.equal(h.requests.filter(request => request.stage === 'verify').length, 2)
  assert.equal(h.documents.read(first.note.workspace, supported.path)?.revision, supported.revision)
})

for (const action of ['CREATE', 'CORRECT'] as const) test(`a false ${action} label on a source-only update never changes existing applicability`, async t => {
  const h = harness(t), first = h.add('Report due Friday.')
  h.setFixture({ summary: 'Report due Friday.' })
  await h.run()
  const before = h.documents.list(first.note.workspace)[0]!
  const next = h.add('Confirming Friday.')
  h.setFixture({ summary: 'Report due Friday.', action })
  await h.run()
  assert.equal(h.requests.filter(request => request.stage === 'verify').length, 0)
  const current = h.documents.read(first.note.workspace, before.path)!
  assert.equal(current.revision, before.revision)
  assert.deepEqual(current.corrections, [])
  assert.equal(h.notes.read(next.key)?.processed, 0)
})

test('reading a narrow existing node after a broader daily source never narrows the accumulated evidence readset', async t => {
  const h = harness(t), text = 'Report Friday. Planning Monday.', first = h.add(text)
  const split = text.indexOf('Planning')
  h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: 'digest/personal/Report.md', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Report', description: 'Report Friday' }, body: `Report Friday.\nSupported by [[${first.note.path}]].` }),
    action: 'CREATE', sources: [{ ...h.sourceRef(first.source), spans: [{ start: 0, end: split }] }], reads: [] })
  h.documents.commit({ operationId: randomUUID(), workspace: first.note.workspace, path: 'digest/personal/Planning.md', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Planning', description: 'Planning' }, body: 'Planning is unsettled.' }),
    action: 'CREATE', sources: [{ ...h.sourceRef(first.source), spans: [{ start: split, end: text.length }] }], reads: [] })
  h.setFixture({ name: 'Planning', summary: 'Planning Monday.', evidenceId: first.source.id })
  h.setModel(async request => {
    if (request.stage === 'integrate' && request.tools) {
      const tools = request.tools
      return h.defaultModel({ ...request, tools: { ...tools, async executeTool(invocation) {
        const result = await tools.executeTool(invocation)
        if (invocation.name === 'read') {
          const related = await tools.executeTool({ callId: 'late-related-search', name: 'node_search', input: { query: 'Report' } })
          assert.equal(related.state, 'completed')
        }
        return result
      } } })
    }
    const result = await h.defaultModel(request)
    if (request.stage !== 'verify') return result
    const review = JSON.parse(result!) as { evidence: Array<{ start: number, end: number, text: string }> }
    review.evidence[0] = { ...review.evidence[0]!, start: split, end: text.length, text: text.slice(split) }
    return JSON.stringify(review)
  })
  await h.run()
  const planning = h.documents.read(first.note.workspace, 'digest/personal/Planning.md')
  assert.ok(planning)
  assert.deepEqual(planning.sources[0]?.spans, [{ start: split, end: text.length }])
  assert.equal(h.notes.read(first.key)?.processed, h.notes.read(first.key)?.revision)
})

// All revisions deliberately share one canonical source: source-ID/version checks
// alone cannot notice a changed transitive applicability chain.
function correctionChain(h: ReturnType<typeof harness>) {
  const first = h.add('Old location. Intermediate location. Latest location.')
  const workspace = first.note.workspace, source = h.sourceRef(first.source)
  const middlePath = 'digest/personal/intermediate.md'
  const create = h.documents.commit({ operationId: 'middle-create', workspace, path: middlePath, expectedRevision: null,
    markdown: 'Initial summary.', action: 'CREATE', sources: [source], reads: [] })
  const line = first.note.document.split('\n').findIndex(value => value === first.source.text) + 1
  h.documents.commit({ operationId: 'middle-correct', workspace, path: middlePath, expectedRevision: create.revision,
    markdown: 'Intermediate location.', action: 'CORRECT', sources: [source], reads: [],
    files: [{ path: first.note.path, revision: first.note.fileRevision }],
    corrections: [{ path: first.note.path, revision: first.note.fileRevision, startLine: line, endLine: line,
      text: first.source.text!, condition: 'home', time: 'current' }] })
  const extend = () => {
    const middle = h.documents.read(workspace, middlePath)!, path = 'digest/personal/latest.md'
    const created = h.documents.commit({ operationId: 'latest-create', workspace, path, expectedRevision: null,
      markdown: 'Initial terminal summary.', action: 'CREATE', sources: [source], reads: [] })
    h.documents.commit({ operationId: 'latest-correct', workspace, path, expectedRevision: created.revision,
      markdown: 'Latest location.', action: 'CORRECT', sources: [source], reads: [middle],
      corrections: [{ path: middle.path, revision: middle.revision, startLine: 1, endLine: 1,
        text: middle.markdown, condition: 'home', time: 'current' }] })
  }
  return { first, extend, units: JSON.stringify({ units: [{ name: 'Home', bucket: 'personal', summary: 'Intermediate location.', paths: [first.note.path] }] }) }
}

test('transitive correction during extraction rejects output without relying on a runtime global revision', async t => {
  const h = harness(t), chain = correctionChain(h)
  h.setModel(async request => {
    assert.equal(request.stage, 'extract')
    chain.extend()
    assert.equal(request.current(), false)
    return chain.units
  })
  await h.run()
  assert.deepEqual(h.requests.map(request => request.stage), ['extract'])
  assert.equal(h.notes.read(chain.first.key)?.processed, 0)
})

test('persisted extraction policy rejects a new transitive correction before retrying an old unit', async t => {
  const h = harness(t), chain = correctionChain(h)
  h.setModel(async request => {
    if (request.stage === 'extract') return chain.units
    throw new Error('transport interrupted')
  })
  await h.run()
  assert.deepEqual(h.requests.map(request => request.stage), ['extract', 'integrate'])
  chain.extend(); h.restart(); await h.retry()
  assert.deepEqual(h.requests.map(request => request.stage), ['extract', 'integrate'], 'stale unit is not sent again')
  assert.equal(h.notes.read(chain.first.key)?.processed, 0)
})
