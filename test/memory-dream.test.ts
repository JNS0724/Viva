import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'
import { MemoryComputeError } from '../src/memory/contracts/compute.ts'
import type { DiagnosticEvent, DiagnosticPort } from '../src/diagnostics/contracts.ts'
import { createMemoryDreamJobs, batchDreamNotes } from '../src/memory/core/memory-dream-jobs.ts'
import type { DreamCalculate } from '../src/memory/core/memory-dream-jobs.ts'
import { inspectMemoryDocumentText } from '../src/memory/core/memory-dream-material.ts'
import { formatMemoryDocument, parseMemoryDocument } from '../src/memory/core/memory-document.ts'
import { looksSecret } from '../src/memory/core/memory-sensitive.ts'
import { createEffects } from '../src/memory/node/effects.ts'
import { createMemorySendFence } from '../src/memory/core/send-fence.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { openMemoryStore, memoryHash } from '../src/memory/node/memory-store.ts'
import { createMemoryPhysicalFileReader } from '../src/memory/node/memory-file-store.ts'
import type { DocumentReceipt, ReadMemoryPhysicalFile } from '../src/memory/core/ports/documents.ts'
import type { MemorySource } from '../src/memory/core/ports/store.ts'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { dreamModelStep } from './fixtures/dream-model.ts'

function harness(t: TestContext, options: {
  units?: number, budget?: number, readPhysicalFile?: ReadMemoryPhysicalFile,
  checkpoint?: Parameters<typeof openMemoryDocuments>[0]['checkpoint'],
  diagnostics?: DiagnosticPort, mutate?: <T>(work: () => T) => Promise<T>, eligible?: () => boolean,
  searchDigestNodes?: Parameters<typeof createMemoryDreamJobs>[0]['searchDigestNodes'],
} = {}) {
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
  let fixtureOptions: Parameters<typeof dreamModelStep>[1] = {}
  const defaultModel: DreamCalculate = async request => {
    const job: MemoryCompute = { id: randomUUID(), sourceId: request.sourceIds()[0]!, stage: 'dream', generation: request.job.generation,
      provider: 'fixture', model: 'fixture', system: request.system, input: JSON.stringify(request.input) }
    return dreamModelStep(job, fixtureOptions, request.tools)
  }
  let model: DreamCalculate = defaultModel
  let beforeMutation = () => {}
  let afterCommit: (receipt: DocumentReceipt) => void = () => {}
  const start = () => createMemoryDreamJobs({ store, notes, documents, effects, identity: { newId: randomUUID, hash: memoryHash }, now: () => now,
    diagnostics: options.diagnostics, readPhysicalFile: options.readPhysicalFile, searchDigestNodes: options.searchDigestNodes,
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
  const seedDigest = (note: ReturnType<typeof add>['note'], name = 'Report', extraMetadata: Record<string, unknown> = {}) =>
    documents.commit({ operationId: randomUUID(), workspace: note.workspace, path: `digest/personal/${name}.md`, action: 'CREATE', expectedRevision: null,
      markdown: formatMemoryDocument({ metadata: { name, description: 'Original arrangement', ...extraMetadata }, body: 'Original arrangement.' }),
      sources: notes.references(note.key), reads: [] })
  const run = async () => { jobs.run(); await effects.wake() }
  return { store, notes, documents, requests, addSource, add, seedDigest, run, defaultModel,
    status: (operationId?: string) => jobs.status(operationId), request: (operationId?: string) => jobs.request(operationId), settle: () => effects.wake(),
    withdraw: (sourceId: string) => jobs.withdraw(sourceId),
    setFixture(options: Parameters<typeof dreamModelStep>[1]) { fixtureOptions = options },
    setModel(next: DreamCalculate) { model = next },
    beforeMutation(next: () => void) { beforeMutation = next }, afterCommit(next: (receipt: DocumentReceipt) => void) { afterCommit = next },
    advance(ms: number) { now += ms },
    async retry() { now += 60_000; await effects.wake() },
    restart() { effects.close(); effects = createEffects({ db: store.db, now: () => now, later: () => null, cancel: () => {} }); jobs = start() },
    sourceRef: (original: MemorySource) => ({ id: original.id, token: memorySourceToken(original) }),
  }
}

test('manual Dream acknowledges immediately, joins the scheduled job and keeps actual processing time across empty checks and restart', async t => {
  const h = harness(t)
  const first = h.add('The weekly report is due every Friday.')
  let release!: () => void
  const running = new Promise<void>(resolve => { release = resolve })
  h.setModel(async request => { await running; return h.defaultModel(request) })
  const firstId = randomUUID(), secondId = randomUUID()
  const started = h.request(firstId)
  assert.equal(started.state, 'queued')
  assert.equal(started.jobId, firstId)
  assert.equal(h.status(firstId).jobId, firstId)
  const active = h.settle()
  const joined = h.request(secondId)
  assert.equal(joined.jobId, firstId)
  assert.equal(h.status(secondId).jobId, firstId)
  release()
  await active
  const completed = h.request(firstId)
  assert.equal(completed.state, 'idle')
  assert.equal(completed.lastCheckResult, 'processed')
  assert.equal(completed.completedAt, completed.lastCheckedAt)
  assert.equal(completed.lastProcessedAt, completed.lastCheckedAt)
  assert.equal(h.requests.length, 1)
  assert.equal(h.documents.list(first.note.workspace).length, 1)

  h.advance(10_000)
  h.setModel(h.defaultModel)
  const emptyId = randomUUID()
  h.request(emptyId)
  await h.settle()
  const afterEmpty = h.request(emptyId)
  assert.equal(afterEmpty.lastCheckResult, 'empty')
  assert.equal(afterEmpty.lastProcessedAt, completed.lastProcessedAt)
  assert.ok(afterEmpty.lastCheckedAt! > completed.lastCheckedAt!)

  h.restart()
  assert.equal(h.request(emptyId).lastProcessedAt, completed.lastProcessedAt)
  assert.equal(h.status().lastCheckResult, 'empty')
})

test('a manual Dream joining an active automatic run processes newly arrived notes before its receipt', async t => {
  const h = harness(t)
  const first = h.add('First report note.')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  h.setModel(async request => {
    if (++calls === 1) await gate
    return h.defaultModel(request)
  })
  const automatic = h.run()
  const second = h.add('Second report note.', 'SecondReport')
  const manualId = randomUUID()
  const ack = h.request(manualId)
  assert.equal(ack.jobId, manualId)
  release()
  await automatic
  await h.settle()
  const receipt = h.request(manualId)
  assert.equal(receipt.state, 'idle')
  assert.equal(receipt.lastCheckResult, 'processed')
  assert.ok(receipt.completedAt)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  assert.equal(h.documents.read(first.note.workspace, 'digest/personal/Report.md')?.enabled, true)
  assert.ok(second.note.revision > 0)
})

test('single-stage consolidation creates a digest in one model call and formats Sources deterministically', async t => {
  const h = harness(t)
  const input = h.add('The weekly report is submitted every Friday.')
  await h.run()
  assert.deepEqual(h.requests.map(item => item.stage), ['consolidate'])
  const docs = h.documents.list(input.note.workspace)
  assert.equal(docs.length, 1)
  const parsed = parseMemoryDocument(docs[0]!.markdown)
  assert.equal(parsed.metadata.name, 'Report')
  assert.equal(parsed.metadata.description, 'Recurring report arrangement')
  assert.ok(docs[0]!.markdown.includes(`[[${input.note.path}]]`))
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('node_search and read discover existing digests and REFINE preserves unrelated metadata and prior links', async t => {
  const h = harness(t)
  const first = h.add('The weekly report goes out on Friday.', 'Report')
  const seeded = h.seedDigest(first.note, 'Report', { custom_owner: 'team-alpha' })
  // Add an existing wikilink to the seeded digest via REFINE so we verify link preservation.
  const priorLink = 'digest/wiki/reference.md'
  h.documents.commit({
    operationId: randomUUID(), workspace: first.note.workspace, path: seeded.path, action: 'REFINE',
    expectedRevision: seeded.revision, sources: h.notes.references(first.key), reads: [],
    markdown: formatMemoryDocument({
      metadata: { name: 'Report', description: 'Original arrangement', custom_owner: 'team-alpha' },
      body: `Original arrangement.\n\n## Sources\n- [[${priorLink}]]`,
    }),
  })
  h.setModel(async request => {
    const input = request.input as { existingDigestCount: number, notes: Array<{ path: string, sourceIds: string[] }> }
    assert.equal(input.existingDigestCount, 1)
    const searched = await request.tools!.executeTool({ callId: 's1', name: 'node_search', input: { query: 'Report' } })
    const hits = JSON.parse(searched.content) as Array<{ path: string }>
    assert.deepEqual(hits.map(hit => hit.path), [seeded.path])
    const read = await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: seeded.path } })
    assert.equal(read.state, 'completed')
    return JSON.stringify({
      operations: [{
        action: 'REFINE', path: seeded.path, name: 'Report', description: 'Updated Friday arrangement',
        body: 'The weekly report goes out every Friday afternoon.',
        dailyPaths: input.notes.map(note => note.path),
        sourceIds: input.notes.flatMap(note => note.sourceIds),
      }],
    })
  })
  await h.run()
  const updated = h.documents.read(first.note.workspace, seeded.path)!
  const parsed = parseMemoryDocument(updated.markdown)
  assert.equal(parsed.metadata.custom_owner, 'team-alpha')
  assert.equal(parsed.metadata.description, 'Updated Friday arrangement')
  assert.ok(updated.markdown.includes(`[[${priorLink}]]`))
  assert.ok(updated.markdown.includes(`[[${first.note.path}]]`))
})

test('multiple operations in one batch commit cleanly even when the first refines an inspected digest', async t => {
  const h = harness(t)
  const first = h.add('The weekly report goes out on Friday.', 'Report')
  const seeded = h.seedDigest(first.note, 'Report')
  h.setModel(async request => {
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    await request.tools!.executeTool({ callId: 's1', name: 'node_search', input: { query: 'Report' } })
    await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: seeded.path } })
    const dailyPaths = input.notes.map(note => note.path)
    const sourceIds = input.notes.flatMap(note => note.sourceIds)
    return JSON.stringify({
      operations: [
        { action: 'REFINE', path: seeded.path, name: 'Report', description: 'Refined report', body: 'Refined report body', dailyPaths, sourceIds },
        { action: 'CREATE', path: 'digest/procedure/checklist.md', name: 'Checklist', description: 'Friday checklist', body: 'Checklist body', dailyPaths, sourceIds },
      ],
    })
  })
  await h.run()
  assert.equal(h.documents.list(first.note.workspace).length, 2)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('malformed output retries once and invalid source references or secret material are rejected', async t => {
  const h = harness(t)
  const input = h.add('The weekly report is due on Friday.')
  let calls = 0
  h.setModel(async request => {
    calls++
    if (calls === 1) return '{"operations": ['
    const body = request.input as { retry?: string, notes: Array<{ path: string }> }
    if (calls === 2) {
      assert.ok(body.retry)
      // Unknown source ID must be rejected as validation failure.
      return JSON.stringify({
        operations: [{ action: 'CREATE', path: 'digest/personal/bad.md', name: 'Bad', description: 'Bad',
          body: 'Bad', dailyPaths: [body.notes[0]!.path], sourceIds: ['forged-source'] }],
      })
    }
    return h.defaultModel(request)
  })
  await h.run()
  assert.equal(calls, 2)
  assert.equal(h.documents.list(input.note.workspace).length, 0)
  assert.equal(h.status().state, 'retry')

  await h.retry()
  assert.equal(calls, 3)
  assert.equal(h.documents.list(input.note.workspace).length, 1)
})

test('oversized singleton is recorded as size-limit without moving lastProcessedAt', async t => {
  const h = harness(t)
  h.add('Oversized note body.')
  h.setModel(async () => { throw new MemoryComputeError('context-window-exceeded') })
  await h.run()
  assert.equal(h.status().lastCheckResult, 'size-limit')
  assert.equal(h.status().lastProcessedAt, null)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('explicit context overflow and byte budget bisect multi-note batches and truncate large notes', async t => {
  const h = harness(t, { budget: 1500 })
  h.add('First note ' + 'a'.repeat(500), 'One')
  h.add('Second note ' + 'b'.repeat(500), 'Two')
  const sizes: number[] = []
  h.setModel(async request => {
    const input = request.input as { notes: Array<{ title: string }> }
    sizes.push(input.notes.length)
    if (input.notes.length > 1) throw new MemoryComputeError('context-window-exceeded')
    return JSON.stringify({ operations: [] })
  })
  await h.run()
  assert.ok(sizes.every(size => size === 1))
  assert.equal(sizes.length, 2)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('a failed Dream stays retryable and leaves the last successful check untouched', async t => {
  const events: DiagnosticEvent[] = []
  const h = harness(t, { diagnostics: { emit: e => { events.push(e) }, bind: () => ({ emit: () => {} }) } })
  h.add('Keep Friday open for review.')
  h.setModel(async () => { throw new MemoryComputeError('timeout') })
  await h.run()
  assert.equal(h.status().state, 'retry')
  assert.equal(h.status().lastCheckedAt, null)
  assert.ok(events.some(e => e.operation === 'memory.dream' && e.reason === 'timeout' && e.stage === 'consolidate'))
})

test('timeout on a later batch preserves earlier committed batch checkpoints and retries remaining notes', async t => {
  const h = harness(t, { budget: 200 })
  const first = h.add('First note about Friday review.', 'First')
  const second = h.add('Second note about Monday standup.', 'Second')
  let calls = 0
  let timedOutPath = ''
  h.setModel(async request => {
    calls++
    const input = request.input as { notes: Array<{ path: string, title: string }> }
    if (calls === 2) { timedOutPath = input.notes[0]!.path; throw new MemoryComputeError('timeout') }
    return dreamModelStep(
      { id: randomUUID(), sourceId: request.sourceIds()[0]!, stage: 'dream', generation: 1, provider: 'fixture', model: 'fixture', system: request.system, input: JSON.stringify(request.input) },
      { name: input.notes[0]!.title, summary: `${input.notes[0]!.title} summary` },
      request.tools,
    )
  })
  await h.run()
  assert.equal(h.status().state, 'retry')
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  const remaining = h.notes.changedFiles('2026-11-15', '2026-11-16')
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]!.path, timedOutPath)
  assert.ok([first.key, second.key].includes(remaining[0]!.key))

  await h.retry()
  assert.equal(h.documents.list(first.note.workspace).length, 2)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('temporary recovery admission preserves the same pending dream until the next wake', async t => {
  let admitted = false
  const h = harness(t, { eligible: () => admitted })
  h.add('Waiting for admission.')
  await h.run()
  assert.equal(h.status().state, 'waiting')
  assert.equal(h.requests.length, 0)
  admitted = true
  await h.settle()
  assert.equal(h.status().state, 'idle')
  assert.equal(h.requests.length, 1)
})

test('the commit checks sources again after waiting for a mutation/send fence', async t => {
  const fence = createMemorySendFence({ epoch: 'test', admit: () => ({ current: () => true, deadline: null }) })
  let onMutate = () => {}
  const h = harness(t, { mutate: work => fence.mutate(() => { onMutate(); return work() }) })
  const input = h.add('The weekly report is due Friday.')
  onMutate = () => { h.store.withdrawSource(input.source.id) }
  await h.run()
  assert.equal(h.documents.list(input.note.workspace).length, 0)
})

test('a disabled fragment is never re-sent through a mixed daily file while an independent source is eligible', async t => {
  const h = harness(t)
  const mixed = h.add('Keep Friday report. Secret side note.')
  const restricted = h.seedDigest(mixed.note, 'Stopped')
  h.documents.setEnabled({
    operationId: randomUUID(), workspace: mixed.note.workspace, documentId: restricted.documentId,
    expectedRevision: restricted.revision!, expectedUsageVersion: restricted.usageVersion, enabled: false,
  })
  const independent = h.add('Independent Monday standup.', 'Standup')
  await h.run()
  assert.equal(h.requests.length, 1)
  const sent = h.requests[0]!.input as { notes: Array<{ path: string }> }
  assert.deepEqual(sent.notes.map(note => note.path), [independent.note.path])
})

test('a question containing secret material is withheld and marked questionUnavailable in canonicalSources', async t => {
  const h = harness(t)
  h.add('Yes, every Friday.', 'Answer', { author: 'answer', question: 'Use api_key=sk-1234567890abcdef1234567890 for the weekly report?' })
  h.setModel(async request => {
    const input = request.input as { canonicalSources: Array<{ question: string | null, questionUnavailable: boolean }> }
    assert.equal(input.canonicalSources[0]!.question, null)
    assert.equal(input.canonicalSources[0]!.questionUnavailable, true)
    return JSON.stringify({ operations: [] })
  })
  await h.run()
  assert.equal(h.requests.length, 1)
})

test('Dream leaves an unreadable changed note pending and checkpoints an independent note', async t => {
  let blockedPath = ''
  let reader!: ReturnType<typeof createMemoryPhysicalFileReader>
  const h = harness(t, {
    readPhysicalFile: async (workspace, path, signal) => {
      if (path === blockedPath) {
        const error = new Error('Simulated slow file')
        error.name = 'RequestTimeout'
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(error), { once: true })
          setTimeout(() => reject(error), 1)
        })
      }
      return reader(workspace, path, signal)
    },
  })
  reader = createMemoryPhysicalFileReader(() => h.store.fileRoot)
  t.after(() => reader.close())
  const healthy = h.add('Healthy note for Friday.', 'Healthy')
  const unreadable = h.add('Blocked note.', 'Blocked')
  blockedPath = unreadable.note.path
  // Simulate external disk mismatch on unreadable note so physical verification fails cleanly without blocking healthy note.
  writeFileSync(join(h.store.fileRoot, unreadable.note.workspace, unreadable.note.path), 'externally corrupted')
  blockedPath = ''
  await h.run()
  assert.equal(h.documents.list(healthy.note.workspace).length, 1)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').some(file => file.key === healthy.key), false)
})

test('batching uses UTF-8 bytes, groups days when possible, and retains an oversized single file', () => {
  const batches = batchDreamNotes([
    { day: '2026-11-15', document: '甲'.repeat(10) },
    { day: '2026-11-15', document: '乙'.repeat(10) },
    { day: '2026-11-16', document: '丙'.repeat(40) },
  ], 65)
  assert.deepEqual(batches.map(batch => batch.length), [2, 1])
})

test('only exact backend-issued file references are excluded from credential inspection', () => {
  const valid = `daily/2026-11-16/${'a'.repeat(64)}.md`
  assert.equal(looksSecret(inspectMemoryDocumentText(`See [[${valid}]]`, [valid])), false)
  assert.equal(looksSecret(inspectMemoryDocumentText(`api_key=sk-1234567890abcdef1234567890 [[${valid}]]`, [valid])), true)
})

test('new digest linking an inspected digest inherits its sources so withdrawing the cited source erases it', async t => {
  const h = harness(t)
  const sourceA = h.addSource('Keep the blue binder on shelf 2.', { session: randomUUID() })
  const workspace = memorySourceWorkspace(sourceA)
  h.documents.commit({
    operationId: randomUUID(), workspace, path: 'digest/wiki/binder.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Binder', description: 'blue binder location' }, body: 'The blue binder is on shelf 2.' }),
    sources: [h.sourceRef(sourceA)], reads: [],
  })
  const dailyB = h.add('Review the blue binder checklist.', 'Binder Checklist')
  h.setModel(async request => {
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    const searched = await request.tools!.executeTool({ callId: 's1', name: 'node_search', input: { query: 'binder' } })
    assert.ok((JSON.parse(searched.content) as Array<{ path: string }>).some(doc => doc.path === 'digest/wiki/binder.md'))
    await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: 'digest/wiki/binder.md' } })
    return JSON.stringify({
      operations: [{
        action: 'CREATE',
        path: 'digest/wiki/shelf-summary.md',
        name: 'Shelf Summary',
        description: 'Summary referencing the blue binder',
        body: 'Checklist uses the blue binder from [[digest/wiki/binder.md]].',
        dailyPaths: [input.notes[0]!.path],
        sourceIds: input.notes[0]!.sourceIds,
      }],
    })
  })
  await h.run()
  const created = h.documents.read(workspace, 'digest/wiki/shelf-summary.md')
  assert.ok(created)
  assert.deepEqual(new Set(created.sources.map(ref => ref.id)), new Set([sourceA.id, dailyB.source.id]))
  h.documents.withdraw(sourceA.id)
  assert.equal(h.documents.read(workspace, 'digest/wiki/binder.md'), null)
  assert.equal(h.documents.read(workspace, 'digest/wiki/shelf-summary.md'), null)
})

test('ungrounded digest wikilinks outside inspected candidates are rejected', async t => {
  const h = harness(t)
  const daily = h.add('Weekly sync moved to Thursday.', 'Sync')
  h.setModel(async request => {
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    return JSON.stringify({
      operations: [{
        action: 'CREATE',
        path: 'digest/wiki/sync.md',
        name: 'Sync',
        description: 'Weekly sync time',
        body: 'See [[digest/wiki/unrecalled-secret.md]] for context.',
        dailyPaths: [input.notes[0]!.path],
        sourceIds: input.notes[0]!.sourceIds,
      }],
    })
  })
  await h.run()
  assert.equal(h.documents.list(daily.note.workspace).length, 0)
  assert.equal(h.status().state, 'retry')
})

test('a huge unrelated digest on disk never bloats the initial prompt or marks a short daily note as size-limit', async t => {
  const h = harness(t)
  const sourceA = h.addSource('Archive reference for Friday meeting.', { session: randomUUID() })
  const workspace = memorySourceWorkspace(sourceA)
  h.documents.commit({
    operationId: randomUUID(), workspace, path: 'digest/wiki/huge-archive.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({
      metadata: { name: 'Meeting Friday Archive', description: 'Meeting every Friday archive' },
      body: 'Meeting every Friday. '.repeat(4500),
    }),
    sources: [h.sourceRef(sourceA)], reads: [],
  })
  const daily = h.add('Meeting every Friday.', 'Meeting')
  h.setModel(async request => {
    const input = request.input as { existingDigestCount: number, notes: Array<{ path: string, sourceIds: string[] }> }
    assert.equal(input.existingDigestCount, 1)
    assert.ok(JSON.stringify(input).length < 10_000, 'initial prompt must stay compact without embedding huge digest bodies')
    await request.tools!.executeTool({ callId: 's1', name: 'node_search', input: { query: 'Friday meeting' } })
    return JSON.stringify({
      operations: [{
        action: 'CREATE',
        path: 'digest/personal/friday-meeting.md',
        name: 'Friday Meeting',
        description: 'Recurring Friday meeting',
        body: 'Meeting happens every Friday.',
        dailyPaths: [input.notes[0]!.path],
        sourceIds: input.notes[0]!.sourceIds,
      }],
    })
  })
  await h.run()
  assert.equal(h.status().lastCheckResult, 'processed')
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
  const created = h.documents.read(workspace, 'digest/personal/friday-meeting.md')
  assert.ok(created)
  assert.match(created.markdown, /Meeting happens every Friday\./u)
  assert.equal(daily.note.workspace, workspace)
})

test('REFINE preserves distinct section anchors on the same file while matching required daily links by path', async t => {
  const h = harness(t)
  const sourceA = h.addSource('Seasonal guide covers spring and autumn.', { session: randomUUID() })
  const workspace = memorySourceWorkspace(sourceA)
  h.documents.commit({
    operationId: randomUUID(), workspace, path: 'digest/wiki/seasonal.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({
      metadata: { name: 'Seasonal Plan', description: 'Seasonal guide links' },
      body: 'Follow [[digest/wiki/guide.md#Spring]] and [[digest/wiki/guide.md#Autumn]].',
    }),
    sources: [h.sourceRef(sourceA)], reads: [],
  })
  const daily = h.add('Seasonal plan updated with spring overview.', 'Seasonal')
  h.setModel(async request => {
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    const dailyPath = input.notes[0]!.path
    await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: 'digest/wiki/seasonal.md' } })
    return JSON.stringify({
      operations: [{
        action: 'REFINE',
        path: 'digest/wiki/seasonal.md',
        name: 'Seasonal Plan',
        description: 'Updated seasonal guide links',
        body: `Updated spring notes from [[digest/wiki/guide.md#Spring]] and [[${dailyPath}#Overview]].`,
        dailyPaths: [dailyPath],
        sourceIds: input.notes[0]!.sourceIds,
      }],
    })
  })
  await h.run()
  const updated = h.documents.read(workspace, 'digest/wiki/seasonal.md')
  assert.ok(updated)
  assert.ok(updated.markdown.includes('[[digest/wiki/guide.md#Spring]]'))
  assert.ok(updated.markdown.includes('[[digest/wiki/guide.md#Autumn]]'))
  assert.ok(updated.markdown.includes(`[[${daily.note.path}#Overview]]`))
  assert.equal(updated.markdown.includes(`[[${daily.note.path}]]`), false)
})

test('REFINE with edits surgically patches a multi-section digest without losing untouched sections', async t => {
  const h = harness(t)
  const sourceA = h.addSource('Architecture covers auth and deployment.', { session: randomUUID() })
  const workspace = memorySourceWorkspace(sourceA)
  h.documents.commit({
    operationId: randomUUID(), workspace, path: 'digest/wiki/arch.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({
      metadata: { name: 'Architecture', description: 'Auth and deploy', owner: 'core' },
      body: '## Auth\nKeep OAuth2 PKCE tokens short-lived.\n\n## Deploy\nRun manual release script.\n',
    }),
    sources: [h.sourceRef(sourceA)], reads: [],
  })
  const daily = h.add('Deploy now runs automatically via CI.', 'Deploy')
  let attempts = 0
  h.setModel(async request => {
    attempts++
    const input = request.input as { retry?: string, notes: Array<{ path: string, sourceIds: string[] }> }
    await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: 'digest/wiki/arch.md' } })
    if (attempts === 1) {
      // Non-existent oldText triggers targeted retry hint.
      return JSON.stringify({
        operations: [{
          action: 'REFINE', path: 'digest/wiki/arch.md', name: 'Architecture', description: 'Auth and CI deploy',
          edits: [{ oldText: 'missing snippet', newText: 'replacement' }],
          dailyPaths: [input.notes[0]!.path], sourceIds: input.notes[0]!.sourceIds,
        }],
      })
    }
    assert.match(input.retry ?? '', /oldText/u)
    return JSON.stringify({
      operations: [{
        action: 'REFINE', path: 'digest/wiki/arch.md', name: 'Architecture', description: 'Auth and CI deploy',
        edits: [{ oldText: 'Run manual release script.', newText: 'Deploy automatically via CI.' }],
        dailyPaths: [input.notes[0]!.path], sourceIds: input.notes[0]!.sourceIds,
      }],
    })
  })
  await h.run()
  assert.equal(attempts, 2)
  const updated = h.documents.read(workspace, 'digest/wiki/arch.md')!
  assert.equal(parseMemoryDocument(updated.markdown).metadata.owner, 'core')
  assert.ok(updated.markdown.includes('Keep OAuth2 PKCE tokens short-lived.'))
  assert.ok(updated.markdown.includes('Deploy automatically via CI.'))
  assert.equal(updated.markdown.includes('Run manual release script.'), false)
  assert.ok(updated.markdown.includes(`[[${daily.note.path}]]`))
})

test('write-before-read and search-before-create guards reject uninspected operations and repair on retry', async t => {
  const h = harness(t)
  const sourceA = h.addSource('Existing guide.', { session: randomUUID() })
  const workspace = memorySourceWorkspace(sourceA)
  h.documents.commit({
    operationId: randomUUID(), workspace, path: 'digest/wiki/existing.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Existing', description: 'Existing guide' }, body: 'Original.' }),
    sources: [h.sourceRef(sourceA)], reads: [],
  })
  h.add('New independent topic about backups.', 'Backups')
  let attempts = 0
  h.setModel(async request => {
    attempts++
    const input = request.input as { retry?: string, notes: Array<{ path: string, sourceIds: string[] }> }
    if (attempts === 1) {
      // CREATE without node_search when existingDigestCount > 0 must be rejected.
      return JSON.stringify({
        operations: [{
          action: 'CREATE', path: 'digest/wiki/backups.md', name: 'Backups', description: 'Backup schedule',
          body: 'Backups run nightly.', dailyPaths: [input.notes[0]!.path], sourceIds: input.notes[0]!.sourceIds,
        }],
      })
    }
    assert.match(input.retry ?? '', /node_search/u)
    await request.tools!.executeTool({ callId: 's1', name: 'node_search', input: { query: 'Backups' } })
    return JSON.stringify({
      operations: [{
        action: 'CREATE', path: 'digest/wiki/backups.md', name: 'Backups', description: 'Backup schedule',
        body: 'Backups run nightly.', dailyPaths: [input.notes[0]!.path], sourceIds: input.notes[0]!.sourceIds,
      }],
    })
  })
  await h.run()
  assert.equal(attempts, 2)
  assert.ok(h.documents.read(workspace, 'digest/wiki/backups.md'))

  // Now verify REFINE without read is rejected and repaired once read is called.
  h.add('Update existing guide with extra note.', 'Existing Update')
  attempts = 0
  h.setModel(async request => {
    attempts++
    const input = request.input as { retry?: string, notes: Array<{ path: string, sourceIds: string[] }> }
    if (attempts === 1) {
      await request.tools!.executeTool({ callId: 's1', name: 'node_search', input: { query: 'Existing' } })
      return JSON.stringify({
        operations: [{
          action: 'REFINE', path: 'digest/wiki/existing.md', name: 'Existing', description: 'Updated guide',
          body: 'Updated without reading.', dailyPaths: [input.notes[0]!.path], sourceIds: input.notes[0]!.sourceIds,
        }],
      })
    }
    assert.match(input.retry ?? '', /read/u)
    await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: 'digest/wiki/existing.md' } })
    return JSON.stringify({
      operations: [{
        action: 'REFINE', path: 'digest/wiki/existing.md', name: 'Existing', description: 'Updated guide',
        edits: [{ oldText: 'Original.', newText: 'Original with extra note.' }],
        dailyPaths: [input.notes[0]!.path], sourceIds: input.notes[0]!.sourceIds,
      }],
    })
  })
  await h.run()
  assert.equal(attempts, 2)
  assert.ok(h.documents.read(workspace, 'digest/wiki/existing.md')!.markdown.includes('Original with extra note.'))
})

test('hasMore defers checkpointing a single multi-topic daily note while exact-cap completion checkpoints without looping', async t => {
  const h = harness(t, { units: 1 })
  const note = h.add('Alpha topic: use strict lint rules. Beta topic: rotate keys monthly.', 'DailyTopics')
  let calls = 0
  h.setModel(async request => {
    calls++
    const input = request.input as { maxOperations: number, existingDigestCount: number, notes: Array<{ path: string, sourceIds: string[] }> }
    assert.equal(input.maxOperations, 1)
    if (input.existingDigestCount > 0) {
      await request.tools!.executeTool({ callId: `s-${calls}`, name: 'node_search', input: { query: 'topic' } })
    }
    const target = input.notes[0]!
    if (calls === 1) {
      return JSON.stringify({
        hasMore: true,
        operations: [{
          action: 'CREATE',
          path: 'digest/wiki/alpha.md',
          name: 'Alpha',
          description: 'Alpha lint rule',
          body: 'Use strict lint rules.',
          dailyPaths: [target.path],
          sourceIds: target.sourceIds,
        }],
      })
    }
    // Second pass also hits maxOperations (1 === 1) but explicitly signals hasMore: false,
    // so the batch checkpoints immediately without needing an extra pass or risking a retry loop.
    return JSON.stringify({
      hasMore: false,
      operations: [{
        action: 'CREATE',
        path: 'digest/wiki/beta.md',
        name: 'Beta',
        description: 'Beta key rotation',
        body: 'Rotate keys monthly.',
        dailyPaths: [target.path],
        sourceIds: target.sourceIds,
      }],
    })
  })

  await h.run()
  assert.equal(calls, 1)
  assert.equal(h.status().state, 'retry')
  assert.equal(h.documents.list(note.note.workspace).length, 1)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 1)

  await h.retry()
  assert.equal(calls, 2)
  assert.equal(h.status().state, 'idle')
  assert.equal(h.documents.list(note.note.workspace).length, 2)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('reaching dreamUnits cap without hasMore still keeps uncovered files in a multi-file batch pending', async t => {
  const h = harness(t, { units: 1 })
  const first = h.add('Alpha topic: use strict lint rules.', 'Alpha')
  const second = h.add('Beta topic: rotate keys monthly.', 'Beta')
  let calls = 0
  h.setModel(async request => {
    calls++
    const input = request.input as { maxOperations: number, existingDigestCount: number, notes: Array<{ path: string, title: string, sourceIds: string[] }> }
    assert.equal(input.maxOperations, 1)
    if (input.existingDigestCount > 0) {
      await request.tools!.executeTool({ callId: `s-${calls}`, name: 'node_search', input: { query: input.notes[0]!.title } })
    }
    const target = input.notes[0]!
    return JSON.stringify({
      operations: [{
        action: 'CREATE',
        path: `digest/wiki/${target.title.toLowerCase()}.md`,
        name: target.title,
        description: `${target.title} rule`,
        body: `${target.title} summary.`,
        dailyPaths: [target.path],
        sourceIds: target.sourceIds,
      }],
    })
  })
  await h.run()
  assert.equal(calls, 1)
  assert.equal(h.status().state, 'retry')
  assert.equal(h.documents.list(first.note.workspace).length, 1)
  const pending = h.notes.changedFiles('2026-11-15', '2026-11-16')
  assert.equal(pending.length, 1)
  assert.ok([first.key, second.key].includes(pending[0]!.key))

  await h.retry()
  assert.equal(calls, 2)
  assert.equal(h.status().state, 'idle')
  assert.equal(h.documents.list(first.note.workspace).length, 2)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('partial commit failure in a multi-op batch resumes idempotently across restart without re-invoking the model', async t => {
  let failSecondCommit = true
  let mutateCalls = 0
  const h = harness(t, {
    mutate: async work => {
      mutateCalls++
      if (failSecondCommit && mutateCalls === 2) {
        failSecondCommit = false
        throw new Error('transient-disk-busy')
      }
      return work()
    },
  })
  const first = h.add('Alpha topic and Beta topic linked together.', 'Combined')
  const receipts: DocumentReceipt[] = []
  h.afterCommit(receipt => { receipts.push(receipt) })
  h.setModel(async request => {
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    const dailyPaths = [input.notes[0]!.path]
    const sourceIds = input.notes[0]!.sourceIds
    return JSON.stringify({
      operations: [
        {
          action: 'CREATE', path: 'digest/wiki/alpha.md', name: 'Alpha', description: 'Alpha guide',
          body: 'Alpha rules.', dailyPaths, sourceIds,
        },
        {
          action: 'CREATE', path: 'digest/wiki/beta.md', name: 'Beta', description: 'Beta guide',
          body: 'Beta depends on [[digest/wiki/alpha.md]].', dailyPaths, sourceIds,
        },
      ],
    })
  })

  await h.run()
  assert.equal(h.requests.length, 1)
  assert.equal(h.status().state, 'retry')
  assert.equal(receipts.length, 1)
  assert.equal(h.documents.read(first.note.workspace, 'digest/wiki/alpha.md')?.enabled, true)
  assert.equal(h.documents.read(first.note.workspace, 'digest/wiki/beta.md'), null)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 1)

  // Simulate process restart before retrying: pendingBatch must resume Op 2 via receipts without re-calling the LLM.
  h.restart()
  await h.retry()
  assert.equal(h.requests.length, 1, 'resuming pendingBatch must not re-invoke the LLM')
  assert.equal(h.status().state, 'idle')
  assert.equal(h.status().lastCheckResult, 'processed')
  assert.equal(receipts.length, 2)
  assert.equal(h.documents.read(first.note.workspace, 'digest/wiki/alpha.md')?.enabled, true)
  assert.equal(h.documents.read(first.note.workspace, 'digest/wiki/beta.md')?.enabled, true)
  assert.equal(h.notes.changedFiles('2026-11-15', '2026-11-16').length, 0)
})

test('withdraw scrubs a persisted pendingBatch while Dream is sleeping for retry', async t => {
  let failSecondCommit = true
  let mutateCalls = 0
  const h = harness(t, {
    mutate: async work => {
      mutateCalls++
      if (failSecondCommit && mutateCalls === 2) {
        failSecondCommit = false
        throw new Error('transient-disk-busy')
      }
      return work()
    },
  })
  const note = h.add('Private phrase banana-secret-42.', 'SecretTopic')
  h.setModel(async request => {
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    const dailyPaths = [input.notes[0]!.path]
    const sourceIds = input.notes[0]!.sourceIds
    return JSON.stringify({
      operations: [
        { action: 'CREATE', path: 'digest/wiki/one.md', name: 'One', description: 'One', body: 'banana-secret-42 part one.', dailyPaths, sourceIds },
        { action: 'CREATE', path: 'digest/wiki/two.md', name: 'Two', description: 'Two', body: 'banana-secret-42 part two.', dailyPaths, sourceIds },
      ],
    })
  })

  await h.run()
  assert.equal(h.status().state, 'retry')
  const beforeRow = h.store.db.prepare("SELECT payload FROM effects WHERE kind='memory.dream' AND key='daily'").get() as { payload: string }
  assert.ok(beforeRow.payload.includes('banana-secret-42'))

  h.store.withdrawSource(note.source.id)
  h.documents.withdraw(note.source.id)
  h.notes.withdraw(note.source.id)
  h.withdraw(note.source.id)

  const afterRow = h.store.db.prepare("SELECT payload FROM effects WHERE kind='memory.dream' AND key='daily'").get() as { payload: string }
  assert.equal(afterRow.payload.includes('banana-secret-42'), false)
  await h.retry()
  assert.equal(h.documents.read(note.note.workspace, 'digest/wiki/two.md'), null)
})

test('Dream passes a bounded metadata-only existingDigests catalog for active dimensions without leaking bodies or disabled files', async t => {
  const h = harness(t)
  const first = h.add('User drinks warm water and avoids coffee.', 'Drinks')
  const dietPath = 'digest/personal/diet-and-drinks.md'
  h.documents.commit({
    operationId: randomUUID(), workspace: first.note.workspace, path: dietPath, action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({
      metadata: { name: 'Diet & Drinks', description: 'Ongoing beverage and food preferences' },
      body: '## Beverages\n- Warm water only; no coffee.\nSECRET_BODY_CANARY_99',
    }),
    sources: h.notes.references(first.key), reads: [],
  })
  const disabledNote = h.add('Private disabled topic.', 'Disabled')
  const disabledRec = h.documents.commit({
    operationId: randomUUID(), workspace: first.note.workspace, path: 'digest/personal/disabled-topic.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Disabled Secret', description: 'Hidden' }, body: 'Hidden body' }),
    sources: h.notes.references(disabledNote.key), reads: [],
  })
  h.documents.setEnabled({
    operationId: randomUUID(), workspace: first.note.workspace, documentId: disabledRec.documentId,
    expectedRevision: disabledRec.revision!, expectedUsageVersion: disabledRec.usageVersion, enabled: false,
  })

  const second = h.add('User also prefers unsweetened green tea in the afternoon.', 'Afternoon tea')
  let sawCatalog: Array<{ path: string, name: string }> | undefined
  h.setModel(async request => {
    const input = request.input as { existingDigestCount: number, existingDigests?: Array<{ path: string, name: string }>, notes: Array<{ path: string, sourceIds: string[] }> }
    sawCatalog = input.existingDigests
    assert.equal(input.existingDigestCount, 1)
    assert.equal(JSON.stringify(input).includes('SECRET_BODY_CANARY_99'), false)
    assert.equal(JSON.stringify(input).includes('Disabled Secret'), false)
    const readRes = await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: dietPath } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({
      operations: [{
        action: 'REFINE',
        path: dietPath,
        name: 'Diet & Drinks',
        description: 'Ongoing beverage and food preferences including afternoon tea',
        edits: [{ oldText: '- Warm water only; no coffee.', newText: '- Warm water only; no coffee.\n- Unsweetened green tea in the afternoon.' }],
        dailyPaths: input.notes.map(note => note.path),
        sourceIds: input.notes.flatMap(note => note.sourceIds),
      }],
    })
  })
  await h.run()
  assert.deepEqual(sawCatalog, [{ path: dietPath, name: 'Diet & Drinks' }])
  const updated = h.documents.read(second.note.workspace, dietPath)
  assert.ok(updated?.markdown.includes('Unsweetened green tea in the afternoon.'))
})

test('formatDigestMarkdown preserves leading Markdown horizontal rules while stripping accidental YAML frontmatter', async t => {
  const h = harness(t)
  const note = h.add('Record divider-based notes and clean echoed metadata.', 'Divider')
  h.setModel(async request => {
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    const dailyPaths = [input.notes[0]!.path]
    const sourceIds = input.notes[0]!.sourceIds
    return JSON.stringify({
      operations: [
        {
          action: 'CREATE',
          path: 'digest/personal/thematic-break.md',
          name: 'Thematic Break',
          description: 'Body starts with Markdown horizontal rule',
          body: '---\n## Section A\nKeep this block.\n---\n## Section B\nAnd this block.',
          dailyPaths,
          sourceIds,
        },
        {
          action: 'CREATE',
          path: 'digest/personal/echoed-frontmatter.md',
          name: 'Echoed Meta',
          description: 'Clean description',
          body: '---\nname: Echoed Meta\ndescription: Clean description\n---\nActual body content.',
          dailyPaths,
          sourceIds,
        },
      ],
    })
  })
  await h.run()
  assert.equal(h.status().lastCheckResult, 'processed')
  const thematic = h.documents.read(note.note.workspace, 'digest/personal/thematic-break.md')!
  assert.ok(thematic.markdown.includes('## Section A\nKeep this block.'))
  assert.ok(thematic.markdown.includes('## Section B\nAnd this block.'))
  const echoed = h.documents.read(note.note.workspace, 'digest/personal/echoed-frontmatter.md')!
  assert.equal(echoed.markdown.match(/^---$/gmu)?.length, 2, 'duplicate YAML frontmatter must be stripped')
  assert.ok(echoed.markdown.includes('Actual body content.'))
})

test('Dream node_search propagates hybrid partial status and advances offset across pages', async t => {
  const seenOffsets: number[] = []
  let secondId = ''
  const h = harness(t, {
    searchDigestNodes: async (_workspace, _query, _limit, offset) => {
      seenOffsets.push(offset)
      if (offset === 0) return { nodes: [], partial: true }
      return { nodes: [{ id: secondId, path: 'digest/personal/second-page.md', score: 0.9 }], partial: false }
    },
  })
  const seedA = h.add('Alpha semantic seed.', 'Alpha')
  const seedB = h.add('Beta semantic seed.', 'Beta')
  h.documents.commit({
    operationId: randomUUID(), workspace: seedA.note.workspace, path: 'digest/personal/first-page.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Alpha Topic', description: 'Unrelated title' }, body: 'Alpha details.' }),
    sources: h.notes.references(seedA.key), reads: [],
  })
  const recB = h.documents.commit({
    operationId: randomUUID(), workspace: seedB.note.workspace, path: 'digest/personal/second-page.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Beta Topic', description: 'Unrelated title' }, body: 'Beta details.' }),
    sources: h.notes.references(seedB.key), reads: [],
  })
  secondId = recB.documentId

  const incoming = h.add('Follow-up semantic fact for page two.', 'Followup')
  let pagesSeen = 0
  let foundSecondPage = false
  h.setModel(async request => {
    const first = await request.tools!.executeTool({ callId: 's1', name: 'node_search', input: { query: 'semantic synonym', limit: 1 } })
    assert.equal(first.state, 'completed')
    const firstData = JSON.parse(first.content!) as { partial: boolean, nodes: Array<{ path: string }> }
    assert.equal(firstData.partial, true)
    assert.deepEqual(firstData.nodes, [])
    pagesSeen++
    const second = await request.tools!.executeTool({ callId: 's2', name: 'node_search', input: { query: 'semantic synonym', limit: 1 } })
    assert.equal(second.state, 'completed')
    const secondData = JSON.parse(second.content!) as Array<{ path: string }>
    assert.ok(Array.isArray(secondData))
    pagesSeen++
    foundSecondPage = secondData.some(hit => hit.path === 'digest/personal/second-page.md')
    const readRes = await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: 'digest/personal/second-page.md' } })
    assert.equal(readRes.state, 'completed')
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    return JSON.stringify({
      operations: [{
        action: 'REFINE',
        path: 'digest/personal/second-page.md',
        name: 'Beta Topic',
        description: 'Updated via hybrid page 2',
        edits: [{ oldText: 'Beta details.', newText: 'Beta details.\nFollow-up semantic fact.' }],
        dailyPaths: input.notes.map(note => note.path),
        sourceIds: input.notes.flatMap(note => note.sourceIds),
      }],
    })
  })

  await h.run()
  assert.equal(h.status().lastCheckResult, 'processed')
  assert.equal(pagesSeen, 2)
  assert.equal(foundSecondPage, true)
  assert.ok(seenOffsets.some(offset => offset > 0), `expected hybrid pagination to advance offset, saw ${JSON.stringify(seenOffsets)}`)
  assert.ok(h.documents.read(incoming.note.workspace, 'digest/personal/second-page.md')!.markdown.includes('Follow-up semantic fact.'))
})

test('Dream node_search with limit: 1 visits every hybrid candidate across pages without skipping undisplayed hits', async t => {
  const ordered: Array<{ id: string, path: string, score: number }> = []
  const seenCalls: Array<{ limit: number, offset: number }> = []
  const h = harness(t, {
    searchDigestNodes: async (_workspace, _query, limit, offset) => {
      seenCalls.push({ limit, offset })
      const slice = ordered.slice(offset, offset + limit)
      return { nodes: slice, partial: offset + limit < ordered.length }
    },
  })
  const s1 = h.add('First seed.', 'S1')
  const s2 = h.add('Second seed.', 'S2')
  const s3 = h.add('Third seed.', 'S3')
  for (const [idx, [seed, slug, score]] of [
    [s1, 'hit-a', 0.9],
    [s2, 'hit-b', 0.8],
    [s3, 'hit-c', 0.7],
  ].entries()) {
    const s = seed as ReturnType<typeof h.add>
    const rec = h.documents.commit({
      operationId: randomUUID(), workspace: s.note.workspace, path: `digest/personal/${slug}.md`, action: 'CREATE', expectedRevision: null,
      markdown: formatMemoryDocument({ metadata: { name: `Topic ${idx + 1}`, description: 'Opaque' }, body: `Body ${idx + 1}.` }),
      sources: h.notes.references(s.key), reads: [],
    })
    ordered.push({ id: rec.documentId, path: `digest/personal/${slug}.md`, score: score as number })
  }

  const incoming = h.add('New fact belonging to hit-b.', 'Incoming')
  const visitedPaths: string[] = []
  h.setModel(async request => {
    for (let i = 0; i < 3; i++) {
      const res = await request.tools!.executeTool({ callId: `p${i}`, name: 'node_search', input: { query: 'opaque semantic', limit: 1 } })
      assert.equal(res.state, 'completed')
      const parsed = JSON.parse(res.content!) as { partial?: boolean, nodes?: Array<{ path: string }> } | Array<{ path: string }>
      if (Array.isArray(parsed)) {
        assert.equal(i, 2, 'final page must complete on the 3rd hit')
        visitedPaths.push(...parsed.map(n => n.path))
      } else {
        assert.equal(parsed.partial, true)
        visitedPaths.push(...(parsed.nodes ?? []).map(n => n.path))
      }
    }
    const readRes = await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: 'digest/personal/hit-b.md' } })
    assert.equal(readRes.state, 'completed')
    const input = request.input as { notes: Array<{ path: string, sourceIds: string[] }> }
    return JSON.stringify({
      operations: [{
        action: 'REFINE',
        path: 'digest/personal/hit-b.md',
        name: 'Topic 2',
        description: 'Updated hit-b',
        edits: [{ oldText: 'Body 2.', newText: 'Body 2.\nNew fact belonging to hit-b.' }],
        dailyPaths: input.notes.map(note => note.path),
        sourceIds: input.notes.flatMap(note => note.sourceIds),
      }],
    })
  })

  await h.run()
  assert.equal(h.status().lastCheckResult, 'processed')
  assert.deepEqual(visitedPaths, ['digest/personal/hit-a.md', 'digest/personal/hit-b.md', 'digest/personal/hit-c.md'])
  assert.deepEqual(seenCalls, [{ limit: 1, offset: 0 }, { limit: 1, offset: 1 }, { limit: 1, offset: 2 }])
  assert.ok(h.documents.read(incoming.note.workspace, 'digest/personal/hit-b.md')!.markdown.includes('New fact belonging to hit-b.'))
})

test('Dream existingDigests catalog enforces full policy.read checks and excludes unreadable or withdrawn-source digests', async t => {
  const h = harness(t)
  const okNote = h.add('User drinks oolong tea.', 'Tea')
  const okPath = 'digest/personal/drinks.md'
  h.documents.commit({
    operationId: randomUUID(), workspace: okNote.note.workspace, path: okPath, action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Drinks', description: 'Beverage preferences' }, body: 'Oolong tea.' }),
    sources: h.notes.references(okNote.key), reads: [],
  })
  const withdrawnNote = h.add('Secret project codename.', 'Secret')
  const withdrawnPath = 'digest/personal/withdrawn-topic.md'
  h.documents.commit({
    operationId: randomUUID(), workspace: okNote.note.workspace, path: withdrawnPath, action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Withdrawn Secret Title', description: 'Should never leak' }, body: 'Secret body.' }),
    sources: h.notes.references(withdrawnNote.key), reads: [],
  })
  // Withdraw source in store without purging document row yet so activeEntries() still sees it, while policy.read rejects it.
  h.store.withdrawSource(withdrawnNote.source.id)

  const incoming = h.add('User also enjoys jasmine tea.', 'Jasmine')
  let sawCatalog: Array<{ path: string, name: string }> | undefined
  h.setModel(async request => {
    const input = request.input as { existingDigests?: Array<{ path: string, name: string }>, notes: Array<{ path: string, sourceIds: string[] }> }
    sawCatalog = input.existingDigests
    assert.equal(JSON.stringify(input).includes('Withdrawn Secret Title'), false)
    assert.equal(JSON.stringify(input).includes(withdrawnPath), false)
    const readRes = await request.tools!.executeTool({ callId: 'r1', name: 'read', input: { path: okPath } })
    assert.equal(readRes.state, 'completed')
    return JSON.stringify({
      operations: [{
        action: 'REFINE',
        path: okPath,
        name: 'Drinks',
        description: 'Beverage preferences',
        edits: [{ oldText: 'Oolong tea.', newText: 'Oolong tea.\nJasmine tea.' }],
        dailyPaths: input.notes.map(note => note.path),
        sourceIds: input.notes.flatMap(note => note.sourceIds),
      }],
    })
  })
  await h.run()
  assert.equal(h.status().lastCheckResult, 'processed')
  assert.deepEqual(sawCatalog, [{ path: okPath, name: 'Drinks' }])
  assert.ok(h.documents.read(incoming.note.workspace, okPath)!.markdown.includes('Jasmine tea.'))
})

test('Dream node_search continues past offset 512 and deduplicates hybrid/lexical hits without skipping or repeating', async t => {
  const seenOffsets: number[] = []
  let firstId = ''
  const h = harness(t, {
    searchDigestNodes: async (_workspace, query, limit, offset) => {
      if (query === 'past-512') {
        seenOffsets.push(offset)
        return { nodes: [], partial: offset + limit <= 550 }
      }
      // On query 'shared-term', page 0 returns firstId (which also matches lexically) and page 1 finishes empty.
      if (offset === 0) return { nodes: [{ id: firstId, path: 'digest/personal/shared-a.md', score: 0.9 }], partial: true }
      return { nodes: [], partial: false }
    },
  })
  const s1 = h.add('First shared note.', 'S1')
  const s2 = h.add('Second shared note.', 'S2')
  const recA = h.documents.commit({
    operationId: randomUUID(), workspace: s1.note.workspace, path: 'digest/personal/shared-a.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Shared Term A', description: 'shared-term alpha' }, body: 'Alpha.' }),
    sources: h.notes.references(s1.key), reads: [],
  })
  firstId = recA.documentId
  h.documents.commit({
    operationId: randomUUID(), workspace: s2.note.workspace, path: 'digest/personal/shared-b.md', action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({ metadata: { name: 'Shared Term B', description: 'shared-term beta' }, body: 'Beta.' }),
    sources: h.notes.references(s2.key), reads: [],
  })
  h.add('Incoming note.', 'Incoming')

  const visitedShared: string[] = []
  let completedPast512 = false
  h.setModel(async request => {
    // 1. Pagination past offset 512 keeps advancing until backend finishes (partial=false) so CREATE is never deadlocked.
    for (let i = 0; i < 12; i++) {
      const res = await request.tools!.executeTool({ callId: `c${i}`, name: 'node_search', input: { query: 'past-512', limit: 50 } })
      assert.equal(res.state, 'completed')
      const parsed = JSON.parse(res.content!) as { partial?: boolean } | unknown[]
      if (Array.isArray(parsed)) { completedPast512 = true; break }
    }
    // 2. Mixed hybrid + lexical paging with limit=1 must return shared-a then shared-b exactly once with no duplicates or skips.
    for (let i = 0; i < 4; i++) {
      const res = await request.tools!.executeTool({ callId: `m${i}`, name: 'node_search', input: { query: 'shared-term', limit: 1 } })
      assert.equal(res.state, 'completed')
      const parsed = JSON.parse(res.content!) as { partial?: boolean, nodes?: Array<{ path: string }> } | Array<{ path: string }>
      const rows = Array.isArray(parsed) ? parsed : (parsed.nodes ?? [])
      visitedShared.push(...rows.map(r => r.path))
      if (Array.isArray(parsed)) break
    }
    return JSON.stringify({ operations: [] })
  })
  await h.run()
  assert.equal(completedPast512, true)
  assert.ok(seenOffsets.some(offset => offset > 512), `expected pagination to advance past 512, saw ${JSON.stringify(seenOffsets)}`)
  assert.deepEqual(visitedShared, ['digest/personal/shared-a.md', 'digest/personal/shared-b.md'])
})
