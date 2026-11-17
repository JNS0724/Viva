import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ChildProcess } from 'node:child_process'
import * as handoff from './fixtures/memory-handoff.ts'
import type { CompactionId, SessionEvent, SessionSeq, FeedItem, HostCapabilities, HostEvent, MemoryFileDetail, MemoryFileListResult, MemoryFileProfile, AgentInfo, IpcRegistry, IpcResults, ModelMessage, Request, Task } from './fixtures/memory-handoff.ts'

const { createHash, randomUUID, fs, mkdirSync, rmSync, writeFileSync, join, Worker, once, Context, compactCheckpointSource, imageOffloadProjection, AttachmentId, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, appendPluginRecord, pluginRecordOf, Session, SessionId, SessionLogOffset, jsonl, SessionTitleProviderId, openMemoryOwner, openNativeOriginalMaintenance, createNativeOutputAttempts, createNativeToolReads, eraseColdNativeCopies, NATIVE_OUTPUT_MARKER, nativeEventDigest, recordCompactionInputs, memoryOriginalContentDigest, openTraceDb, traceStepDigest, setImmediate, delay, createBackend, MEMORY_EMBEDDING_DIMENSIONS, memoryHash, openMemoryStore, SQLITE_BUSY_TIMEOUT_MS, openMemoryDocuments, memorySourceToken, memorySourceWorkspace, openMemoryFileIndex, CODE_ROOT, requestsIn, eventually, openMemoryControlDb, lastWords, questionOf, routeFixtureTools, startFakeLlm, runToCrash, scratch, modelToolResults, MEMORY_EMBEDDING_FINGERPRINT, oldValue, newValue, oldFact, withdrawalCrashFixture, makeScheduleDue, contextGeneration, setup, STOP_AFTER_PTC_READ, rewriteRejectedSource } = handoff

test('cold Viva startup erases native originals and settled output in root and unseen fork logs', { timeout: 45_000 }, async t => {
  const erased = '实体擦除样本只用于 R5a 验收', nearby = '独立片段仍在同一原生日志中'
  const second = '另一个有独立依据的原文裁剪目标'
  const survivor = '独立消息要在恢复后继续可用'
  const derived = '档案里还有应擦除的助手转述'
  const traceSecret = 'stored-private-trace-for-erasure'
  const toolSecret = 'stored-derived-tool-argument-and-result'
  const compactionSecret = 'stored-private-compaction-body'
  const text = [erased, nearby, second].join('。\n')
  const app = await setup(t, request => {
    const routed = request.messages.flatMap(message => typeof message.content === 'string'
      ? requestsIn(message.content) : (message.content ?? []).flatMap(part => requestsIn(part.text ?? ''))).at(-1)
    return routed?.words.startsWith(text) && modelToolResults(request, 'commit_route').length ? { text: derived } : null
  }, { dailyNotes: true })
  const sourceId = await app.ask(text)
  const reply = app.events.find(event => event.type === 'update' && event.update.sessionUpdate === 'viva_stream'
    && event.update.kind === 'settle' && event.update.blocks.some((block: { text?: string }) => block.text === derived))
  assert.ok(reply, 'real DSH provides a settled reply under a stable stream key')
  const survivorId = await app.ask(survivor)
  const savedHistory = await app.call<{ id: string }>('history:save', [
    { role: 'user', text, receipt: null, sourceId },
    { role: 'assistant', text: derived, receipt: null, key: reply.update.key },
    { role: 'user', text: survivor, receipt: null, sourceId: survivorId },
  ])
  assert.match(JSON.stringify(app.call('history:load')), new RegExp(derived, 'u'), 'authenticated reply survives its first history save')
  const info = app.call<AgentInfo>('agent:info')
  assert.ok(info.sessionId)
  await app.stopBackend()
  const sessionsRoot = join(app.directory, 'dsh', 'sessions')
  const memoryRoot = join(app.directory, 'memory')
  const parentId = SessionId(info.sessionId), forkId = SessionId(randomUUID())
  const affectedOutputs = new Set<number>()
  let traceStep: { kind: 'thought', seq: number, at: number, text: string } | undefined
  let toolTrace: { kind: 'tool', seq: number, at: number, callId: string, name: string, args: object, status: string } | undefined
  let toolReply = -1, toolResult = -1
  const compactions = new Set<number>()
  let unconnectedSummary = -1
  let derivedInjection: import('@deepseek-ai/dsh-llm').UserMessage | undefined
  const cold = new Context(), persistence = await cold.plugin(jsonl, { root: sessionsRoot })
  try {
    const original = await cold.sessionPersistence.open(parentId, 'read')
    try {
      const persisted = (await original.read()).events
      const fixture = Session.fromRestore(parentId, persisted, original.header, original.inheritedEventCount, 'detached')
      const titleMessage = persisted.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
        && JSON.stringify(event.data.content).includes(erased))
      assert.ok(titleMessage, 'an authentic human message supplies title provenance')
      fixture.append('session/title', { title: erased, messageSeqs: [titleMessage.seq], source: { kind: 'fallback' } })
      fixture.append('session/title-llm-request', { titleProvider: SessionTitleProviderId('fixture'), messageSeqs: [titleMessage.seq],
        route: { provider: 'fixture', model: 'fixture' }, system: erased, maxTokens: 16,
        messages: [createUserMessage({ source: { kind: 'dsh-session-title-llm' }, content: [{ type: 'text', text: second }] })] })
      const independentTitleMessage = persisted.find(event => event.type === 'user/message'
        && event.data.source.kind === 'user' && JSON.stringify(event.data.content).includes(survivor))
      assert.ok(independentTitleMessage)
      fixture.append('session/title', { title: '独立依据生成的会话名', messageSeqs: [independentTitleMessage.seq], source: { kind: 'fallback' } })
      fixture.append('session/title', { title: '独立的手动会话名', messageSeqs: [], source: { kind: 'user' } })
      const turn = (persisted.findLast(event => event.type === 'turn/end')?.data.turn ?? 0) + 1
      const step = 1, at = Date.now()
      fixture.append('turn/start', { turn })
      fixture.append('step/start', { turn, step })
      const bindAttempt = () => {
        const marker = { id: randomUUID(), generation: 0, turn, step }
        const floor = appendPluginRecord(fixture, NATIVE_OUTPUT_MARKER, marker) + 1
        return { ...marker, session: parentId, floor }
      }
      const failedProof = bindAttempt()
      const failed = fixture.append('assistant/attempt', { turn, step,
        stream: [{ type: 'chunk', time: at, chunk: { type: 'text-delta', index: 0, text: traceSecret } }] })
      const reasoningProof = bindAttempt()
      const reasoning = fixture.append('assistant/message', { turn, step,
        message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'reasoning', text: traceSecret }] }),
        stream: [{ type: 'chunk', time: at, chunk: { type: 'reasoning-delta', index: 0, text: traceSecret } }],
      }, { surfaceOp: 'append' })
      const groupProof = bindAttempt()
      const tool = { type: 'tool-call' as const, id: ToolCallId('derived-native-tool'), name: 'bash', arguments: JSON.stringify({ command: toolSecret }) }
      const announcement = fixture.append('assistant/message', { turn, step,
        message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: toolSecret }, tool] }),
        stream: [{ type: 'chunk', time: at, chunk: { type: 'tool-call-delta', index: 1, id: tool.id, name: tool.name, argumentsDelta: tool.arguments } }],
      }, { surfaceOp: 'append' })
      const call = fixture.append('tool/call', { turn, step, callId: tool.id, name: tool.name, arguments: tool.arguments })
      const result = fixture.append('tool/result', { turn, step,
        message: createToolResultMessage({ callId: tool.id, content: [{ type: 'text', text: toolSecret }], isError: true }),
        error: { name: 'ToolError', code: 'FAILED', reason: toolSecret }, meta: { body: toolSecret },
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      toolReply = announcement.seq
      toolResult = result.seq
      toolTrace = { kind: 'tool', seq: call.seq, at: call.time, callId: tool.id, name: tool.name,
        args: { command: toolSecret }, status: 'failed' }
      fixture.append('step/end', { turn, step })
      fixture.append('turn/end', { turn, reason: { kind: 'completed' } })
      function compact(shadowedSeqs: SessionSeq[], text: string) {
        const compactionId = randomUUID() as CompactionId
        const start = fixture.append('compaction/start', { compactionId, turn: null })
        const region = { start: shadowedSeqs[0]!, end: shadowedSeqs.at(-1)! }
        const content = [{ type: 'text' as const, text }]
        const summary = fixture.append('compaction/summary', { compactionId, summary: content, rawOutput: content, llmStreamCall: true,
          shadowedRange: region, shadowedSeqs, shadowedTokenCount: 99, provider: 'fixture', model: 'fixture' })
        const checkpoint = fixture.append('user/message', createUserMessage({ source: compactCheckpointSource(compactionId), content }),
          { surfaceOp: { op: 'replace', startSeq: region.start, endSeq: region.end }, sourceEventSeqs: [start.seq, summary.seq, ...shadowedSeqs] })
        fixture.append('compaction/end', { compactionId, turn: null })
        return { summary: summary.seq, checkpoint: checkpoint.seq }
      }
      const failedCompactionId = randomUUID() as CompactionId
      fixture.append('compaction/start', { compactionId: failedCompactionId, turn: null })
      recordCompactionInputs(fixture, [titleMessage.seq])
      compactions.add(fixture.append('compaction/end', { compactionId: failedCompactionId, turn: null, error: compactionSecret }).seq)
      const compactedOriginal = compact([titleMessage.seq], compactionSecret)
      const compactedCheckpoint = compact([compactedOriginal.checkpoint], compactionSecret)
      const compactedTool = compact([announcement.seq, result.seq], compactionSecret)
      derivedInjection = createUserMessage({ source: { kind: 'viva-memory' }, content: [{ type: 'text', text: compactionSecret }] })
      const injection = fixture.append('user/message', derivedInjection, { surfaceOp: 'append' })
      const compactedInjection = compact([injection.seq], compactionSecret)
      for (const item of [compactedOriginal, compactedCheckpoint, compactedTool, compactedInjection]) {
        compactions.add(item.summary)
        compactions.add(item.checkpoint)
      }
      unconnectedSummary = compact([independentTitleMessage.seq], 'independent compaction remains').summary
      const writer = await cold.sessionPersistence.open(parentId, 'write')
      try { await writer.append(fixture.snapshotEvents(SessionLogOffset(persisted.length))); await writer.flush() }
      finally { await writer.close() }
      traceStep = { kind: 'thought', seq: reasoning.seq, at: reasoning.time, text: traceSecret }

      const events = fixture.snapshotEvents()
      assert.ok(JSON.stringify(events).includes(erased))
      assert.ok(JSON.stringify(events).includes(derived))
      const proofDb = new DatabaseSync(join(memoryRoot, 'memory.db'))
      try {
        const archive = createNativeOutputAttempts(proofDb)
        const evidence = { sources: [sourceId], epoch: 0, turnOnly: false }
        archive.record(failedProof, evidence)
        // The native event committed before a crash could store its settlement receipt.
        affectedOutputs.add(failed.seq)
        archive.record(reasoningProof, evidence)
        archive.finish(reasoningProof, { seq: reasoning.seq, kind: 'reply', digest: nativeEventDigest(reasoning) })
        archive.record(groupProof, evidence)
        archive.finish(groupProof, { seq: announcement.seq, kind: 'reply', digest: nativeEventDigest(announcement) })
        const affected = archive.affected([{ sourceId, spans: [{ start: 0, end: erased.length }] }])
        assert.ok(affected.length >= 2, 'real DSH foreground sends must bind proof before handing over their model payload')
        for (const { result, session, floor, id, generation, turn, step } of affected) {
          assert.equal(session, parentId)
          const prefix = events[floor - 1]
          const marker = prefix && pluginRecordOf(prefix)
          assert.equal(marker?.type, NATIVE_OUTPUT_MARKER)
          assert.deepEqual(marker.data, { id, generation, turn, step })
          if (result.state === 'open') {
            assert.equal(id, failedProof.id)
            continue
          }
          assert.equal(result.state, 'settled')
          const event = events[result.terminal.seq]
          assert.ok(event?.type === 'assistant/message' || event?.type === 'assistant/attempt')
          assert.equal(nativeEventDigest(event), result.terminal.digest)
          if (event.type === 'assistant/attempt' || !event.data.message.content.some(block => block.type === 'tool-call')) {
            affectedOutputs.add(event.seq)
          }
        }
      } finally { proofDb.close() }
      const inherited = SessionLogOffset(events.length)
      const child = Session.create(forkId, events, { ...original.header, id: forkId, isSeeded: true }, inherited, [imageOffloadProjection])
      const image = child.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{
        type: 'image', attachment: { attachmentId: AttachmentId('cold-offload'), mediaType: 'image/png', bytes: 80, width: 1, height: 1 },
      }] }), { surfaceOp: 'append' })
      child.append('image/offload', { targets: [{ seq: image.seq, imageIndexes: [0] }] })
      const branchWriter = await cold.sessionPersistence.create(child.header, { inheritedEventCount: inherited })
      try { await branchWriter.append(child.snapshotEvents()); await branchWriter.flush() } finally { await branchWriter.close() }
    } finally { await original.close() }
  } finally { await persistence.dispose() }

  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva', dailyNotes: true,
    compute: () => null, route: () => null, quiesce: async () => {} })
  const operationId = randomUUID(), nextOperation = randomUUID()
  try {
    await owner.recover()
    assert.ok(derivedInjection)
    await owner.registerDerived({ sessionId: parentId, messageId: derivedInjection.id, sourceIds: [sourceId], nativeUserSource: 'viva-memory',
      contentDigest: memoryOriginalContentDigest(derivedInjection) })
    const store = openMemoryStore(join(memoryRoot, 'memory.db'))
    try {
      assert.equal(store.db.prepare('SELECT 1 FROM owner_occurrences WHERE session=?').get(forkId), undefined)
      const source = store.readSource(sourceId)!
      const workspace = memorySourceWorkspace(source)
      const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, deferRecovery: true, source(id) {
        const row = store.readSource(id)
        return row?.text ? { text: row.text, workspace: memorySourceWorkspace(row), token: memorySourceToken(row) } : undefined
      } })
      const makeDigest = (name: string, excerpt: string) => {
        const start = text.indexOf(excerpt)
        const entry = documents.commit({ operationId: randomUUID(), workspace, path: `digest/wiki/${name}.md`,
          action: 'CREATE', expectedRevision: null, markdown: excerpt,
          sources: [{ id: sourceId, token: memorySourceToken(source), spans: [{ start, end: start + excerpt.length }] }], reads: [] })
        return { kind: 'digest', workspace, id: entry.documentId } as const
      }
      const first = makeDigest('native-erasure', erased), secondDigest = makeDigest('native-erasure-2', second)
      for (const [identity, id] of [[first, operationId], [secondDigest, nextOperation]] as const) {
        const detail = await owner.handleHost('readFile', { args: [identity] }) as MemoryFileDetail
        await owner.handleHost('forgetFile', { args: [{ operationId: id, identity, version: detail.version }] })
      }
    } finally { store.close() }
  } finally { await owner.close() }

  const cache = join(app.directory, 'dsh', 'storages', 'session_projcache', 'sessions')
  mkdirSync(cache, { recursive: true })
  const interruptedCache = join(cache, `${forkId}.json.deleting`)
  const backupCache = join(cache, `${parentId}.json.bak.202611161700`)
  const independentCache = join(cache, 'independent.json.deleting')
  const projectionTemp = join(cache, `.${randomUUID()}.tmp`)
  for (const file of [interruptedCache, backupCache, independentCache, projectionTemp]) writeFileSync(file, erased)

  openNativeOriginalMaintenance(memoryRoot, 'viva')!.close()
  const control = new DatabaseSync(join(memoryRoot, 'memory.db'))
  try {
    control.exec(`CREATE TRIGGER interrupt_native_publication BEFORE UPDATE OF published ON owner_native_original_publications
      BEGIN SELECT RAISE(ABORT, 'interrupted native erasure receipt'); END`)
    const offset = app.model.requests.length
    assert.equal(await app.startBackend(), null, 'a published artifact without a receipt must stop live DSH from opening its log')
    assert.equal(app.model.requests.length, offset)
    const blockedTrace = await app.call<Promise<{ available: boolean }>>('history:trace', savedHistory.id)
    assert.equal(blockedTrace.available, false)
    assert.doesNotMatch(JSON.stringify(blockedTrace), new RegExp(traceSecret, 'u'))
    assert.equal(control.prepare('SELECT count(*) AS count FROM owner_native_original_publications WHERE operation=? AND published=0')
      .get(operationId)?.count, 1)
    await app.stopBackend()
    control.exec('DROP TRIGGER interrupt_native_publication')
  } finally { control.close() }

  assert.ok(traceStep && affectedOutputs.has(traceStep.seq), 'the verified native output owns the reasoning trace')
  assert.ok(toolTrace)
  const traceFile = join(app.directory, 'trace.db')
  const independentTraceSession = randomUUID()
  const awaitingToolCleanup = 'pending-native-tool-replica'
  const trace = openTraceDb({ file: traceFile })
  try {
    trace.recordSteps(parentId, [traceStep, toolTrace])
    trace.recordSteps(forkId, [traceStep, { ...toolTrace, status: 'in_progress' }])
    trace.recordSteps(independentTraceSession, [{ ...traceStep, text: 'independent trace' }])
    trace.recordSteps(parentId, [{ kind: 'tool', seq: traceStep.seq + 1, at: Date.now(), callId: 'pending-tool', name: 'bash',
      args: { command: awaitingToolCleanup }, status: 'completed' }])
  } finally { trace.close() }

  const traceReader = new DatabaseSync(traceFile, { readOnly: true })
  try {
    traceReader.exec('BEGIN')
    assert.equal(traceReader.prepare('SELECT text FROM steps WHERE session_id=? AND seq=?').get(parentId, traceStep.seq)?.text, traceSecret)
    const offset = app.model.requests.length
    assert.equal(await app.startBackend(), null, 'a trace reader that still sees erased bytes must delay starting DSH')
    assert.equal(app.model.requests.length, offset)
    await app.stopBackend()
  } finally { traceReader.close() }

  const offset = app.model.requests.length
  assert.ok(await app.startBackend())
  const cleanHistory = app.call('history:read', `s:${savedHistory.id}`, { from: Number.MAX_SAFE_INTEGER, count: 10 })
  assert.doesNotMatch(JSON.stringify(cleanHistory), new RegExp(derived, 'u'), 'the generated host history copy is erased during recovery')
  assert.match(JSON.stringify(cleanHistory), new RegExp(survivor, 'u'))
  const publishedTrace = openTraceDb({ file: traceFile })
  try {
    assert.equal(publishedTrace.stepsOf(parentId).some(step => step.seq === traceStep.seq), false)
    assert.equal(publishedTrace.stepsOf(forkId).some(step => step.seq === traceStep.seq), false)
    assert.equal(publishedTrace.stepsOf(independentTraceSession).length, 1)
    assert.ok([parentId, forkId].every(session => publishedTrace.stepsOf(session).every(step => step.seq !== toolTrace.seq)))
    assert.match(JSON.stringify(publishedTrace.stepsOf(parentId)), new RegExp(awaitingToolCleanup, 'u'))
    for (const file of [traceFile, traceFile + '-wal']) if (fs.existsSync(file)) {
      assert.equal(fs.readFileSync(file).includes(traceSecret), false)
      assert.equal(fs.readFileSync(file).includes(toolSecret), false)
    }
  } finally { publishedTrace.close() }
  assert.ok(await eventually(() => app.events.some(event => event.type === 'memory_changed' && event.traceSessions?.includes(parentId))))
  const safeTrace = await app.call<Promise<{ available: boolean }>>('history:trace', savedHistory.id)
  assert.equal(safeTrace.available, true)
  assert.doesNotMatch(JSON.stringify(safeTrace), new RegExp([traceSecret, toolSecret].join('|'), 'u'))
  const rewindTrace = await app.call<Promise<{ commands: string[] }>>('timeline:rewind-effects', { keep: 0 })
  assert.ok(rewindTrace.commands.includes(awaitingToolCleanup), 'independent trace content becomes readable after all participants finish')
  assert.equal(fs.existsSync(interruptedCache), false)
  assert.equal(fs.existsSync(backupCache), false)
  assert.equal(fs.existsSync(projectionTemp), false)
  assert.equal(fs.readFileSync(independentCache, 'utf8'), erased)
  assert.equal(app.call<AgentInfo>('agent:info').sessionId, info.sessionId)
  assert.ok(contextGeneration(app.directory, info.sessionId) > 0)
  const question = '验证冷启动后还能继续使用安全历史'
  const questionId = await app.ask(question)
  const sent = app.model.requests.slice(offset) as Request[]
  assert.ok(sent.some(request => questionOf(request.messages) === question && JSON.stringify(request.messages).includes(survivor)))
  assert.ok(sent.every(request => ![erased, second].some(removed => JSON.stringify(request.messages).includes(removed))))

  const reopened = new Context(), mounted = await reopened.plugin(jsonl, { root: sessionsRoot })
  try {
    for (const id of [parentId, forkId]) {
      const reader = await reopened.sessionPersistence.open(id, 'read')
      try {
        const { events } = await reader.read()
        if (id === forkId) assert.ok(events.some(event => event.type === 'image/offload'))
        const rawInputs = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
        const raw = JSON.stringify(rawInputs)
        assert.ok(raw.includes(survivor) && raw.includes(nearby))
        assert.ok(!raw.includes(erased) && !raw.includes(second))
        const titles = events.filter(event => event.type === 'session/title' || event.type === 'session/title-llm-request')
        assert.ok(titles.some(event => event.type === 'session/title' && event.data.source.kind === 'user' && event.data.title === '独立的手动会话名'))
        assert.ok(titles.some(event => event.type === 'session/title' && event.data.title === '独立依据生成的会话名'))
        assert.ok(titles.some(event => event.type === 'session/title' && event.data.source.kind === 'fallback' && event.data.title === '…'))
        assert.doesNotMatch(JSON.stringify(titles), new RegExp([erased, second].join('|'), 'u'))
        const memoryInjected = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'viva-memory' ? [event.data]
          : event.type === 'agent/inbox/spliced' ? event.data.inserted.filter(message => message.source.kind === 'viva-memory') : [])
        assert.ok(memoryInjected.some(message => !message.content.length), 'the authenticated memory injection is physically erased')
        assert.doesNotMatch(JSON.stringify(memoryInjected), new RegExp([erased, second].join('|'), 'u'))
        const generated = events.filter(event => affectedOutputs.has(event.seq))
        assert.equal(generated.length, affectedOutputs.size)
        for (const event of generated) {
          assert.ok(event.type === 'assistant/message' || event.type === 'assistant/attempt')
          if (event.type === 'assistant/message') {
            assert.deepEqual(event.data.message.content, [])
            assert.equal(event.data.message.source.replayState, undefined)
          }
          assert.ok(event.data.stream.every(record => record.type === 'chunk' && record.chunk.type === 'usage'))
        }
        assert.doesNotMatch(JSON.stringify(generated), new RegExp([derived, traceSecret].join('|'), 'u'))
        const announcement = events[toolReply], outcome = events[toolResult]
        const call: SessionEvent | undefined = events[toolTrace.seq]
        assert.equal(announcement?.type, 'assistant/message')
        assert.equal(call?.type, 'tool/call')
        assert.equal(outcome?.type, 'tool/result')
        assert.deepEqual(announcement.data.message.content, [{ type: 'tool-call', id: toolTrace.callId, name: toolTrace.name, arguments: '{}' }])
        assert.deepEqual(announcement.data.stream.map(record => record.type === 'chunk' && record.chunk.type), ['tool-call-delta'])
        assert.equal(call.data.arguments, '{}')
        assert.deepEqual(outcome.sourceEventSeqs, [call.seq])
        assert.equal(outcome.data.message.toolCallId, toolTrace.callId)
        assert.deepEqual(outcome.data.message.content, [])
        assert.deepEqual(outcome.data.error, { name: 'ToolError', code: 'FAILED' })
        assert.equal(outcome.data.meta, undefined)
        assert.doesNotMatch(JSON.stringify(events), new RegExp(toolSecret, 'u'))
        const rewrittenCompactions = events.filter(event => compactions.has(event.seq))
        assert.equal(rewrittenCompactions.length, 9)
        assert.doesNotMatch(JSON.stringify(rewrittenCompactions), new RegExp(compactionSecret, 'u'))
        assert.match(JSON.stringify(events[unconnectedSummary]), /independent compaction remains/)
      } finally { await reader.close() }
    }
  } finally { await mounted.dispose() }
  const settled = new DatabaseSync(join(memoryRoot, 'memory.db'), { readOnly: true })
  try {
    assert.equal(settled.prepare('SELECT count(*) AS count FROM owner_native_original_publications WHERE operation=? AND published=1').get(operationId)?.count, 2)
    assert.equal(settled.prepare('SELECT count(*) AS count FROM owner_native_original_publications WHERE operation=? AND published=1').get(nextOperation)?.count, 2)
    for (const id of [operationId, nextOperation]) {
      assert.ok(settled.prepare('SELECT 1 FROM owner_native_original_completed WHERE operation=?').get(id))
      assert.ok(settled.prepare('SELECT 1 FROM owner_native_cleanup_receipts WHERE operation=?').get(id))
      assert.equal(settled.prepare('SELECT acked FROM owner_host_effects WHERE id=?').get(id)?.acked, 1)
    }
    assert.ok(settled.prepare('SELECT 1 FROM owner_file_native_erasures WHERE operation=?').get(operationId),
      'the immutable native plan remains available after its participant acknowledges')
    assert.ok(settled.prepare('SELECT 1 FROM owner_native_surface_invalidations WHERE session=?').get(forkId))
    assert.equal(settled.prepare('SELECT 1 FROM owner_native_surface_invalidations WHERE session=?').get(parentId), undefined)
  } finally { settled.close() }

  const history = app.call<{ messages: unknown[] }>('history:load')
  await app.call('history:save', [...history.messages, { role: 'user', text: question, receipt: null, sourceId: questionId }])
  const forked = await app.call<Promise<{ ok: boolean, problem?: string, info?: AgentInfo }>>('timeline:rewind',
    { words: question, keep: history.messages.length, text: question })
  assert.ok(forked.ok, JSON.stringify(forked))
  assert.notEqual(forked.info?.sessionId, parentId)
  const branchProbe = '验证已擦除会话的新分叉仍保留独立原文'
  const branchOffset = app.model.requests.length
  await app.ask(branchProbe)
  const branch = app.model.requests.slice(branchOffset) as Request[]
  assert.ok(branch.some(request => questionOf(request.messages) === branchProbe && JSON.stringify(request.messages).includes(survivor)))
  assert.ok(branch.every(request => ![erased, second].some(removed => JSON.stringify(request.messages).includes(removed))))
})

test('startup completes a history withdrawal interrupted by process death before model reads', { timeout: 45_000 }, async t => {
  const app = await setup(t, () => null)
  const sourceId = randomUUID()
  const initial = app.call<AgentInfo>('agent:info')
  const conversationId = initial.conversationId
  assert.ok(conversationId)
  await app.call('agent:prompt', oldFact, [], sourceId)
  const entry = await eventually(async () => (await app.files()).find(item => item.markdown.includes(oldValue)))
  assert.ok(entry)
  const memoryFile = join(app.directory, 'memory', 'memory.db')
  const hasFileCopy = (db: DatabaseSync) => Boolean(db.prepare(
    'SELECT 1 FROM memory_file_index_nodes WHERE workspace=? AND id=?',
  ).get(entry.identity.workspace, entry.identity.id))
  const detail = await app.call<Promise<IpcResults['memory:read-file']>>('memory:read-file', entry.identity)
  assert.ok(detail?.sources.some(source => source.sourceId === sourceId))
  await app.call('history:save', [{ role: 'user', text: oldFact, receipt: null, sourceId }])
  const profileProbe = '随手核对周报提交邮箱背景资料'
  const unsavedSource = await app.ask(profileProbe)
  assert.ok(app.model.requests.some(raw => {
    const request = raw as Request
    const content = request.messages.at(-1)?.content
    const context = Array.isArray(content) ? content.find(part => part.text?.startsWith('<about-user>'))?.text : null
    return questionOf(request.messages) === profileProbe && context?.includes('File memory evidence') && context.includes(oldValue)
  }))
  await app.ask('查一下 周报提交邮箱')
  const injected = app.events.filter(event => event.type === 'memory_context')
  assert.ok(injected.some(event => JSON.stringify(event).includes(oldValue) && JSON.stringify(event).includes('周报')), 'native owner contextUsed must preserve selected file evidence for the foreground trace')
  assert.ok(app.model.requests.some(raw => {
    const last = JSON.stringify((raw as Request).messages.at(-1))
    return last.includes('tool_result') && last.includes(oldValue)
  }))

  const continuation = await app.call<Promise<{ ok: boolean, info: AgentInfo }>>('history:resume-topic', conversationId)
  assert.ok(continuation.ok && continuation.info.sessionId === initial.sessionId)
  const independent = '重启后应当保留的独立备忘'
  const survivorId = randomUUID()
  await app.call('agent:prompt', independent, [], survivorId)
  await app.call('history:save', [{ role: 'user', text: independent, receipt: null, sourceId: survivorId }])
  const survivorStore = new DatabaseSync(memoryFile, { readOnly: true })
  try {
    // The independent original must be durably recorded before recovery.
    assert.ok(await eventually(() => survivorStore.prepare(
      "SELECT 1 FROM memory_sources WHERE id=? AND outcome='recorded'",
    ).get(survivorId)), 'the independent prompt retains its canonical source without a file write')
  } finally { survivorStore.close() }
  const generationBeforeRestart = contextGeneration(app.directory, initial.sessionId!)
  await app.stopBackend()
  const copies = new DatabaseSync(memoryFile)
  try {
    assert.ok(hasFileCopy(copies))
    assert.ok(copies.prepare('SELECT 1 FROM memory_file_index_chunks WHERE workspace=? AND file_id=?').get(entry.identity.workspace, entry.identity.id))
    // Seed an authenticated file passage vector even when the optional local model is absent in CI.
    const index = openMemoryFileIndex({ db: copies })
    const generation = index.beginVectors({ fingerprint: MEMORY_EMBEDDING_FINGERPRINT, dimensions: MEMORY_EMBEDDING_DIMENSIONS })
    const chunks = index.missingVectors(generation)
    assert.ok(chunks.some(chunk => chunk.ref.fileId === entry.identity.id))
    const vector = new Float32Array(MEMORY_EMBEDDING_DIMENSIONS)
    vector[0] = 1
    assert.equal(index.stageVectors(generation, chunks.map(chunk => ({ ref: chunk.ref, vectors: [vector] }))), chunks.length)
    assert.ok(index.finishVectors(generation, chunks.map(chunk => chunk.ref)))
  } finally { copies.close() }

  await runToCrash(withdrawalCrashFixture, 'before-withdrawal', app.directory, conversationId)

  const appDb = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  const memoryDb = new DatabaseSync(memoryFile, { readOnly: true })
  try {
    assert.equal(appDb.prepare('SELECT deleted_at IS NOT NULL AS removed FROM conversations WHERE id=?')
      .get(conversationId)?.removed, 1)
    assert.ok(appDb.prepare("SELECT generation FROM effects WHERE kind='memory.withdraw' AND key=?").get(conversationId))
    assert.equal(String(memoryDb.prepare('SELECT text FROM memory_sources WHERE id=?').get(sourceId)?.text).trim(), oldFact)
    assert.ok(hasFileCopy(memoryDb))
    assert.ok(memoryDb.prepare('SELECT 1 FROM memory_file_index_vectors WHERE ref LIKE ?').get('%' + entry.identity.id + '%'))
  } finally {
    memoryDb.close()
    appDb.close()
  }

  const offset = app.model.requests.length
  assert.ok(await app.startBackend())
  assert.equal((await app.files()).length, 0)
  assert.equal(app.call<AgentInfo>('agent:info').sessionId, initial.sessionId)
  assert.ok(contextGeneration(app.directory, initial.sessionId!) > generationBeforeRestart, 'native history must be durably replaced before the same session can continue')
  const probe = '用保留的记录继续核对'
  await app.ask(probe)
  const continuationId = continuation.info.conversationId
  assert.ok(continuationId && continuation.info.cwd)
  await app.call('history:continue-from-records', continuationId, continuation.info.cwd)
  const resumedProbe = '另起会话继续保留的笔记'
  await app.ask(resumedProbe)
  await app.ask('查一下 周报提交邮箱')
  const sent = app.model.requests.slice(offset).map(raw => JSON.stringify((raw as Request).messages))
  assert.ok(sent.some(body => body.includes(independent) && body.includes(probe)))
  assert.ok(sent.some(body => body.includes(independent) && body.includes(resumedProbe)))
  assert.ok(sent.some(body => body.includes('tool_result')))
  assert.ok(sent.every(body => !body.includes(oldValue)))

  const recoveredApp = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  const recoveredMemory = new DatabaseSync(memoryFile, { readOnly: true })
  try {
    assert.equal(recoveredApp.prepare("SELECT generation FROM effects WHERE kind='memory.withdraw' AND key=?")
      .get(conversationId), undefined)
    const withdrawn = recoveredMemory.prepare('SELECT text,withdrawn FROM memory_sources WHERE id=?').get(sourceId)
    assert.equal(withdrawn?.text, null)
    assert.equal(withdrawn.withdrawn, 1)
    assert.ok(recoveredMemory.prepare('SELECT id FROM memory_excluded_sources WHERE id=?').get(sourceId))
    assert.deepEqual({ ...recoveredMemory.prepare('SELECT text,withdrawn FROM memory_sources WHERE id=?').get(unsavedSource) },
      { text: null, withdrawn: 1 }, 'whole history withdrawal includes originals absent from the renderer snapshot')
    assert.ok(recoveredMemory.prepare('SELECT 1 FROM owner_occurrences WHERE source=? AND removed=1').get(unsavedSource))
    assert.equal(recoveredMemory.prepare('SELECT 1 FROM owner_occurrences WHERE source=? AND removed=0').get(unsavedSource), undefined)
    assert.ok(recoveredMemory.prepare('SELECT 1 FROM owner_occurrences WHERE source=? AND removed=0').get(survivorId))
    assert.equal(hasFileCopy(recoveredMemory), false)
    assert.equal(recoveredMemory.prepare('SELECT 1 FROM memory_file_index_chunks WHERE workspace=? AND file_id=?').get(entry.identity.workspace, entry.identity.id), undefined)
    assert.equal(recoveredMemory.prepare('SELECT 1 FROM memory_file_index_vectors WHERE ref LIKE ?').get('%' + entry.identity.id + '%'), undefined)
  } finally {
    recoveredMemory.close()
    recoveredApp.close()
  }
})

// This case spans two process starts, project switches, a fork and topic recovery.
// Its individual waits retain their existing bounds.
test('source-backed project files, exact recall and chat history remain in their Git workspace', { timeout: 90_000 }, async t => {
  const began = performance.now()
  const timings: { step: string, startedMs: number, elapsedMs?: number }[] = []
  let inspect: () => unknown = () => ({ state: 'setting-up' })
  const snapshot = () => {
    try { return inspect() } catch { return { state: 'fixture-closed' } }
  }
  const cancelled = () => process.stderr.write(`[project-memory-cancelled] ${JSON.stringify({
    elapsedMs: Math.round(performance.now() - began), activeStep: timings.findLast(timing => timing.elapsedMs === undefined)?.step,
    timings, state: snapshot(),
  })}\n`)
  t.signal.addEventListener('abort', cancelled, { once: true })
  t.after(() => t.signal.removeEventListener('abort', cancelled))
  const step = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
    const timing = { step: name, startedMs: Math.round(performance.now() - began), elapsedMs: undefined as number | undefined }
    timings.push(timing)
    const started = performance.now()
    try { return await work() }
    finally {
      timing.elapsedMs = Math.round(performance.now() - started)
      t.diagnostic(`[project-memory] ${JSON.stringify(timing)}`)
    }
  }
  const firstFact = '记住：当前项目的构建标记是 alpha-orchid-71'
  const secondFact = '记住：当前项目的构建标记是 beta-copper-23'
  const firstMarker = 'alpha-orchid-71'
  const secondMarker = 'beta-copper-23'
  const recall = '读取当前项目的构建标记'
  const history = '查上回说过的项目构建标记'
  const imageHistory = '找之前的图像转录结果'
  const rawHistoryText = '图像转录合成标记 alpha-amber-39'
  const backgroundBrief = '在后台核对当前项目资料'
  const scheduleTitle = '甲项目定时汇总'
  const listSchedules = '查看当前项目的定时任务'
  const updateSchedule = '修改指定的定时任务'
  const changedTitle = '不应写入的修改标题'
  let scheduleId: string | undefined
  const app = await step('setup', () => setup(t, request => {
    const last = request.messages.at(-1)
    if (JSON.stringify(last).includes('tool_result')) return null
    if (Array.isArray(last?.content) && last.content.some((part: { type?: string }) => part.type === 'image')) return { text: rawHistoryText }
    const question = questionOf(request.messages)
    if (question === recall) return { tool: { name: 'memory_recall', input: { query: '构建标记', scope: 'project' } } }
    if (question === history) return { tool: { name: 'search_conversations', input: { query: '构建标记' } } }
    if (question === imageHistory) return { tool: { name: 'search_conversations', input: { query: '图像转录合成标记' } } }
    if (question === scheduleTitle) return { tool: { name: 'schedule_create', input: {
      title: scheduleTitle, prompt: '汇总甲项目的当前状态', kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
    if (question === listSchedules) return { tool: { name: 'schedule_list', input: {} } }
    if (question === updateSchedule && scheduleId) return { tool: { name: 'schedule_update', input: {
      id: scheduleId, title: changedTitle, prompt: '不应写入的修改指令',
    } } }
    return null
  }, { image: true }))
  inspect = () => {
    const agent = app.call<AgentInfo>('agent:info')
    return {
      agent: { mode: agent.mode, cwd: agent.cwd, sessionId: agent.sessionId, conversationId: agent.conversationId, topicId: agent.topicId },
      requests: app.model.requests.length,
      recentQuestions: (app.model.requests.slice(-3) as Request[]).map(request => questionOf(request.messages)),
      tasks: app.tasks().map(task => ({ id: task.task.id, status: task.status, endedAt: task.endedAt })),
      events: app.events.filter(event => event.type === 'turn_started' || event.type === 'turn_end' || event.type === 'error').slice(-6),
    }
  }
  const repo = (name: string) => {
    const path = join(app.directory, name)
    mkdirSync(join(path, '.git', 'objects'), { recursive: true })
    writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return path
  }
  const projectA = repo('project-a')
  const projectB = repo('project-b')
  const enter = async (label: string, directory: string, text: string) => {
    const switched = await step(`${label}:switch`, () => app.call<Promise<{ ok: boolean, info: AgentInfo }>>('workdir:switch', directory, { confirmed: true }))
    assert.ok(switched.ok)
    const sourceId = randomUUID()
    await step(`${label}:remember`, () => app.call('agent:prompt', text, [], sourceId))
    await step(`${label}:save-history`, () => app.call('history:save', [{ role: 'user', text, receipt: null, sourceId }]))
    const summary = await step(`${label}:file-profile`, () => eventually(async () => {
      const { fileProfile } = await app.call<Promise<{ fileProfile: { project: { identity: MemoryFileDetail['identity'], text: string }[] | null } }>>('memory:get')
      return fileProfile.project?.find(item => item.text.includes(text.slice('记住：'.length)))
    }))
    assert.ok(summary)
    const detail = await step(`${label}:read-file`, () => app.call<Promise<IpcResults['memory:read-file']>>('memory:read-file', summary.identity))
    assert.ok(detail?.sources.some(source => source.link))
    return switched.info
  }
  const check = async (label: string, present: string, excluded: string) => {
    const count = app.model.requests.length
    await step(`${label}:profile-prompt`, () => app.ask('查看本项目构建标记的基本资料'))
    await step(`${label}:recall`, () => app.ask(recall))
    await step(`${label}:search-history`, () => app.ask(history))
    const messages = app.model.requests.slice(count).map(raw => (raw as Request).messages)
    assert.ok(messages.some(rows => {
      const last = JSON.stringify(rows.at(-1))
      return last.includes('<about-user>') && last.includes('File memory evidence') && last.includes(present)
    }))
    for (const name of ['memory_recall', 'search_conversations']) assert.ok(messages.some(rows =>
      modelToolResults({ messages: rows }, name).some(result => JSON.stringify(result).includes(present))),
    JSON.stringify({ name, results: messages.flatMap(rows => modelToolResults({ messages: rows }, name)) }))
    assert.ok(messages.every(rows => !JSON.stringify(rows).includes(excluded)), JSON.stringify({ excluded, leaked: messages.filter(rows => JSON.stringify(rows).includes(excluded)) }))
  }
  const sessionA = await enter('project-a', projectA, firstFact)
  await check('project-a', firstMarker, secondMarker)
  const taskOffset = app.model.requests.length
  await step('project-a:background-start', () => app.ask(`后台做：${backgroundBrief}`))
  assert.ok(await step('project-a:background-end', () => eventually(() => app.tasks().some(task => task.endedAt && task.task.title === backgroundBrief))))
  assert.ok(app.model.requests.slice(taskOffset).some(raw => {
    const request = raw as Request
    return questionOf(request.messages) === backgroundBrief && JSON.stringify(request.messages).includes(firstMarker)
  }), JSON.stringify({ tasks: app.tasks(), requests: app.model.requests.slice(taskOffset).map(raw => ({ question: questionOf((raw as Request).messages), messages: (raw as Request).messages.at(-1) })), errors: app.events.filter(event => event.type === 'error' || event.type === 'task_end') }))
  await step('project-a:create-schedule', () => app.schedule(scheduleTitle))
  const schedules = () => app.call<{ id: string, title: string }[]>('schedules:list')
  scheduleId = schedules().find(item => item.title === scheduleTitle)?.id
  assert.ok(scheduleId)
  const listOffset = app.model.requests.length
  await step('project-a:list-schedules', () => app.ask(listSchedules))
  const listResults = (app.model.requests.slice(listOffset) as Request[]).flatMap(request => modelToolResults(request, 'schedule_list'))
  assert.ok(listResults.some(result => JSON.stringify(result).includes(scheduleTitle)),
    JSON.stringify({ schedules: schedules(), results: listResults, lastMessages: (app.model.requests.slice(listOffset) as Request[]).map(request => request.messages.at(-1)) }))
  const subdirectory = join(projectA, 'nested')
  mkdirSync(subdirectory)
  const forked = await step('project-a:fork-nested-directory', () => app.call<Promise<{ ok: boolean, info: AgentInfo }>>('workdir:switch', subdirectory, { confirmed: true }))
  assert.ok(forked.ok)
  assert.equal(forked.info.topicId, sessionA.topicId)
  await check('project-a/nested', firstMarker, secondMarker)
  const beforeSwitch = app.model.requests.length
  const sessionB = await enter('project-b', projectB, secondFact)
  assert.notEqual(sessionA.sessionId, sessionB.sessionId)
  await check('project-b', secondMarker, firstMarker)
  const restrictedOffset = app.model.requests.length
  await step('project-b:restricted-list', () => app.ask(listSchedules))
  const modelLists = (app.model.requests.slice(restrictedOffset) as Request[]).flatMap(request => modelToolResults(request, 'schedule_list'))
  assert.ok(modelLists.length)
  assert.ok(modelLists.every(result => !JSON.stringify(result).includes(scheduleId)))
  const updateOffset = app.model.requests.length
  await step('project-b:rejected-update', () => app.ask(updateSchedule))
  assert.ok((app.model.requests.slice(updateOffset) as Request[]).some(request => modelToolResults(request, 'schedule_update').length))
  assert.equal(schedules().find(item => item.id === scheduleId)?.title, scheduleTitle)
  const afterSwitch = app.model.requests.slice(beforeSwitch) as Request[]
  assert.ok(afterSwitch.some(request => questionOf(request.messages) === secondFact && JSON.stringify(request.system).includes('个人工作助手')))
  assert.ok(afterSwitch.filter(request => JSON.stringify(request.system).includes('个人工作助手')
    || questionOf(request.messages).includes(secondMarker)).every(request => !JSON.stringify(request).includes(firstMarker)))

  // A picture-only conversation has delivery provenance without a memory source to recover its original project from.
  assert.ok(sessionA.conversationId)
  const resumedA = await step('project-a:resume-topic', () => app.call<Promise<{ ok: boolean, info: AgentInfo }>>('history:resume-topic', sessionA.conversationId))
  assert.ok(resumedA.ok)
  const pictureTopic = await step('project-a:picture-topic', () => app.newTopic())
  assert.ok(pictureTopic.sessionId)
  const sourceId = randomUUID()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = app.call<{ id: string }>('images:keep', Buffer.from(png, 'base64'))
  assert.ok(image)
  await step('project-a:picture-prompt', () => app.call('agent:prompt', '', [image], sourceId))
  assert.ok(app.model.requests.some(raw => JSON.stringify(raw).includes(png)))
  await step('project-a:save-picture-history', () => app.call('history:save', [
    { role: 'user', text: '', images: [image], receipt: null, sourceId },
    { role: 'assistant', text: rawHistoryText, receipt: null },
  ]))
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.ok(db.prepare('SELECT project FROM memory_session_projects WHERE session=?').get(pictureTopic.sessionId))
  } finally { db.close() }
  await step('stop-before-git-removal', () => app.stopBackend())
  rmSync(join(projectA, '.git'), { recursive: true })
  const outsideOffset = app.model.requests.length
  assert.ok(await step('cold-start-without-git', () => app.startBackend()))
  assert.notEqual(app.call<AgentInfo>('agent:info').sessionId, pictureTopic.sessionId)
  await step('without-git:continue', () => app.ask('继续查看现在可以用的记录'))
  const outside = join(app.directory, 'workspace')
  const loose = await step('outside:switch', () => app.call<Promise<{ ok: boolean }>>('workdir:switch', outside, { confirmed: true }))
  assert.ok(loose.ok)
  await step('outside:search-history', () => app.ask(history))
  await step('outside:search-picture-history', () => app.ask(imageHistory))
  const outsideRequests = (app.model.requests.slice(outsideOffset) as Request[])
    .filter(request => JSON.stringify(request.system).includes('个人工作助手'))
  assert.ok(outsideRequests.some(request => JSON.stringify(request.messages.at(-1)).includes('tool_result')))
  const leaked = outsideRequests.filter(request => {
    const text = JSON.stringify(request.messages)
    return text.includes(firstMarker) || text.includes(rawHistoryText)
  })
  assert.deepEqual(leaked.map(request => JSON.stringify(request.messages.at(-1))), [])
})

test('an explicit save completes in a foreground session that already received file evidence', { timeout: 30_000 }, async t => {
  const app = await setup(t, () => null)
  await app.recallOld()
  const profile = await app.call<Promise<{ fileProfile: MemoryFileProfile }>>('memory:get')
  assert.ok(profile.fileProfile.user.some(item => item.text.includes(oldValue)), 'a natural remembered original belongs to the file-backed user profile')
  await app.newTopic()
  const offset = app.model.requests.length
  await app.ask('核对下周报提交邮箱背景资料')
  assert.ok((app.model.requests.slice(offset) as Request[]).some(request =>
    JSON.stringify(request.messages).includes('File memory evidence')
      && JSON.stringify(request.messages).includes(oldValue)), JSON.stringify(app.model.requests.slice(offset)))
  const preference = '我以后使用紫罗兰色图标'
  const count = app.model.requests.length
  const seen = app.events.length
  await app.ask(`记住：${preference}`)
  assert.ok(await eventually(async () => (await app.files()).some(item => item.markdown.includes(preference))))
  assert.ok(app.events.slice(seen).some(event => event.type === 'memory_changed'), 'verified file save must notify the renderer')
  const foreground = () => app.model.requests.slice(count) as Request[]
  assert.ok(foreground().some(request => questionOf(request.messages) === `记住：${preference}`))
  assert.ok(foreground().some(request => modelToolResults(request, 'memory_remember').length))
})


test('a rejected original remains a dependency of resumed tasks and due schedules until it is withdrawn', { timeout: 45_000 }, async t => {
  const marker = 'synthetic-password-ab12'
  const original = 'password: ' + marker
  const forward = '把前面那条临时信息交给旧任务'
  const after = '让旧任务继续整理'
  const brief = '在任务内部汇总材料 ' + marker
  const followUp = '继续任务但只列结果'
  const title = '给临时信息设定时汇总'
  const schedulePrompt = '整理定时结果 ' + marker
  let taskId: string | undefined
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    if (question === title) return { tool: { name: 'schedule_create', input: {
      title, prompt: schedulePrompt, kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
    if (taskId && [forward, after].includes(question)) return { tool: { name: 'message_background_task', input: {
      taskId, text: question === forward ? brief : followUp,
    } } }
    return null
  })
  await app.ask('后台做：完全独立的后台任务')
  taskId = (await eventually(() => app.tasks().find(task => task.endedAt)))?.task.id
  assert.ok(taskId)
  const host = await app.newTopic()
  const sourceId = randomUUID()
  await app.call('agent:prompt', original, [], sourceId)
  await app.ask(forward)
  assert.ok(await eventually(() => app.tasks().find(task => task.endedAt && task.messages.some(row => row.text.includes(brief)))))
  await app.schedule(title)
  await rewriteRejectedSource(app, sourceId, original)

  const offset = app.model.requests.length
  const switched = await app.call<Promise<{ ok: boolean, info: AgentInfo }>>('timeline:switch-path', host.conversationId)
  assert.ok(switched.ok)
  assert.equal(switched.info.sessionId, host.sessionId)
  assert.ok(contextGeneration(app.directory, host.sessionId!) > 0, 'the withdrawn branch must recover its native surface before reusing the session')
  await app.ask('回到旧分支后继续')
  await app.newTopic()
  const db = new DatabaseSync(join(app.directory, 'app.db'))
  try {
    db.prepare("UPDATE schedules SET record=json_set(record, '$.scheduledAt', ?) WHERE status='active'").run(new Date(Date.now() - 1000).toISOString())
  } finally { db.close() }
  await app.restart()
  assert.ok(await eventually(() => app.feed().find(item => item.title === '定时任务需要重新确认')))
  await app.ask(after)
  const freshTask = '一条正常的独立后续任务'
  await app.ask(`后台做：${freshTask}`)
  assert.ok(await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === freshTask)))

  const actual = app.model.requests.slice(offset).map(raw => JSON.stringify((raw as Request).messages))
  assert.ok(!actual.some(body => body.includes(marker)))
  assert.ok(!app.model.requests.slice(offset).some(raw => questionOf((raw as Request).messages) === followUp))
})
