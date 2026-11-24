import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { offlineMemorySafety } from './fixtures/memory-safety.ts'
import { scratch } from './fixtures/scratch.js'
import { createMemoryRuntime } from '../src/memory/core/memory-runtime.ts'
import { RequestTimeout } from '../src/shared/request-budget.ts'
import { openMemoryRuntimeResources } from '../src/memory/node/runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import type { MemoryDocuments, ReadMemoryPhysicalFile } from '../src/memory/core/ports/documents.ts'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'

const origin = { conversation: 'document-conversation', session: 'document-session' }
function fixture(t: TestContext, beforeStart?: (resources: ReturnType<typeof openMemoryRuntimeResources>) => void) {
  const { dir, defer } = scratch(t, 'memory-document-runtime-')
  let clock = Date.parse('2026-11-16T12:00:00Z')
  const now = () => clock
  const store = openMemoryStore(join(dir, 'memory.db'), now)
  const resources = openMemoryRuntimeResources({ store, now })
  beforeStart?.(resources)
  const physicalReader = resources.readPhysicalFile!
  let readPhysical: ReadMemoryPhysicalFile = physicalReader
  resources.readPhysicalFile = (...args) => readPhysical(...args)
  const openDocuments = resources.openDocuments
  let documents!: MemoryDocuments
  let failCleanup = false
  let beforePublish = (_workspace: string, _id: string) => {}
  resources.openDocuments = (readable, committed, policy) => {
    const index = policy?.index
    documents = openDocuments(readable, committed, index && policy ? { ...policy, index: {
      queue: index.queue,
      publish(workspace, id) { beforePublish(workspace, id); index.publish(workspace, id) },
    } } : policy)
    return { ...documents, recover() { if (failCleanup) throw new Error('test-cleanup-unavailable'); documents.recover() } }
  }
  const calls: MemoryCompute[] = []
  const memory = createMemoryRuntime({ store, resources, ...offlineMemorySafety, now, timezone: () => 'UTC', dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'fake', model: 'fake' }), changed: () => {},
    compute(job) {
      calls.push(job)
      if (job.stage !== 'note') return null
      const input = JSON.parse(job.input) as { existing?: {markdown:string}, turns: Array<{ user: Array<{ text: string }> }> }
      return Promise.resolve(JSON.stringify({ status: 'write', title: '个人资料', markdown: [input.existing?.markdown ?? '', ...input.turns.flatMap(turn => turn.user.map(source => source.text))].filter(Boolean).join('\n') }))
    },
  })
  defer(() => memory.close())
  function ref(id: string) {
    const source = store.readSource(id)!
    return { workspace: memorySourceWorkspace(source), reference: { id, token: memorySourceToken(source) } }
  }
  return { advance: (ms: number) => { clock += ms }, file: join(dir, 'memory.db'), store, memory, documents, calls, ref, setCleanupFailure: (value: boolean) => { failCleanup = value },
    beforePublish: (work: typeof beforePublish) => { beforePublish = work },
    wrapPhysicalRead: (wrap: (read: ReadMemoryPhysicalFile) => ReadMemoryPhysicalFile) => { readPhysical = wrap(physicalReader) } }
}


test('runtime undo advances the request revision, preserves disabled status and refuses stale usage versions', async t => {
  const f = fixture(t), id = randomUUID()
  f.memory.accept('我住深圳，后来搬到上海', origin, id)
  const { workspace, reference } = f.ref(id)
  const first = f.documents.commit({ operationId: 'home', workspace, path: 'digest/personal/home.md', expectedRevision: null, action: 'CREATE', markdown: '深圳', sources: [reference], reads: [] })
  const changed = f.documents.commit({ operationId: 'edit', workspace, path: first.path, expectedRevision: first.revision, action: 'REFINE', markdown: '上海', sources: [reference], reads: [] })
  const stopped = await f.memory.setDocumentEnabled({ operationId: 'stop', workspace, documentId: changed.documentId, expectedRevision: changed.revision!, expectedUsageVersion: changed.usageVersion, enabled: false })
  const revision = f.memory.revision()
  await assert.rejects(f.memory.undoDocument({ operationId: 'stale', workspace, documentId: changed.documentId, revision: changed.revision!, usageVersion: changed.usageVersion }), /version/)
  const undone = await f.memory.undoDocument({ operationId: 'undo-current', workspace, documentId: changed.documentId, revision: stopped.revision!, usageVersion: stopped.usageVersion })
  assert(f.memory.revision() > revision)
  assert.equal(f.memory.readDocument!(workspace, first.path), null)
  assert.equal(f.memory.readDocument!(workspace, first.path, { includeDisabled: true })?.enabled, false)
  assert.equal(f.memory.readDocument!(workspace, first.path, { includeDisabled: true })?.markdown, '深圳')
  assert(undone.usageVersion > stopped.usageVersion)
})

test('runtime deletion reports stopped until document replicas are physically cleared', async t => {
  const f = fixture(t)
  const sourceId = randomUUID()
  f.memory.accept('我的项目代号是青岚', origin, sourceId)
  const { workspace, reference } = f.ref(sourceId)
  const document = f.documents.commit({ operationId: 'digest', workspace, path: 'digest/wiki/project.md', expectedRevision: null, action: 'CREATE', markdown: '项目代号青岚', sources: [reference], reads: [] })
  f.setCleanupFailure(true)
  const file = f.memory.listFiles({ kind: 'digest' }).items[0]!
  await f.memory.forgetFile({ operationId: randomUUID(), identity: file.identity, version: file.version }, () => {})
  assert(f.memory.cleanupPending() > 0)
  assert.equal(f.memory.readDocument!(workspace, document.path), null)
  assert(existsSync(join(f.store.fileRoot, workspace, document.path)))
  f.setCleanupFailure(false)
  f.documents.recover()
  assert.equal(f.documents.pendingCleanup(), 0)
  assert.equal(existsSync(join(f.store.fileRoot, workspace, document.path)), false)
})



test('a cleared deletion leaves no digest plaintext in the database WAL', async t => {
  const f = fixture(t), marker = '我喜欢在周三下午整理蓝色笔记本里的旅行照片'
  const sourceId = randomUUID()
  f.memory.accept(marker, origin, sourceId)
  const { workspace, reference } = f.ref(sourceId)
  f.documents.commit({ operationId: 'digest', workspace, path: 'digest/wiki/project.md', expectedRevision: null, action: 'CREATE', markdown: marker + ' digest output', sources: [reference], reads: [] })
  const file = f.memory.listFiles({ kind: 'digest' }).items[0]!
  await f.memory.forgetFile({ operationId: randomUUID(), identity: file.identity, version: file.version }, () => {})
  await f.memory.wake()
  for (const file of [f.file, `${f.file}-wal`]) {
    if (existsSync(file)) assert.equal(readFileSync(file).includes(marker + ' digest output'), false, file)
  }
})




test('file mode shares digest recall, original line reads, node search, injection and file-level disable', async t => {
  const f = fixture(t), sourceId = randomUUID()
  f.memory.accept('青岚发布需要先完成账单核对。', origin, sourceId)
  const { workspace, reference } = f.ref(sourceId)
  const markdown = '---\r\nname: 青岚发布\r\ndescription: 发布要求\r\n---\r\n# 发布\r\n青岚发布需要先完成账单核对。'
  const receipt = f.documents.commit({ operationId: 'create-release', workspace, path: 'digest/wiki/release.md',
    expectedRevision: null, action: 'CREATE', markdown, sources: [reference], reads: [] })
  await f.memory.wake()
  const recalled = JSON.parse(await f.memory.handleModelRequest({ op: 'recall', session: origin.session, query: '账单核对' }, origin, () => true))
  assert.equal(recalled.status, 'ok')
  assert(recalled.notes.some((note: {path:string,markdown:string}) => note.path === receipt.path && note.markdown.includes('账单核对')))
  const read = JSON.parse(await f.memory.handleModelRequest({ op: 'file_read', session: origin.session, id: receipt.documentId, start_line: 6, end_line: 6 }, origin, () => true))
  assert.equal(read.text, '青岚发布需要先完成账单核对。')
  assert.equal(read.startLine, 6)
  assert(!Object.hasOwn(read, 'files'))
  const nodes = JSON.parse(await f.memory.handleModelRequest({ op: 'node_search', session: origin.session, query: '青岚' }, origin, () => true))
  assert.equal(nodes.status, 'ok')
  assert(JSON.stringify(nodes).includes(receipt.documentId))
  const unrelated = { op: 'context' as const, session: origin.session, turn: 1, question: '今天天气怎么样' }
  for (const empty of [f.memory.handle(unrelated, origin), await f.memory.handleModelRequest(unrelated, origin, () => true)]) {
    assert.doesNotMatch(empty, /File memory evidence|账单核对/u)
  }
  const context = await f.memory.handleModelRequest({ op: 'context', session: origin.session, turn: 1, question: '账单核对' }, origin, () => true)
  assert(context.includes('账单核对'))
  await f.memory.setDocumentEnabled({ operationId: 'disable-release', workspace, documentId: receipt.documentId,
    expectedRevision: receipt.revision!, expectedUsageVersion: receipt.usageVersion, enabled: false })
  assert.equal(JSON.parse(f.memory.handle({ op: 'file_read', session: origin.session, id: receipt.documentId }, origin)).status, 'unavailable')
  const after = await f.memory.handleModelRequest({ op: 'context', session: origin.session, turn: 2, question: '账单核对' }, origin, () => true)
  assert(!after.includes('青岚发布需要先完成账单核对'))
})

test('model searches and direct lookup exclude another project before opening candidate files', async t => {
  const f = fixture(t)
  function projectFile(projectId: string) {
    const project = { kind: 'project' as const, id: projectId }, scope = { ...origin, context: project, project }
    const source = randomUUID()
    f.memory.accept('Invoice project ledger', scope, source)
    const { workspace, reference } = f.ref(source)
    const receipt = f.documents.commit({ operationId: projectId, workspace, path: 'digest/wiki/invoice.md', action: 'CREATE',
      markdown: '---\nname: Invoice ledger\n---\nInvoice project ledger', expectedRevision: null, sources: [reference], reads: [] })
    return { scope, workspace, receipt }
  }
  const foreign = projectFile('foreign'), local = projectFile('local')
  await f.memory.wake()
  const reads: string[] = []
  f.wrapPhysicalRead(read => (workspace, path, signal) => { reads.push(workspace); return read(workspace, path, signal) })
  const request = (input: Parameters<typeof f.memory.handleModelRequest>[0]) => f.memory.handleModelRequest(input, local.scope, () => true)
  const session = origin.session
  for (const output of [
    await request({ op: 'recall', session, query: 'Invoice' }),
    await request({ op: 'node_search', session, query: 'Invoice' }),
  ]) {
    assert.ok(output.includes(local.receipt.documentId))
    assert.ok(!output.includes(foreign.receipt.documentId))
  }
  assert.equal(JSON.parse(await request({ op: 'file_read', session, id: foreign.receipt.documentId })).status, 'unavailable')
  assert.ok(reads.includes(local.workspace))
  assert.ok(!reads.includes(foreign.workspace))
})

test('a stalled verification leaves independent recall, injection and direct reads available', async t => {
  const f = fixture(t)
  function create(name: string, markdown: string) {
    const id = randomUUID()
    f.memory.accept(markdown, origin, id)
    const { workspace, reference } = f.ref(id)
    const receipt = f.documents.commit({ operationId: name, workspace, path: `digest/personal/${name}.md`,
      expectedRevision: null, action: 'CREATE', markdown, sources: [reference], reads: [] })
    return { ...receipt, workspace }
  }
  const slow = create('slow', '---\nname: Invoice delayed\n---\nInvoice contains the red invoice seal.')
  const quick = create('quick', '---\nname: Invoice ready\n---\nInvoice uses the blue approval stamp.')
  await f.memory.wake()
  let started!: () => void
  const stalled = new Promise<void>(resolve => { started = resolve })
  f.wrapPhysicalRead(read => (workspace, path, signal) => {
    if (path !== slow.path) return read(workspace, path, signal)
    started()
    return new Promise(resolve => {
      const timer = setTimeout(stop, 65)
      function stop() { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(null) }
      if (signal?.aborted) stop()
      else signal?.addEventListener('abort', stop, { once: true })
    })
  })
  const session = origin.session
  const request = (input: Parameters<typeof f.memory.handleModelRequest>[0], signal?: AbortSignal) => f.memory.handleModelRequest(input, origin, () => true, signal)
  const gathering = request({ op: 'recall', session, query: 'Invoice' })
  await stalled
  const direct = JSON.parse(await request({ op: 'file_read', session, id: quick.documentId }))
  assert.match(direct.text, /blue approval stamp/u)
  const detail = await f.memory.readFileAsync({ kind: 'digest', workspace: quick.workspace, id: quick.documentId })
  assert.match(detail?.markdown ?? '', /blue approval stamp/u)
  const recalled = JSON.parse(await gathering)
  assert(recalled.partial)
  assert.match(JSON.stringify(recalled.notes), /blue approval stamp/u)
  assert.doesNotMatch(JSON.stringify(recalled.notes), /red invoice seal/u)
  const context = await request({ op: 'context', session, turn: 1, question: 'Invoice' })
  assert.match(context, /blue approval stamp/u)
  assert.doesNotMatch(context, /red invoice seal/u)
  const nodes = JSON.parse(await request({ op: 'node_search', session, query: 'Invoice' }))
  assert.equal(nodes.partial, true)
  assert.deepEqual(nodes.nodes.map((node: { id: string }) => node.id), [quick.documentId])
  const list = await f.memory.listFilesAsync({})
  assert.deepEqual(list.items.map(item => item.identity.id), [quick.documentId])
  const cancellation = new AbortController()
  const ongoing = request({ op: 'file_read', session, id: slow.documentId }, cancellation.signal)
  cancellation.abort()
  assert.equal(JSON.parse(await ongoing).status, 'unavailable')
})

test('a stalled page observation returns within the page budget and can be retried', { timeout: 3_000 }, async t => {
  const f = fixture(t)
  const source = randomUUID()
  f.memory.accept('Lemon tree schedule.', origin, source)
  const { workspace, reference } = f.ref(source)
  const entry = f.documents.commit({ operationId: 'lemon', workspace, path: 'digest/wiki/lemon.md',
    expectedRevision: null, markdown: 'Lemon tree schedule.', sources: [reference], reads: [], action: 'CREATE' })
  await f.memory.wake()
  let started!: () => void
  const reading = new Promise<void>(resolve => { started = resolve })
  f.wrapPhysicalRead(() => () => { started(); return new Promise(() => {}) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = f.memory.listFilesAsync({ kind: 'digest' })
  await reading
  t.mock.timers.tick(DAILY_MEMORY_DEFAULTS.fileVerificationBudgetMs)
  const incomplete = await pending
  t.mock.timers.reset()
  assert.ok(incomplete.partial)
  assert.deepEqual(incomplete.items, [])
  f.wrapPhysicalRead(read => read)
  const complete = await f.memory.listFilesAsync({ kind: 'digest' })
  assert.equal(complete.partial, undefined)
  assert.deepEqual(complete.items.map(item => [item.identity.id, item.enabled]), [[entry.documentId, true]])
})

test('file pagination verifies just this page and rejects cursors after a ledger change', async t => {
  const f = fixture(t), id = randomUUID()
  const markdown = 'Invoice approval stamp is blue.'
  f.memory.accept(markdown, origin, id)
  const { workspace, reference } = f.ref(id)
  for (const name of ['quarterly', 'annual', 'weekly']) {
    f.documents.commit({ operationId: name, workspace, path: `digest/wiki/${name}.md`, expectedRevision: null,
      action: 'CREATE', markdown, sources: [reference], reads: [] })
  }
  await f.memory.wake()
  const observed: string[] = []
  f.wrapPhysicalRead(read => (workspace, path, signal) => {
    observed.push(path)
    return read(workspace, path, signal)
  })
  const initial = await f.memory.listFilesAsync({ kind: 'digest', limit: 1 })
  assert.ok(initial.nextCursor)
  assert.deepEqual(observed, [initial.items[0]?.path])
  observed.length = 0
  const next = await f.memory.listFilesAsync({ kind: 'digest', limit: 1, cursor: initial.nextCursor })
  assert.notEqual(next.items[0]?.path, initial.items[0]?.path)
  assert.deepEqual(observed, [next.items[0]?.path])
  const first = initial.items[0]!
  await f.memory.setDocumentEnabled({ operationId: 'disable', workspace, documentId: first.identity.id,
    expectedRevision: first.version.contentRevision, expectedUsageVersion: first.version.usageVersion, enabled: false })
  observed.length = 0
  assert.equal((await f.memory.listFilesAsync({ kind: 'digest', limit: 1, cursor: initial.nextCursor })).status, 'stale')
  assert.deepEqual(observed, [])
})

test('a full cursor of unreadable rows cannot strand a later healthy file', async t => {
  const f = fixture(t), source = randomUUID()
  f.memory.accept('Invoice schedule.', origin, source)
  const { workspace, reference } = f.ref(source)
  for (let i = 0; i <= 100; i++) {
    const name = String(i).padStart(3, '0')
    f.documents.commit({ operationId: name, workspace, path: `digest/wiki/${name}.md`,
      action: 'CREATE', markdown: 'Invoice', expectedRevision: null, sources: [reference], reads: [] })
  }
  await f.memory.wake()
  const skipped = new Set<string>()
  let markBad = true
  f.wrapPhysicalRead(read => (area, path, signal) => {
    if (markBad) skipped.add(path)
    if (skipped.has(path)) throw new RequestTimeout()
    return read(area, path, signal)
  })
  const first = await f.memory.listFilesAsync({ kind: 'digest', limit: 100 })
  assert.equal(first.nextCursor?.retry?.length, 100)
  markBad = false
  const second = await f.memory.listFilesAsync({ kind: 'digest', limit: 100, cursor: first.nextCursor! })
  assert.ok(second.partial)
  assert.ok(second.nextCursor)
  assert.equal(second.nextCursor.retry, undefined)
  const last = await f.memory.listFilesAsync({ kind: 'digest', limit: 100, cursor: second.nextCursor })
  assert.equal(last.items.length, 1)
  assert.ok(!skipped.has(last.items[0]!.path))
  assert.equal(last.nextCursor, null)
})

test('model file reads recheck the accepted usage version after asynchronous verification', async t => {
  const f = fixture(t), source = randomUUID()
  f.memory.accept('Invoice includes a private approval stamp.', origin, source)
  const { workspace, reference } = f.ref(source)
  const document = f.documents.commit({ operationId: 'write', workspace, path: 'digest/wiki/invoice.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Invoice includes a private approval stamp.', sources: [reference], reads: [] })
  let captured!: () => void, release!: () => void
  const observed = new Promise<void>(resolve => { captured = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  f.wrapPhysicalRead(read => async (...args) => {
    const snapshot = await read(...args)
    captured()
    await barrier
    return snapshot
  })
  const pending = f.memory.handleModelRequest({ op: 'file_read', session: origin.session, id: document.documentId }, origin, () => true)
  await observed
  try {
    await f.memory.setDocumentEnabled({ operationId: 'disable', workspace, documentId: document.documentId,
      expectedRevision: document.revision!, expectedUsageVersion: document.usageVersion, enabled: false })
  } finally { release() }
  assert.equal(JSON.parse(await pending).status, 'unavailable')
})

test('idle wakes leave unregistered Markdown and external edits untouched without scanning', async t => {
  const f = fixture(t)
  const sourceId = randomUUID()
  f.memory.accept('Cobalt bills go through finance.', origin, sourceId)
  const { workspace, reference } = f.ref(sourceId)
  const receipt = f.documents.commit({ operationId: 'cobalt', workspace, path: 'digest/wiki/cobalt.md',
    action: 'CREATE', markdown: 'Cobalt bills go through finance.', expectedRevision: null, sources: [reference], reads: [] })
  await f.memory.wake()
  const physical = join(f.store.fileRoot, workspace, receipt.path)
  writeFileSync(physical, 'External invoice instructions.')
  writeFileSync(join(f.store.fileRoot, workspace, 'digest/wiki/unregistered.md'), 'Loose invoice instructions.')
  const opened: string[] = []
  f.wrapPhysicalRead(read => (workspace, path, signal) => { opened.push(path); return read(workspace, path, signal) })
  for (let hour = 0; hour < 4; hour++) {
    f.advance(3_600_000)
    await f.memory.wake()
  }
  assert.deepEqual(opened, [])
  assert.equal(f.calls.length, 0)
  assert.equal(readFileSync(physical, 'utf8'), 'External invoice instructions.')
  assert.deepEqual(f.documents.registered(workspace).map(row => row.path), [receipt.path])
})

test('model lookups omit changed, missing and unreadable files while unrelated verified contents stay searchable', async t => {
  const f = fixture(t), source = randomUUID()
  f.memory.accept('There are four invoices.', origin, source)
  const { workspace, reference } = f.ref(source)
  const create = (name: string) => f.documents.commit({
    operationId: name, workspace, path: 'digest/wiki/' + name + '.md', action: 'CREATE',
    expectedRevision: null, markdown: `---\nname: Invoice ledger ${name}\n---\nInvoice ledger ${name} evidence.`, sources: [reference], reads: [],
  })
  const changed = create('changed'), missing = create('missing'), timeout = create('timeout'), healthy = create('healthy')
  await f.memory.wake()
  const physical = (path: string) => join(f.store.fileRoot, workspace, path)
  writeFileSync(physical(changed.path), 'Invoice ledger: untrusted external instructions.')
  renameSync(physical(missing.path), physical('digest/wiki/moved.md'))
  f.wrapPhysicalRead(read => (area, path, signal) => path === timeout.path ? Promise.reject(new RequestTimeout()) : read(area, path, signal))
  const request = (data: Parameters<typeof f.memory.handleModelRequest>[0]) => f.memory.handleModelRequest(data, origin, () => true)
  const result = await request({ op: 'recall', session: origin.session, query: 'Invoice ledger' })
  assert.match(result, /healthy evidence/u)
  assert.doesNotMatch(result, /changed evidence|missing evidence|timeout evidence|untrusted external|moved\.md/u)
  const nodes = JSON.parse(await request({ op: 'node_search', session: origin.session, query: 'Invoice ledger' })).nodes as { id: string }[]
  assert.deepEqual(nodes.map(node => node.id), [healthy.documentId])
  const context = await request({ op: 'context', session: origin.session, turn: 1, question: 'Invoice ledger' })
  assert.doesNotMatch(context, /changed evidence|missing evidence|timeout evidence|untrusted external/u)
  for (const row of [changed, missing, timeout]) {
    assert.equal(JSON.parse(await request({ op: 'file_read', session: origin.session, id: row.documentId })).status, 'unavailable')
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.documents.registered(workspace).find(row => row.id === missing.documentId)?.path, missing.path)
})

test('a stalled automatic file read returns timeout within the outer context budget', async t => {
  const f = fixture(t), id = randomUUID()
  f.memory.accept('Archive invoices', origin, id)
  const { workspace, reference } = f.ref(id)
  f.documents.commit({ operationId: 'timeout', workspace, path: 'digest/wiki/invoices.md', action: 'CREATE',
    expectedRevision: null, markdown: 'Archive invoices evidence', sources: [reference], reads: [] })
  await f.memory.wake()
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  f.wrapPhysicalRead(() => async (_workspace, _path, signal) => {
    entered()
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const outer = new AbortController()
  const timer = setTimeout(() => outer.abort(), DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs)
  try {
    const response = f.memory.automaticRecall({ session: origin.session, turn: 1, question: 'Archive invoices' }, origin, () => !outer.signal.aborted, outer.signal)
    await reading
    t.mock.timers.tick(DAILY_MEMORY_DEFAULTS.automaticSearchBudgetMs)
    assert.deepEqual(await response, { status: 'timeout' })
    assert.equal(outer.signal.aborted, false)
  } finally { clearTimeout(timer); t.mock.timers.reset() }
})

test('opening a verified file brings its first publication forward from backoff', async t => {
  const f = fixture(t), source = randomUUID(), path = 'digest/wiki/silver.md'
  f.memory.accept('Silver ledger.', origin, source)
  const { workspace, reference } = f.ref(source)
  await f.memory.wake()
  f.wrapPhysicalRead(read => (area, file, signal) => {
    if (file === path) throw new RequestTimeout()
    return read(area, file, signal)
  })
  const created = f.documents.commit({ operationId: 'silver', workspace, path, action: 'CREATE',
    markdown: 'Silver ledger.', expectedRevision: null, sources: [reference], reads: [] })
  const job = () => f.store.db.prepare("SELECT attempts FROM effects WHERE kind='memory.file-index-publish' AND key=?")
    .get(JSON.stringify([workspace, created.documentId]))
  await f.memory.wake()
  assert.ok(Number(job()?.attempts) > 0)
  f.wrapPhysicalRead(read => read)
  const detail = await f.memory.readFileAsync({ kind: 'digest', workspace, id: created.documentId })
  assert.equal(detail?.markdown, 'Silver ledger.')
  for (let attempt = 0; attempt < 50 && job(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(job(), undefined)
  assert.match(await f.memory.handleModelRequest({ op: 'recall', session: origin.session, query: 'Silver' }, origin, () => true), /Silver ledger/u)
})

test('a restored accepted revision becomes searchable again through targeted index repair', async t => {
  const f = fixture(t), source = randomUUID(), markdown = 'Cobalt preference.'
  f.memory.accept(markdown, origin, source)
  const { workspace, reference } = f.ref(source)
  const receipt = f.documents.commit({ operationId: 'repair-cobalt', workspace, path: 'digest/wiki/cobalt.md',
    action: 'CREATE', markdown, expectedRevision: null, sources: [reference], reads: [] })
  await f.memory.wake()
  const recall = () => f.memory.handleModelRequest({ op: 'recall', session: origin.session, query: 'Cobalt' }, origin, () => true)
  const physical = join(f.store.fileRoot, workspace, receipt.path)
  assert.match(await recall(), /Cobalt preference/u)
  renameSync(physical, physical + '.removed')
  assert.doesNotMatch(await recall(), /Cobalt preference/u)
  // The read schedules a targeted repair outside the caller's latency budget.
  await new Promise(resolve => setTimeout(resolve, 0))
  await f.memory.wake()
  const indexed = () => f.store.db.prepare('SELECT 1 FROM memory_file_index_nodes WHERE workspace=? AND id=?').get(workspace, receipt.documentId)
  assert.equal(indexed(), undefined)
  const pending = () => f.store.db.prepare("SELECT 1 FROM effects WHERE kind='memory.file-index-publish' AND key=?")
    .get(JSON.stringify([workspace, receipt.documentId]))
  assert.equal(pending(), undefined, 'after a confirmed missing file the lazy repair must stop')
  renameSync(physical + '.removed', physical)
  const verified: string[] = []
  f.wrapPhysicalRead(read => (area, path, signal) => { verified.push(path); return read(area, path, signal) })
  for (let hour = 0; hour < 3; hour++) { f.advance(3_600_000); await f.memory.wake() }
  assert.deepEqual(verified, [])
  assert.equal(indexed(), undefined)

  const detail = await f.memory.readFileAsync({ kind: 'digest', workspace, id: receipt.documentId })
  assert.equal(detail?.markdown, markdown)
  await new Promise(resolve => setTimeout(resolve, 0))
  await f.memory.wake()
  assert.ok(indexed())
  assert.equal(pending(), undefined)
  assert.deepEqual([...new Set(verified)], [receipt.path])
  assert.match(await recall(), /Cobalt preference/u)
  assert.equal(f.calls.length, 0)
})

test('unaccepted daily edits and malformed frontmatter are isolated from all file read paths', async t => {
  const f = fixture(t), sourceId = randomUUID()
  f.memory.accept('我喜欢茉莉花茶。', origin, sourceId)
  f.memory.recordNoteTurn!(origin.session, [sourceId], '记下了')
  await f.memory.wake()
  const { workspace, reference } = f.ref(sourceId)
  const safe = f.documents.commit({ operationId: 'safe-tea', workspace, path: 'digest/wiki/tea.md',
    expectedRevision: null, action: 'CREATE', markdown: '我喜欢茉莉花茶。', sources: [reference], reads: [] })
  await f.memory.wake()
  const recall = (query: string) => JSON.parse(f.memory.handle({ op: 'recall', session: origin.session, query }, origin)) as { notes: Array<{id:string,path:string,markdown:string}> }
  const daily = recall('茉莉花茶').notes.find(note => note.path.startsWith('daily/'))!
  assert(daily)
  const physical = join(f.store.fileRoot, workspace, daily.path)
  const original = readFileSync(physical, 'utf8')
  writeFileSync(physical, original.replace('我喜欢茉莉花茶。', '我喜欢从未提及的赤霞珠。'))
  f.memory.rebuildIndexes()
  assert.equal(recall('赤霞珠').notes.length, 0)
  assert.equal(JSON.parse(f.memory.handle({ op: 'file_read', session: origin.session, id: daily.id }, origin)).status, 'unavailable')
  writeFileSync(physical, '---\nname: [broken\n---\n不得注入')
  assert(recall('茉莉花茶').notes.some(note => note.id === safe.documentId))
  assert(!JSON.stringify(recall('不得注入')).includes('不得注入'))
})


test('native file recall deduplicates within a trusted turn and resets for the next turn', async t => {
  const f = fixture(t), sourceId = randomUUID()
  f.memory.accept('银杏部署需要先核对发票。', origin, sourceId)
  const { workspace, reference } = f.ref(sourceId)
  f.documents.commit({ operationId: 'dedup-invoice', workspace, path: 'digest/wiki/dedup.md',
    expectedRevision: null, action: 'CREATE', markdown: '银杏部署需要先核对发票。', sources: [reference], reads: [] })
  const request = { op: 'recall' as const, session: origin.session, query: '发票' }
  await f.memory.wake()
  const recall = async (turn: string, session = origin.session) => JSON.parse(await f.memory.handleModelRequest({ ...request, session },
    { ...origin, session, foregroundTurn: turn }, () => true))
  assert.equal((await recall('1')).status, 'ok')
  assert.equal((await recall('1')).status, 'exhausted')
  assert.equal((await recall('2')).status, 'ok')
  assert.equal((await recall('1', 'other-session')).status, 'ok')
})

test('a refinement and its undo immediately republish the updated file', async t => {
  const f = fixture(t)
  const original = randomUUID()
  f.memory.accept('Indigo code names were retired and replaced by saffron.', origin, original)
  const { workspace, reference } = f.ref(original)
  const created = f.documents.commit({ operationId: 'publication-old', workspace, path: 'digest/wiki/code.md',
    expectedRevision: null, markdown: 'indigo', sources: [reference], reads: [], action: 'CREATE' })
  const recall = (query: string) => f.memory.handle({ op: 'recall', session: origin.session, query }, origin)
  await f.memory.wake()
  assert.match(recall('indigo'), /indigo/u)

  const refined = f.documents.commit({ operationId: 'publication-refine', workspace, path: created.path,
    expectedRevision: created.revision, markdown: 'saffron', sources: [reference], reads: [], action: 'REFINE' })
  await f.memory.wake()
  assert.doesNotMatch(recall('indigo'), /"markdown":"indigo"/u)
  assert.match(recall('saffron'), /saffron/u)

  await f.memory.undoDocument({ operationId: 'publication-undo', workspace, documentId: created.documentId,
    revision: refined.revision!, usageVersion: refined.usageVersion })
  assert.match(recall('indigo'), /indigo/u, 'undo must republish the restored content before the operation completes')
})

test('a temporarily unreadable committed file keeps its publication pending without hiding unrelated files', async t => {
  const f = fixture(t)
  const original = randomUUID()
  f.memory.accept('Citrine and peridot are two unrelated labels.', origin, original)
  const { workspace, reference } = f.ref(original)
  f.documents.commit({ operationId: 'independent-publication', workspace, path: 'digest/wiki/citrine.md',
    expectedRevision: null, markdown: 'citrine', sources: [reference], reads: [], action: 'CREATE' })
  await f.memory.wake()

  const path = 'digest/wiki/peridot.md', physical = join(f.store.fileRoot, workspace, path)
  f.beforePublish(() => renameSync(physical, physical + '.fixture'))
  f.documents.commit({ operationId: 'unreadable-publication', workspace, path,
    expectedRevision: null, markdown: 'peridot', sources: [reference], reads: [], action: 'CREATE' })
  const receipt = f.documents.receipt(workspace, 'unreadable-publication')
  assert.ok(receipt, 'the authority already committed, but the projection cannot verify the physical revision')
  const effect = () => f.store.db.prepare('SELECT generation FROM effects WHERE kind=? AND key=?')
    .get('memory.file-index-publish', JSON.stringify([workspace, receipt.documentId]))
  assert.ok(effect(), 'unverified bytes must not consume pending publication')
  const recall = (query: string) => f.memory.handle({ op: 'recall', session: origin.session, query }, origin)
  assert.match(recall('citrine'), /citrine/u)
  assert.doesNotMatch(recall('peridot'), /peridot/u)
  renameSync(physical + '.fixture', physical)

  await f.memory.searchableReceipt({ operationId: 'unreadable-publication', identity: { kind: 'digest', workspace, id: receipt.documentId },
    action: 'CREATE', contentRevision: receipt.revision!, usageVersion: receipt.usageVersion })
  assert.match(recall('peridot'), /peridot/u)
  assert.equal(effect(), undefined)
})

test('a delayed missing-file repair cannot erase an undo published while repair was reading', { timeout: 8_000 }, async t => {
  const f = fixture(t), source = randomUUID()
  f.memory.accept('Indigo was replaced by saffron. Keep the ledger.', origin, source)
  const { workspace, reference } = f.ref(source)
  const anchor = f.documents.commit({ operationId: 'anchor', workspace, path: 'digest/wiki/anchor.md',
    expectedRevision: null, markdown: 'indigo\nKeep the ledger.', sources: [reference], reads: [], action: 'CREATE' })
  const refined = f.documents.commit({ operationId: 'refine', workspace, path: anchor.path,
    expectedRevision: anchor.revision, markdown: 'saffron\nKeep the ledger.', sources: [reference], reads: [], action: 'REFINE' })
  await f.memory.wake()
  const recall = (query: string) => f.memory.handle({ op: 'recall', session: origin.session, query }, origin)
  assert.match(recall('ledger'), /Keep the ledger/u)
  assert.doesNotMatch(recall('indigo'), /"markdown":"indigo/u)

  const physical = join(f.store.fileRoot, workspace, anchor.path)
  renameSync(physical, physical + '.moved')
  let observed!: () => void, resume!: () => void
  const captured = new Promise<void>(resolve => { observed = resolve })
  const released = new Promise<void>(resolve => { resume = resolve })
  let waitForRepair = true
  f.wrapPhysicalRead(read => async (area, path, signal) => {
    const physical = await read(area, path, signal)
    if (path === anchor.path && waitForRepair) {
      waitForRepair = false
      assert.equal(physical, null)
      observed()
      await released
    }
    return physical
  })
  // The synchronous lookup sees the missing file and schedules an asynchronous repair.
  assert.doesNotMatch(recall('ledger'), /Keep the ledger/u)
  try {
    await captured
    renameSync(physical + '.moved', physical)
    await f.memory.undoDocument({ operationId: 'undo', workspace, documentId: anchor.documentId,
      revision: refined.revision!, usageVersion: refined.usageVersion })
    assert.match(recall('indigo'), /indigo/u)
  } finally { resume() }
  await f.memory.wake()
  assert.match(recall('indigo'), /indigo/u, 'the older repair must preserve the projection published by undo')
})
