import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ChildProcess } from 'node:child_process'
import * as handoff from './fixtures/memory-handoff.ts'
import type { CompactionId, SessionEvent, SessionSeq, FeedItem, HostCapabilities, HostEvent, MemoryFileDetail, MemoryFileListResult, MemoryFileProfile, AgentInfo, IpcRegistry, IpcResults, ModelMessage, Request, Task } from './fixtures/memory-handoff.ts'

const { createHash, randomUUID, fs, mkdirSync, rmSync, writeFileSync, join, Worker, once, Context, compactCheckpointSource, imageOffloadProjection, AttachmentId, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, appendPluginRecord, pluginRecordOf, Session, SessionId, SessionLogOffset, jsonl, SessionTitleProviderId, openMemoryOwner, openNativeOriginalMaintenance, createNativeOutputAttempts, createNativeToolReads, eraseColdNativeCopies, NATIVE_OUTPUT_MARKER, nativeEventDigest, recordCompactionInputs, memoryOriginalContentDigest, openTraceDb, traceStepDigest, setImmediate, delay, createBackend, MEMORY_EMBEDDING_DIMENSIONS, memoryHash, openMemoryStore, SQLITE_BUSY_TIMEOUT_MS, openMemoryDocuments, memorySourceToken, memorySourceWorkspace, openMemoryFileIndex, CODE_ROOT, requestsIn, eventually, openMemoryControlDb, lastWords, questionOf, routeFixtureTools, startFakeLlm, runToCrash, scratch, modelToolResults, MEMORY_EMBEDDING_FINGERPRINT, oldValue, newValue, oldFact, withdrawalCrashFixture, makeScheduleDue, contextGeneration, setup, STOP_AFTER_PTC_READ, rewriteRejectedSource } = handoff

test('a memory control connection waits for a competing writer before installing its PTC fault trigger', async t => {
  const { dir, defer } = scratch(t, 'viva-memory-control-')
  const file = join(dir, 'memory.db'), store = openMemoryStore(file)
  defer(() => store.close())
  store.db.exec('CREATE TABLE owner_native_output_reads(id INTEGER); CREATE TABLE owner_native_tool_reads(id INTEGER)')
  const control = openMemoryControlDb(file), immediate = new DatabaseSync(file)
  defer(() => control.close()); defer(() => immediate.close())
  const writer = new Worker(new URL('./fixtures/memory-sqlite-writer.ts', import.meta.url), { workerData: file })
  defer(() => writer.terminate())
  const exited = once(writer, 'exit'); void exited.catch(() => {})
  assert.deepEqual(await once(writer, 'message'), ['locked'])
  assert.equal(immediate.prepare('PRAGMA busy_timeout').get()?.timeout, 0)
  assert.throws(() => immediate.exec(STOP_AFTER_PTC_READ), (error: unknown) =>
    error instanceof Error && 'errcode' in error && error.errcode === 5,
  'a default connection must fail against the physically held writer, as in the Windows failure')
  const released = once(writer, 'message')
  writer.postMessage('release-soon')
  control.exec(STOP_AFTER_PTC_READ)
  assert.deepEqual(await released, ['released'])
  assert.deepEqual(await exited, [0])
  assert.equal(control.prepare('PRAGMA busy_timeout').get()?.timeout, SQLITE_BUSY_TIMEOUT_MS)
  control.exec('INSERT INTO owner_native_tool_reads VALUES (1)')
  assert.throws(() => control.exec('INSERT INTO owner_native_output_reads VALUES (1)'), /no later PTC model send/u,
    'waiting for preparation must preserve the actual injected fault')
  assert.equal(control.prepare('SELECT COUNT(*) AS n FROM owner_native_output_reads').get()?.n, 0)
})

for (const nextFails of [false, true]) test(`real PTC memory reads archive root/leaf and erase native/spill copies ${nextFails ? 'without a later send' : 'with the normal next send'}`, { timeout: 45_000 }, async t => {
  const prompt = '执行 PTC 记忆读取验收'
  const body = 'The PTC receipt PTC_BODY is independent of the question.' + (nextFails ? '' : ' Long receipt paragraph carrying evidence.'.repeat(85))
  let fileId: string | undefined, requested = false, spillPath: string | undefined, readbackRequested = false
  const app = await setup(t, request => {
    if (spillPath && questionOf(request.messages) === '读取保存的工具长结果' && !readbackRequested) {
      readbackRequested = true
      return { tool: { name: 'read', input: { file_path: spillPath } } }
    }
    const routed = request.messages.flatMap(message => typeof message.content === 'string' ? requestsIn(message.content)
      : (message.content ?? []).flatMap(part => requestsIn(part.text ?? ''))).findLast(row => row.words.startsWith(prompt))
    if (!fileId) return null
    if (routed && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) return { tool: { name: 'start_background_task', input: { title: prompt, brief: 'PTC task execution' } } }
    if (questionOf(request.messages) !== 'PTC task execution') return null
    if (!requested) {
      requested = true
      return { tool: { name: 'run_code', input: { description: 'Read the authorized memory file', code: `const note = await tools.memory_read({id: ${JSON.stringify(fileId)}}); await tools.memory_node_search({query: JSON.parse(note.text).text.slice(0, 400)}); return note;` } } }
    }
    return { text: 'PTC completed.' }
  }, { dailyNotes: true, ptc: true, ptcDrainSpill: !nextFails })
  const created = await app.call<Promise<IpcResults['memory:create-file']>>('memory:create-file', { operationId: randomUUID(), text: body })
  assert.equal(created.status, 'applied')
  fileId = created.receipt.identity.id
  const detail = await app.call<Promise<MemoryFileDetail>>('memory:read-file', created.receipt.identity)
  const memoryRoot = join(app.directory, 'memory'), sessionsRoot = join(app.directory, 'dsh', 'sessions')
  const db = openMemoryControlDb(join(memoryRoot, 'memory.db'))
  try {
    if (nextFails) db.exec(STOP_AFTER_PTC_READ)
    await app.ask(prompt)
    assert.ok(await eventually(() => Number(db.prepare('SELECT count(*) AS n FROM owner_native_tool_calls WHERE result IS NOT NULL').get()?.n) === 3),
      JSON.stringify({ tasks: app.tasks(), errors: app.events.filter(event => event.type === 'error') }))
    if (!nextFails) assert.ok(await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === prompt)))
    let calls = db.prepare('SELECT identity,result FROM owner_native_tool_calls').all()
    assert.equal(calls.length, 3, JSON.stringify({ calls, results: app.model.requests.flatMap(raw => modelToolResults(raw as Request, 'run_code')),
      errors: app.events.filter(event => event.type === 'error') }))
    assert.ok(calls.every(row => row.result !== null))
    const identities = calls.map(row => JSON.parse(String(row.identity)) as { ptc?: unknown, inputDerived?: boolean })
    assert.equal(identities.filter(row => row.ptc).length, 2)
    assert.equal(identities.filter(row => row.inputDerived).length, 1)
    assert.equal(app.model.requests.some(raw => JSON.stringify(modelToolResults(raw as Request, 'run_code')).includes('PTC_BODY')), !nextFails)
    const spills = db.prepare('SELECT intent,file FROM owner_native_spills').all()
    if (!nextFails) {
      assert.equal(spills.length, 2, JSON.stringify(spills))
      assert.equal(fs.existsSync(join(app.directory, 'ptc-drained-read-log')), true)
      assert.ok(spills.every(row => row.file !== null), JSON.stringify(spills))
      for (const row of spills) assert.ok(fs.existsSync((JSON.parse(String(row.file)) as {path:string}).path))
      const leaf = spills.find(row => JSON.parse(String(row.intent)).call.ptc)
      assert.ok(leaf)
      spillPath = (JSON.parse(String(leaf.file)) as {path:string}).path
      if (process.platform !== 'win32') {
        const alias = join(app.directory, 'spill-read-alias.txt')
        fs.symlinkSync(spillPath, alias)
        spillPath = alias
      }
      await app.newTopic()
      await app.ask('读取保存的工具长结果')
      assert.equal(readbackRequested, true)
      assert.ok(app.model.requests.some(raw => JSON.stringify(modelToolResults(raw as Request, 'read')).includes('PTC_BODY')))
      calls = db.prepare('SELECT identity,result FROM owner_native_tool_calls').all()
      assert.equal(calls.length, 4, 'reading an exact spill locator archives a fresh native call readset')
    }
    await app.stopBackend()
    // The native log can commit before the leaf endpoint receipt reaches the owner.
    db.prepare("UPDATE owner_native_tool_calls SET result=NULL WHERE json_extract(identity,'$.ptc') IS NOT NULL").run()
    if (nextFails) db.exec('DROP TRIGGER stop_after_ptc_read')
    const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva',
      compute: () => null, route: () => null, quiesce: async () => {} })
    try {
      await owner.recover()
      await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: created.receipt.identity, version: detail.version }] })
    } finally { await owner.close() }
    const erase = () => eraseColdNativeCopies({ memoryRoot, sessionsRoot, storageRoot: join(app.directory, 'dsh', 'storages'), hostNamespace: 'viva',
      isCold: () => true, trace: { key: () => undefined, erase: () => {} } })
    await erase()
    await erase()
    assert.equal(db.prepare('SELECT count(*) AS n FROM owner_native_tool_calls WHERE result IS NULL').get()?.n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM owner_native_spills WHERE erased=0').get()?.n, 0)
    for (const row of spills) assert.equal(fs.existsSync((JSON.parse(String(row.file)) as {path:string}).path), false)
    const catalog = new Context(), mounted = await catalog.plugin(jsonl, { root: sessionsRoot })
    try {
      for (const row of calls) {
        const call = JSON.parse(String(row.identity)) as {session:string, seq:number, inputDerived?:true}, result = JSON.parse(String(row.result)) as {seq:number}
        const reader = await catalog.sessionPersistence.open(SessionId(call.session), 'read')
        try {
          const event = (await reader.read()).events[result.seq]
          assert.ok(event?.type === 'tool/result' || event?.type === 'tool/ptc-dispatch')
          assert.deepEqual(event.type === 'tool/result' ? event.data.message.content : event.data.content, [])
          if (call.inputDerived) {
            const input = (await reader.read()).events[call.seq]
            assert.equal(input?.type, 'tool/ptc-dispatch-start')
            assert.deepEqual(input.data.arguments, {})
            assert.equal(event.type, 'tool/ptc-dispatch')
            assert.deepEqual(event.data.arguments, {})
          }
        } finally { await reader.close() }
      }
    } finally { await mounted.dispose() }
  } finally { await app.stopBackend(); db.close() }
})

for (const failure of ['reject', 'crash'] as const) test(`PTC read cut recovers secret arguments when the next SDK call ${failure === 'crash' ? 'crashes' : 'is rejected'} during prepare`, { timeout: 45_000 }, async t => {
  const prompt = '验收工具准备阶段边界', brief = 'Prepare a private follow-up tool query', body = 'The prepare-stage value is PREPARE_SECRET.'
  let id: string | undefined, requested = false
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (question === prompt && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) {
      return { tool: { name: 'start_background_task', input: { title: prompt, brief } } }
    }
    if (id && question === brief && !requested) {
      requested = true
      return { tool: { name: 'run_code', input: { description: 'Read and pass private data to a follow-up query',
        code: `const note = await tools.memory_read({id:${JSON.stringify(id)}}); try { await tools.memory_node_search({query: JSON.parse(note.text).text.slice(0, 400)}); } catch {} return note;` } } }
    }
    return null
  }, { dailyNotes: true, ptc: true, ptcFailure: failure })
  const created = await app.call<Promise<IpcResults['memory:create-file']>>('memory:create-file', { operationId: randomUUID(), text: body })
  assert.equal(created.status, 'applied'); id = created.receipt.identity.id
  const detail = await app.call<Promise<MemoryFileDetail>>('memory:read-file', created.receipt.identity)
  await app.ask(prompt)
  if (failure === 'crash') assert.ok(await eventually(() => fs.existsSync(join(app.directory, 'ptc-prepared'))),
    JSON.stringify({ tasks: app.tasks(), errors: app.events.filter(event => event.type === 'error'), results: app.model.requests.flatMap(raw => modelToolResults(raw as Request, 'run_code')) }))
  else assert.ok(await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === prompt)))
  await app.stopBackend()
  const memoryRoot = join(app.directory, 'memory'), sessionsRoot = join(app.directory, 'dsh', 'sessions')
  const db = new DatabaseSync(join(memoryRoot, 'memory.db'))
  try {
    const before = db.prepare('SELECT identity FROM owner_native_tool_calls').all()
    assert.equal(before.length, 2, 'prepare never entered the follow-up body or acquired read authority')
    const cuts = db.prepare('SELECT * FROM owner_native_tool_read_cuts').all()
    assert.ok(cuts.length > 0, 'read evidence and native root cut committed before its private result was delivered')
    assert.doesNotMatch(JSON.stringify(cuts), /PREPARE_SECRET/u)
    const catalog = new Context(), catalogMount = await catalog.plugin(jsonl, { root: sessionsRoot })
    try {
      const origin = JSON.parse(String(before[0]!.identity)) as {session:string}
      const reader = await catalog.sessionPersistence.open(SessionId(origin.session), 'read')
      try {
        const events = (await reader.read()).events
        const start = events.find(event => event.type === 'tool/ptc-dispatch-start' && event.data.name === 'memory_node_search')
        assert.ok(start?.type === 'tool/ptc-dispatch-start')
        assert.match(JSON.stringify(start.data.arguments), /PREPARE_SECRET/u)
        const outcome = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.subCallId === start.data.subCallId)
        if (failure === 'reject') assert.match(JSON.stringify(outcome), /Fixture rejects preparation/u)
        else assert.equal(outcome, undefined, 'the process died before prepare produced any SDK settlement')
      } finally { await reader.close() }
    } finally { await catalogMount.dispose() }
    const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva',
      compute: () => null, route: () => null, quiesce: async () => {} })
    try {
      await owner.recover()
      await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: created.receipt.identity, version: detail.version }] })
    } finally { await owner.close() }
    for (let i = 0; i < 2; i++) await eraseColdNativeCopies({ memoryRoot, sessionsRoot, storageRoot: join(app.directory, 'dsh', 'storages'), hostNamespace: 'viva',
      isCold: () => true, trace: { key: () => undefined, erase: () => {} } })
    const recovered = db.prepare("SELECT identity,result FROM owner_native_tool_calls WHERE json_extract(identity,'$.inputDerived')=1").all()
    assert.equal(recovered.length, 1)
    const call = JSON.parse(String(recovered[0]!.identity)) as { session: string, seq: number }
    const context = new Context(), mounted = await context.plugin(jsonl, { root: sessionsRoot })
    try {
      const reader = await context.sessionPersistence.open(SessionId(call.session), 'read')
      try {
        const events = (await reader.read()).events, start = events[call.seq]
        assert.equal(start?.type, 'tool/ptc-dispatch-start')
        assert.deepEqual(start.data.arguments, {})
        assert.doesNotMatch(JSON.stringify(events), /PREPARE_SECRET/u)
      } finally { await reader.close() }
    } finally { await mounted.dispose() }
    const admin = openNativeOriginalMaintenance(memoryRoot, 'viva')!
    try { assert.deepEqual(admin.unsettledReceipts().tools, []) } finally { admin.close() }
  } finally { db.close() }
})

test('a real DSH tool read archives and erases native results even when the next model send fails', { timeout: 45_000 }, async t => {
  const text = 'The file-only proof ORDINAL controls the native result.'
  const prompt = '执行单次工具归档测试'
  let fileId: string | undefined, requested = false
  const app = await setup(t, request => {
    if (requested || !fileId || questionOf(request.messages) !== prompt) return null
    requested = true
    return { tool: { name: 'memory_read', input: { id: fileId } } }
  }, { dailyNotes: true })
  const created = await app.call<Promise<IpcResults['memory:create-file']>>('memory:create-file', { operationId: randomUUID(), text })
  assert.equal(created.status, 'applied')
  fileId = created.receipt.identity.id
  const file = await app.call<Promise<MemoryFileDetail>>('memory:read-file', created.receipt.identity)
  const source = file.sources[0]
  assert.ok(source?.sourceId)
  const memoryRoot = join(app.directory, 'memory')
  const control = new DatabaseSync(join(memoryRoot, 'memory.db'))
  let affected: ReturnType<ReturnType<typeof createNativeToolReads>['affected']> = []
  let precedingSendUsedFile = false
  try {
    control.exec(`CREATE TRIGGER fail_body_after_tool_read BEFORE INSERT ON owner_native_output_reads
      WHEN EXISTS(SELECT 1 FROM owner_native_tool_reads)
      BEGIN SELECT RAISE(ABORT, 'no model request may consume the tool result'); END`)
    await app.ask(prompt)
    assert.equal(requested, true)
    const receipts = createNativeToolReads(control)
    affected = await eventually(() => {
      const found = receipts.affected([{ sourceId: source.sourceId, spans: [{ start: 0, end: text.length }] }])
      return found.some(call => call.result) ? found : undefined
    }) ?? []
    assert.equal(affected.length, 1, JSON.stringify({
      calls: control.prepare('SELECT identity,result FROM owner_native_tool_calls').all(),
      seen: app.model.requests.flatMap(raw => modelToolResults(raw as Request, 'memory_read')),
      errors: app.events.filter(event => event.type === 'error'),
    }))
    assert.ok(affected[0]?.result)
    assert.doesNotMatch(JSON.stringify(control.prepare('SELECT evidence FROM owner_native_tool_reads').all()), /ORDINAL/)
    assert.ok(app.model.requests.every(raw => modelToolResults(raw as Request, 'memory_read').length === 0),
      'the next physical request must not get the tool result')
    precedingSendUsedFile = app.model.requests.some(raw => JSON.stringify(raw).includes(text))
  } finally {
    await app.stopBackend()
    control.close()
  }
  const saved = affected[0]!, result = saved.result!
  const lostReceipt = new DatabaseSync(join(memoryRoot, 'memory.db'))
  try { lostReceipt.prepare('UPDATE owner_native_tool_calls SET result=NULL WHERE id=?').run(saved.id) } finally { lostReceipt.close() }
  const sessionsRoot = join(app.directory, 'dsh', 'sessions')
  const sessionId = SessionId(saved.session), forkId = SessionId(randomUUID())
  const provider = new Context(), mounted = await provider.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  let pruned = -1, independent = -1
  try {
    const reader = await provider.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await reader.read()
      const call = events[saved.seq], outcome = events[result.seq]
      assert.equal(call?.type, 'tool/call')
      assert.equal(outcome?.type, 'tool/result')
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
      assert.equal(digest(call), saved.digest)
      assert.equal(digest(outcome), result.digest)
      assert.deepEqual(outcome.sourceEventSeqs, [saved.seq])
      assert.match(JSON.stringify(outcome.data.message.content), /ORDINAL/)
      const inherited = SessionLogOffset(events.length)
      const child = Session.create(forkId, events, { ...reader.header, id: forkId, isSeeded: true }, inherited, [imageOffloadProjection])
      const turn = (events.findLast(event => event.type === 'turn/end')?.data.turn ?? 0) + 1, step = 1
      child.append('turn/start', { turn })
      child.append('step/start', { turn, step })
      child.append('compaction/prune', { shadowedRange: { start: outcome.seq, end: outcome.seq }, shadowedSeqs: [outcome.seq], shadowedTokenCount: 1 })
      pruned = child.append('tool/result', { ...outcome.data,
        message: { ...outcome.data.message, content: [{ type: 'text', text: 'Pruned ORDINAL' }] },
      }, { surfaceOp: { op: 'replace', startSeq: outcome.seq, endSeq: outcome.seq }, sourceEventSeqs: [outcome.seq] }).seq
      const other = ToolCallId('independent-tool-call')
      const block = { type: 'tool-call' as const, name: 'memory_read', id: other, arguments: '{}' }
      child.append('assistant/message', { turn, step,
        message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [block] }), stream: [],
      }, { surfaceOp: 'append' })
      const otherCall = child.append('tool/call', { turn, step, callId: other, name: block.name, arguments: block.arguments })
      independent = child.append('tool/result', { turn, step,
        message: createToolResultMessage({ callId: other, isError: false, content: [{ type: 'text', text: 'Unrelated ORDINAL' }] }),
      }, { surfaceOp: 'append', sourceEventSeqs: [otherCall.seq] }).seq
      child.append('step/end', { turn, step })
      child.append('turn/end', { turn, reason: { kind: 'completed' } })
      const writer = await provider.sessionPersistence.create(child.header, { inheritedEventCount: inherited })
      try { await writer.append(child.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    } finally { await reader.close() }
  } finally { await mounted.dispose() }

  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva', dailyNotes: true,
    compute: () => null, route: () => null, quiesce: async () => {} })
  const operationId = randomUUID()
  try {
    await owner.recover()
    await owner.handleHost('forgetFile', { args: [{ operationId, identity: created.receipt.identity, version: file.version }] })
  } finally { await owner.close() }

  openNativeOriginalMaintenance(memoryRoot, 'viva')!.close()
  const db = new DatabaseSync(join(memoryRoot, 'memory.db'))
  try {
    db.exec(`CREATE TRIGGER interrupt_native_tool_receipt BEFORE UPDATE OF published ON owner_native_output_publications
      WHEN OLD.operation LIKE '%:tool-results' BEGIN SELECT RAISE(ABORT, 'crash before native tool result receipt'); END`)
    assert.equal(await app.startBackend(), null)
    assert.equal(db.prepare('SELECT count(*) AS total FROM owner_native_output_publications WHERE operation=? AND published=0')
      .get(operationId + ':tool-results')?.total, 1)
    await app.stopBackend()
    db.exec('DROP TRIGGER interrupt_native_tool_receipt')
    assert.ok(await app.startBackend(), 'recover the interrupted publication before live DSH begins')
    assert.ok(db.prepare('SELECT 1 FROM owner_native_output_erased WHERE attempt=?').get(saved.id))
  } finally { db.close() }
  await app.stopBackend()

  const verify = new Context(), installed = await verify.plugin(jsonl, { root: sessionsRoot })
  try {
    for (const id of [sessionId, forkId]) {
      const reader = await verify.sessionPersistence.open(id, 'read')
      try {
        const { events } = await reader.read()
        const caller = events[saved.seq]
        assert.equal(caller?.type, 'tool/call')
        if (precedingSendUsedFile) assert.equal(caller.data.arguments, '{}')
        else assert.equal(nativeEventDigest(caller), saved.digest, 'the independent caller is retained')
        const rewritten = events[result.seq]
        assert.equal(rewritten?.type, 'tool/result')
        assert.deepEqual(rewritten.data.message.content, [])
        assert.deepEqual(rewritten.sourceEventSeqs, [saved.seq])
        if (id === forkId) {
          const staleExcerpt = events[pruned], unrelated = events[independent]
          assert.equal(staleExcerpt?.type, 'tool/result')
          assert.deepEqual(staleExcerpt.data.message.content, [])
          assert.equal(unrelated?.type, 'tool/result')
          assert.match(JSON.stringify(unrelated.data.message.content), /Unrelated ORDINAL/)
        }
      } finally { await reader.close() }
    }
  } finally { await installed.dispose() }
})

test('trace erasure preserves another projection that reused the same session and sequence', t => {
  const { dir, defer } = scratch(t, 'viva-trace-reused-offset-')
  const trace = openTraceDb({ file: join(dir, 'trace.db') })
  defer(() => trace.close())
  const session = randomUUID()
  const original = { kind: 'thought', seq: 18, at: 10, text: 'discarded generation' } as const
  const retained = { ...original, at: 20, text: 'independent later generation' }
  trace.recordSteps(session, [retained])
  assert.equal(trace.eraseSteps(session, [{ seq: original.seq, digest: traceStepDigest(original) }]), true)
  assert.deepEqual(trace.stepsOf(session), [retained])
})
