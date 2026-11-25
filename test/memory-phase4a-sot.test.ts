import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryStore, memoryHash } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { createMemoryRuntime } from '../src/memory/node/runtime.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { RESIDENT_PROFILE_PATH, userWorkspaceId } from '../src/memory/core/resident-profile.ts'
import { DREAM_PROFILE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
import { withRequestSource } from '../src/shared/request-routing/header.ts'
import { withTaskRequestSource } from '../src/shared/request-routing/task-header.ts'
import { withProvenanceHeader, wrapRawWithProvenance } from '../src/shared/request-routing/provenance.ts'
import { interjection } from '../src/backend/steer-channel.ts'
import { createTaskRuntime } from '../src/backend/task-runtime.ts'
import { createTaskStore } from '../src/backend/task-store.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { openAppDb } from '../src/backend/app-db.ts'
import { applyMemoryAdapter } from '../plugins/memory/lib/adapter.ts'
import {
  createSessionIngestion,
  extractHumanMessages,
  extractRecallQueries,
  readPersistedSessionRange,
  readVerifiedDurableSlice,
} from '../plugins/memory/lib/ingestion.ts'
import { eventually } from './fixtures/eventually.ts'
import { scratch } from './fixtures/scratch.js'
import { objectOf } from '../src/shared/unknown-value.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeFakePort() {
  const emitter = new EventEmitter()
  const sent: unknown[] = []
  return Object.assign(emitter, {
    connected: true,
    sent,
    send(message: unknown, cb?: (err?: Error | null) => void) {
      sent.push(message)
      cb?.(null)
      return true
    },
  })
}

function notFoundError(message = 'Session not found') {
  return Object.assign(new Error(message), { name: 'SessionPersistenceNotFoundError' })
}

function makeHeadedMainPrompt(words: string, sourceText: string, conversationId: string, sourceId: string) {
  const routed = withRequestSource(words, randomUUID(), sourceText)
  return withProvenanceHeader(routed.text, {
    origin: 'human',
    sourceKind: 'main-human',
    sessionKind: 'main',
    conversationId,
    sourceId,
    humanSpans: routed.spans,
  })
}

test('Phase 4A §5.7.1a: flush=false and writerless flush=true (SessionPersistenceNotFoundError) fail closed for ingestion and memory_remember', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4a-writerless-')
  const root = path.join(dir, 'memory')
  const config = path.join(dir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    ...['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions']
      .map(name => ({ id: name, name: '@deepseek-ai/' + name })),
    { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(dir, 'sessions'), compression: 'zstd' } },
  ]))
  const ctx = await boot('p4a-writerless', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx.fiber.dispose() })

  // 1. Direct unit check on readVerifiedDurableSlice: flush=false AND flush=true with no persistence handle.
  const writerlessId = SessionId(randomUUID())
  const writerless = ctx.sessions.create(writerlessId, { meta: { cwd: dir } })
  writerless.append('turn/start', { turn: 1 })
  writerless.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'never persisted' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  writerless.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const flushFalse = await readVerifiedDurableSlice(
    { flush: async () => false },
    ctx.sessionPersistence,
    writerless,
    0,
    writerless.seq,
  )
  assert.deepEqual(flushFalse, { ok: false, reason: 'flush-failed' })

  // In pinned DSH, sessions.flush(writerless) returns true even when no persistence file exists!
  assert.equal(await ctx.sessions.flush(writerless), true)
  const writerlessSlice = await readVerifiedDurableSlice(ctx.sessions, ctx.sessionPersistence, writerless, 0, writerless.seq)
  assert.deepEqual(writerlessSlice, { ok: false, reason: 'not-found' })

  // 2. End-to-end plugin test: writerless session calling memory_remember returns {"status":"unavailable"} and creates 0 sources/cursors.
  const toolReplies: string[] = []
  let rememberCalls = 0
  class RememberAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const hasToolResult = options.messages.some(m => m.role === 'tool')
      if (!hasToolResult && rememberCalls === 0) {
        rememberCalls++
        const callId = ToolCallId('tc-rem')
        const args = JSON.stringify({ text: '记住这条临时偏好' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: callId, name: 'memory_remember', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'memory_remember', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      for (const msg of options.messages) {
        if (msg.role === 'tool') {
          toolReplies.push(JSON.stringify(msg.content))
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new RememberAdapter())
  const port = makeFakePort()
  const owner = applyMemoryAdapter(ctx, { host: true, dataRoot: root, dailyNotes: true }, port as unknown as NodeJS.Process)
  t.after(async () => { await owner.close() })
  assert.ok(await eventually(() => owner.ready(), { timeoutMs: 15_000 }))

  // Force sessionPersistence.open('read') to throw SessionPersistenceNotFoundError for this session (simulating writerless flush=true).
  const writerlessSid = SessionId(randomUUID())
  const origOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  let blockWriterless = true
  t.mock.method(ctx.sessionPersistence, 'open', async (id: SessionId, mode: 'read' | 'write') => {
    if (blockWriterless && mode === 'read' && String(id) === String(writerlessSid)) {
      throw notFoundError('writerless session has no persisted log')
    }
    return origOpen(id, mode)
  })

  const handle = await ctx.agents.create({ sessionId: writerlessSid, meta: { cwd: dir }, agentOptions: { provider: 'mock', model: 'test-model' } })
  t.after(async () => { await handle.dispose() })
  const done = deferred<void>()
  const off = ctx.on('session/event', (session, event) => {
    if (session.id === writerlessSid && event.type === 'turn/end') { off(); done.resolve() }
  })
  const sid1 = randomUUID()
  const text = '记住这条临时偏好'
  handle.agent.send(createUserMessage({ content: [{ type: 'text', text: makeHeadedMainPrompt(text, text, 'conv-w', sid1) }], source: { kind: 'user' } }), 'next-turn', true)
  await done.promise
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.ok(toolReplies.some(reply => reply.includes('unavailable')), `memory_remember must fail closed with unavailable, saw: ${JSON.stringify(toolReplies)}`)
  const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
  defer(() => db.close())
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE id=?').get(sid1)?.n, 0, 'writerless session must create 0 canonical sources')
  assert.equal(db.prepare('SELECT next_seq FROM owner_intake_cursors WHERE session=?').get(String(writerlessSid)), undefined, 'writerless session must not advance next_seq')

  // Once persistence is readable again, replay/resync ingests the verified durable prefix without loss!
  blockWriterless = false
  // Trigger a second turn or close/reopen to verify replay from seq 0 recovers turn 1 cleanly.
  const done2 = deferred<void>()
  const off2 = ctx.on('session/event', (session, event) => {
    if (session.id === writerlessSid && event.type === 'turn/end') { off2(); done2.resolve() }
  })
  const sid2 = randomUUID()
  const text2 = '持久化恢复后的第二轮'
  handle.agent.send(createUserMessage({ content: [{ type: 'text', text: makeHeadedMainPrompt(text2, text2, 'conv-w', sid2) }], source: { kind: 'user' } }), 'next-turn', true)
  await done2.promise
  assert.ok(await eventually(() => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE id IN (?,?)').get(sid1, sid2) as { n: number }
    return count.n === 2
  }, { timeoutMs: 5_000 }), 'verified durable prefix must replay without loss once persistence is readable')
})

test('Phase 4A §5.7.1b: gap-free CAS cursor guard, same-day multi-batch note updates, and atomic rollback on ordinary prompt settlement', async t => {
  const { dir, defer } = scratch(t, 'p4a-cas-rollback-')
  const root = path.join(dir, 'memory')
  const owner = openMemoryOwner({
    root,
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    compute: async job => {
      assert.equal(job.stage, 'note')
      const input = JSON.parse(job.input) as { turns: Array<{ user: Array<{ text: string }> }> }
      return JSON.stringify({
        status: 'write',
        title: '同日多批笔记',
        markdown: input.turns.flatMap(turn => turn.user.map(u => u.text)).join('\n'),
      })
    },
  })
  defer(() => owner.close())
  await owner.recover()
  const db = new DatabaseSync(path.join(root, 'memory.db'))
  defer(() => db.close())

  const session = randomUUID()
  const dayTs = Date.parse('2026-11-20T10:00:00Z')
  // Initialize cursor at seq 100
  const init = owner.advanceIntakeCursor({ sessionId: session, expectedNextSeq: null, nextSeq: 100, inheritedSeq: 0, sessionKind: 'main', conversation: 'conv-cas' })
  assert.deepEqual(init, { status: 'ok', nextSeq: 100 })

  // Proposing from_seq = 150 while next_seq = 100 MUST reject without advancing cursor!
  const gapSrc = randomUUID()
  const gapRes = await owner.settleTurn({
    sessionId: session, cwd: null, sessionKind: 'main', conversation: 'conv-cas', inheritedSeq: 0,
    expectedNextSeq: 150, fromSeq: 150, toSeq: 160, turn: 2, reasonKind: 'completed',
    sources: [{ sourceId: gapSrc, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '跳跃轮次', at: dayTs, timezone: 'UTC' }],
    assistantText: '', at: dayTs, timezone: 'UTC',
  })
  assert.deepEqual(gapRes, { status: 'cas_mismatch', nextSeq: 100 })
  assert.equal(owner.intakeCursor(session).nextSeq, 100)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE id=?').get(gapSrc)?.n, 0)

  // Inject a transaction failure on memory_note_ranges during an ORDINARY prompt (never called memory_remember)!
  const rollbackSrc = randomUUID()
  db.exec(`CREATE TRIGGER fail_range_insert BEFORE INSERT ON memory_note_ranges
    BEGIN SELECT RAISE(ABORT, 'injected range failure'); END`)
  await assert.rejects(() => owner.settleTurn({
    sessionId: session, cwd: null, sessionKind: 'main', conversation: 'conv-cas', inheritedSeq: 0,
    expectedNextSeq: 100, fromSeq: 100, toSeq: 150, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: rollbackSrc, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '触发回滚的普通提示', at: dayTs, timezone: 'UTC' }],
    assistantText: '', at: dayTs, timezone: 'UTC',
  }), /injected range failure/)
  db.exec('DROP TRIGGER fail_range_insert')

  // Assert ALL THREE rolled back atomically: memory_sources, memory_note_ranges, and owner_intake_cursors.next_seq!
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE id=?').get(rollbackSrc)?.n, 0, 'memory_sources must roll back atomically')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_note_ranges WHERE session=?').get(session)?.n, 0, 'memory_note_ranges must roll back atomically')
  assert.equal(owner.intakeCursor(session).nextSeq, 100, 'owner_intake_cursors.next_seq must roll back atomically')

  // Fill the gap [100, 150) -> succeeds, then [150, 160) -> succeeds; same-day multi-batch updates the same note_key cleanly!
  const ok1 = await owner.settleTurn({
    sessionId: session, cwd: null, sessionKind: 'main', conversation: 'conv-cas', inheritedSeq: 0,
    expectedNextSeq: 100, fromSeq: 100, toSeq: 150, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: rollbackSrc, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '第一批同日消息', at: dayTs, timezone: 'UTC' }],
    assistantText: '', at: dayTs, timezone: 'UTC',
  })
  assert.deepEqual(ok1, { status: 'ok', nextSeq: 150 })
  await owner.runtime.wake()

  const ok2 = await owner.settleTurn({
    sessionId: session, cwd: null, sessionKind: 'main', conversation: 'conv-cas', inheritedSeq: 0,
    expectedNextSeq: 150, fromSeq: 150, toSeq: 160, turn: 2, reasonKind: 'completed',
    sources: [{ sourceId: gapSrc, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '第二批同日消息', at: dayTs + 60_000, timezone: 'UTC' }],
    assistantText: '', at: dayTs + 60_000, timezone: 'UTC',
  })
  assert.deepEqual(ok2, { status: 'ok', nextSeq: 160 })
  await owner.runtime.wake()

  const dailyRows = db.prepare('SELECT key, revision FROM memory_daily_notes').all() as Array<{ key: string, revision: number }>
  assert.equal(dailyRows.length, 1, 'multiple same-day batches must update the same note_key')
  assert.ok(dailyRows[0]!.revision >= 2)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_note_ranges WHERE status='written'").get()?.n, 1, 'consumed ranges retire at journal commit, retaining only the single latest row')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_note_sources').get()?.n, 2)
})

test('Phase 4A §5.7.1c: read-only cold catch-up retries list(), never takes write lease, leaves unclosed turns untouched, and gates aborted/interrupted turns', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4a-cold-and-gating-')
  const root = path.join(dir, 'memory')
  const config = path.join(dir, 'cordis.yml')
  const sessionsDir = path.join(dir, 'sessions')
  writeFileSync(config, JSON.stringify([
    ...['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions']
      .map(name => ({ id: name, name: '@deepseek-ai/' + name })),
    { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: sessionsDir, compression: 'zstd' } },
  ]))

  // Part 1: Real DSH user cancellation produces persisted turn/end with reason.kind === 'aborted' & reason.reason.kind === 'user',
  // AND physical DSH crash repair produces reason.kind === 'interrupted'.
  const ctx1 = await boot('p4a-gating-1', config, [], undefined, new URL('../package.json', import.meta.url).href)
  const cancelStarted = deferred<void>()
  class CancelAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '中间未完成的任务输出' }
      cancelStarted.resolve()
      await new Promise<void>((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
  }
  ctx1.llm.registerAdapter(['mock'], new CancelAdapter())

  // 1a. Create a background task session and cancel it via real agent.cancel({ kind: 'user' })
  const abortedTaskSid = SessionId(randomUUID())
  const abortHandle = await ctx1.agents.create({ sessionId: abortedTaskSid, meta: { cwd: dir }, agentOptions: { provider: 'mock', model: 'test-model' } })
  const abortDone = deferred<void>()
  const offAbort = ctx1.on('session/event', (session, event) => {
    if (session.id === abortedTaskSid && event.type === 'turn/end') { offAbort(); abortDone.resolve() }
  })
  const wrappedBrief = withTaskRequestSource('被用户取消的后台任务', randomUUID())
  const briefWire = withProvenanceHeader(wrappedBrief.text, {
    origin: 'router', sourceKind: 'task-brief', sessionKind: 'task', conversationId: 'conv-abort-task', humanSpans: wrappedBrief.spans,
  })
  abortHandle.agent.send(createUserMessage({ content: [{ type: 'text', text: briefWire }], source: { kind: 'user' } }), 'next-turn', true)
  await cancelStarted.promise
  void abortHandle.agent.cancel({ kind: 'user' })
  await abortDone.promise
  await ctx1.sessions.flush(abortHandle.agent.session)

  // Verify real DSH persisted reason.kind === 'aborted' with reason.reason.kind === 'user'!
  const abortReadHandle = await ctx1.sessionPersistence.open(abortedTaskSid, 'read')
  const { events: abortedEvents } = await abortReadHandle.read(0, 100)
  await abortReadHandle.close()
  const abortEnd = abortedEvents.find(ev => ev.type === 'turn/end')
  assert.ok(abortEnd && abortEnd.type === 'turn/end')
  assert.equal(abortEnd.data.reason.kind, 'aborted')
  assert.equal((abortEnd.data.reason as { kind: string, reason?: { kind?: string } }).reason?.kind, 'user')
  await abortHandle.dispose()

  // 1b. Create a persisted session with 1 closed completed turn + 1 UNCLOSED trailing turn (simulating crash before turn/end),
  // AND create a second cold session with a completed turn to test list() retry.
  const crashSid = SessionId(randomUUID())
  const completedColdSrcId = randomUUID()
  const crashClosedSrcId = randomUUID()
  const crashUnclosedSrcId = randomUUID()
  const nowBase = Date.now() + 5_000 // ensure >= memory.db created_at
  const wCrash = await ctx1.sessionPersistence.create({ version: 4, id: crashSid, createdAt: nowBase, cwd: dir, isSeeded: false })
  await wCrash.append([
    { seq: SessionSeq(0), time: nowBase, type: 'turn/start', data: { turn: 1 } },
    { seq: SessionSeq(1), time: nowBase + 1, type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: makeHeadedMainPrompt('崩溃前已完成的轮次', '崩溃前已完成的轮次', 'conv-crash', crashClosedSrcId) }], source: { kind: 'user' } }), surfaceOp: 'append' },
    { seq: SessionSeq(2), time: nowBase + 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    // Unclosed turn 2 (crashed mid-turn with partial assistant message!)
    { seq: SessionSeq(3), time: nowBase + 3, type: 'turn/start', data: { turn: 2 } },
    { seq: SessionSeq(4), time: nowBase + 4, type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: makeHeadedMainPrompt('崩溃时未结束的轮次', '崩溃时未结束的轮次', 'conv-crash', crashUnclosedSrcId) }], source: { kind: 'user' } }), surfaceOp: 'append' },
  ])
  await wCrash.close()

  const coldSid = SessionId(randomUUID())
  const wCold = await ctx1.sessionPersistence.create({ version: 4, id: coldSid, createdAt: nowBase, cwd: dir, isSeeded: false })
  await wCold.append([
    { seq: SessionSeq(0), time: nowBase, type: 'turn/start', data: { turn: 1 } },
    { seq: SessionSeq(1), time: nowBase + 1, type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: makeHeadedMainPrompt('冷扫描补齐的会话原话', '冷扫描补齐的会话原话', 'conv-cold', completedColdSrcId) }], source: { kind: 'user' } }), surfaceOp: 'append' },
    { seq: SessionSeq(2), time: nowBase + 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  await wCold.close()
  await ctx1.fiber.dispose()

  // Part 2: Boot fresh DSH with viva-memory; inject 1st-call failure in sessionPersistence.list() and spy on open() modes!
  const ctx2 = await boot('p4a-gating-2', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx2.fiber.dispose() })
  let listAttempts = 0
  const origList = ctx2.sessionPersistence.list.bind(ctx2.sessionPersistence)
  t.mock.method(ctx2.sessionPersistence, 'list', async () => {
    listAttempts++
    if (listAttempts === 1) throw new Error('transient list failure')
    return origList()
  })
  const openModes: Array<{ id: string, mode: string }> = []
  const origOpen2 = ctx2.sessionPersistence.open.bind(ctx2.sessionPersistence)
  t.mock.method(ctx2.sessionPersistence, 'open', async (id: SessionId, mode: 'read' | 'write', opts?: unknown) => {
    openModes.push({ id: String(id), mode })
    return origOpen2(id, mode, opts as never)
  })

  const port = makeFakePort()
  const owner = applyMemoryAdapter(ctx2, { host: true, dataRoot: root, dailyNotes: true }, port as unknown as NodeJS.Process)
  t.after(async () => { await owner.close() })
  assert.ok(await eventually(() => owner.ready(), { timeoutMs: 15_000 }))

  const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
  defer(() => db.close())
  // Wait for cold catch-up to recover from the first list() failure and process coldSid + closed turn of crashSid + abortedTaskSid!
  assert.ok(await eventually(() => {
    const coldOk = Boolean(db.prepare('SELECT 1 FROM memory_sources WHERE id=?').get(completedColdSrcId))
    const crashClosedOk = Boolean(db.prepare('SELECT 1 FROM memory_sources WHERE id=?').get(crashClosedSrcId))
    const abortCursor = db.prepare('SELECT next_seq FROM owner_intake_cursors WHERE session=?').get(String(abortedTaskSid)) as { next_seq: number } | undefined
    return coldOk && crashClosedOk && Boolean(abortCursor && abortCursor.next_seq >= abortedEvents.length)
  }, { timeoutMs: 10_000 }), 'cold catch-up must retry list() and ingest closed turns')

  assert.ok(listAttempts >= 2, 'sessionPersistence.list() must have retried after first-call failure')
  assert.equal(openModes.filter(m => m.mode === 'write').length, 0, 'read-only cold catch-up must NEVER open any session with write mode')
  // Aborted task turn must NOT create any note range or task-assistant conclusion!
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_note_ranges WHERE session=?').get(String(abortedTaskSid))?.n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE session=? AND source_kind='task-assistant'").get(String(abortedTaskSid))?.n, 0)
  // Unclosed trailing turn of crashSid must remain untouched (next_seq === 3, NOT 5)!
  assert.equal(db.prepare('SELECT next_seq FROM owner_intake_cursors WHERE session=?').get(String(crashSid))?.next_seq, 3)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE id=?').get(crashUnclosedSrcId)?.n, 0)

  // Now reopen crashSid via real DSH agent resume so DSH repair.ts appends a physical `reason.kind === 'interrupted'` turn/end!
  const restoredHandle = await ctx2.agents.resume({ resumeSessionId: crashSid })
  t.after(async () => { await restoredHandle.dispose() })
  await ctx2.sessions.flush(restoredHandle.agent.session)
  const checkRepaired = await origOpen2(crashSid, 'read')
  const { events: repairedEvents } = await checkRepaired.read(0, 100)
  await checkRepaired.close()
  const interruptedEnd = repairedEvents.find(ev => ev.type === 'turn/end' && ev.data.turn === 2)
  assert.ok(interruptedEnd && interruptedEnd.type === 'turn/end')
  assert.equal(interruptedEnd.data.reason.kind, 'interrupted', 'real DSH restore must repair unclosed turn with reason.kind === interrupted')

  // Trigger synchronization after repair -> cursor advances past the interrupted turn WITHOUT creating a note range or publishing the unclosed turn!
  assert.ok(await eventually(() => {
    const row = db.prepare('SELECT next_seq FROM owner_intake_cursors WHERE session=?').get(String(crashSid)) as { next_seq: number } | undefined
    return Boolean(row && row.next_seq >= Number(interruptedEnd.seq) + 1)
  }, { timeoutMs: 8_000 }), 'cursor must advance past repaired interrupted turn/end')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE id=?').get(crashUnclosedSrcId)?.n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_note_ranges WHERE session=? AND turn=2').get(String(crashSid))?.n, 0)
})

test('Phase 4A §5.7.1d-e: fork inheritedEventCount cut, missing vs transient readSessionRange errors, and post-session-deletion independence', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4a-range-and-cleanup-')
  const root = path.join(dir, 'memory')
  const deletedSid = randomUUID()
  const flakySid = randomUUID()
  const healthySid = randomUUID()
  const deletedReadSid = randomUUID()

  // 1. Direct unit test of readPersistedSessionRange: open() NotFound, read() NotFound, transient EIO, short read!
  assert.deepEqual(
    await readPersistedSessionRange({ open: async () => { throw notFoundError('gone on open') } }, deletedSid, 0, 3),
    { status: 'deleted' },
  )
  assert.deepEqual(
    await readPersistedSessionRange({
      open: async () => ({
        inheritedEventCount: SessionLogOffset(0),
        read: async () => { throw notFoundError('gone on read') },
        close: async () => {},
      }) as never,
    }, deletedReadSid, 0, 3),
    { status: 'deleted' },
  )
  let transientOpens = 0
  assert.deepEqual(
    await readPersistedSessionRange({
      open: async () => {
        transientOpens++
        throw Object.assign(new Error('EIO transient'), { code: 'EIO' })
      },
    }, flakySid, 0, 3),
    { status: 'unavailable' },
  )
  assert.equal(transientOpens, 2, 'transient I/O error must recheck once with a fresh handle before returning unavailable')

  let shortOpens = 0
  assert.deepEqual(
    await readPersistedSessionRange({
      open: async () => {
        shortOpens++
        return {
          inheritedEventCount: SessionLogOffset(0),
          read: async () => ({ events: [] }),
          close: async () => {},
        } as never
      },
    }, flakySid, 0, 3),
    { status: 'unavailable' },
  )
  assert.equal(shortOpens, 2, 'short read must recheck once with a fresh handle before returning unavailable')

  // 2. End-to-end WRITE_NOTE handling: deleted session clears range without blocking healthy session; transient error retains range for retry!
  let transientFail = true
  let sessionDeletedAfterNote = false
  const owner = openMemoryOwner({
    root,
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async ({ sessionId }) => {
      if (sessionId === deletedSid) return { status: 'deleted' }
      if (sessionId === flakySid) return transientFail ? { status: 'unavailable' } : { status: 'ok', assistant: '恢复后的助手回答' }
      if (sessionId === healthySid) return sessionDeletedAfterNote ? { status: 'deleted' } : { status: 'ok', assistant: '健康会话回答' }
      return { status: 'ok', assistant: '' }
    },
    compute: job => {
      if (job.stage === 'note') {
        const input = JSON.parse(job.input) as { turns: Array<{ user: Array<{ text: string }> }> }
        return Promise.resolve(JSON.stringify({
          status: 'write',
          title: '健康日记',
          markdown: input.turns.flatMap(turn => turn.user.map(u => u.text)).join('\n'),
        }))
      }
      if (job.stage === 'dream') {
        return Promise.resolve(JSON.stringify({ operations: [] }))
      }
      return null
    },
  })
  defer(() => owner.close())
  await owner.recover()
  const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
  defer(() => db.close())
  const nowMs = Date.parse('2026-11-21T12:00:00Z')

  await owner.settleTurn({
    sessionId: deletedSid, cwd: null, sessionKind: 'main', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '已删除会话的待写范围', at: nowMs, timezone: 'UTC' }],
    assistantText: '已删除的回答', at: nowMs, timezone: 'UTC',
  })
  await owner.settleTurn({
    sessionId: flakySid, cwd: null, sessionKind: 'main', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '临时错误会话的待写范围', at: nowMs, timezone: 'UTC' }],
    assistantText: '恢复后的助手回答', at: nowMs, timezone: 'UTC',
  })
  await owner.settleTurn({
    sessionId: healthySid, cwd: null, sessionKind: 'main', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '健康会话的待写内容', at: nowMs, timezone: 'UTC' }],
    assistantText: '健康会话回答', at: nowMs, timezone: 'UTC',
  })
  await owner.runtime.wake()

  assert.equal(db.prepare('SELECT status FROM memory_note_ranges WHERE session=?').get(deletedSid)?.status, 'skipped', 'confirmed deleted session range must be skipped and cleared')
  assert.equal(db.prepare('SELECT status FROM memory_note_ranges WHERE session=?').get(flakySid)?.status, 'pending', 'transient error must retain pending range for retry')
  assert.equal(db.prepare('SELECT status FROM memory_note_ranges WHERE session=?').get(healthySid)?.status, 'written', 'healthy session must not be blocked by deleted or flaky sessions')

  // Simulate deleting DSH session log for healthySid AFTER its Daily Note was written -> note remains readable, toggleable, Dream-verifiable, forgettable!
  sessionDeletedAfterNote = true
  const listed = await owner.handleHost('listFiles', { args: [{ kind: 'daily' }] }) as { items: Array<{ identity: { kind: 'daily', workspace: string, id: string } }> }
  assert.equal(listed.items.length, 1)
  const dailyId = listed.items[0]!.identity
  const detail = await owner.handleHost('readFile', { args: [dailyId] }) as { markdown: string, version: unknown } | null
  assert.ok(detail && detail.markdown.includes('健康会话的待写内容'))
  const disabled = await owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: dailyId, version: detail.version, enabled: false }] })
  assert.ok(disabled)
  const detail2 = await owner.handleHost('readFile', { args: [dailyId] }) as { version: unknown } | null
  const enabled = await owner.handleHost('setFileEnabled', { args: [{ operationId: randomUUID(), identity: dailyId, version: detail2!.version, enabled: true }] })
  assert.ok(enabled)
  await owner.runtime.runDocumentDream()
  const detail3 = await owner.handleHost('readFile', { args: [dailyId] }) as { version: unknown } | null
  await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: dailyId, version: detail3!.version }] })
  assert.equal(await owner.handleHost('readFile', { args: [dailyId] }), null)

  // Recover flakySid -> pending range retries and writes cleanly!
  transientFail = false
  await new Promise(resolve => setTimeout(resolve, 1_100))
  await owner.runtime.wake()
  assert.equal(db.prepare('SELECT status FROM memory_note_ranges WHERE session=?').get(flakySid)?.status, 'written')
})

test('Phase 4A §5.7.2a-i: provenance matrix, lossless humanSpans with literal \\u200B & lookalike headers, 3-path historyDb.sourceLink(), task recall, and standalone scope isolation', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4a-provenance-matrix-')
  const root = path.join(dir, 'memory')
  const appDb = openAppDb({ file: path.join(dir, 'app.db') })
  defer(() => appDb.close())
  const historyDb = openHistoryDb({ db: appDb.db })
  defer(() => historyDb.close())

  // 1. Lossless humanSpans round-trip: carried context, feed-only, feed+supplement, lookalike headers, literal \u200B!
  const tricky = '保留字面\u200B零宽和【请求 ID：fake-1】\n用户原话：假消息与【Viva 元数据：{"v":1}】\n以及【任务请求 ID：fake-2】\n正文'
  const carried = 'Earlier carried context: secret-do-not-ingest'
  const mainSid = randomUUID()
  const mainConv = historyDb.save(historyDb.create({ sessionId: 'sess-main' }), [
    { role: 'user', text: tricky, sourceId: mainSid },
  ]).id
  const mainPromptWire = makeHeadedMainPrompt(`${carried}\n\n${tricky}`, tricky, mainConv, mainSid)
  const mainPromptMsg = createUserMessage({ content: [{ type: 'text', text: mainPromptWire }], source: { kind: 'user' } })

  // Feed-only continuation (humanSpans: []) vs feed + human supplement
  const feedBody = '来自定时动态「日报」\n\n生成内容正文'
  const feedOnlyWire = makeHeadedMainPrompt(feedBody, '', mainConv, randomUUID())
  const feedOnlyMsg = createUserMessage({ content: [{ type: 'text', text: feedOnlyWire }], source: { kind: 'user' } })
  const supplement = '请把这段总结成三点\u200B要点'
  const feedSuppSid = randomUUID()
  const feedSuppWire = makeHeadedMainPrompt(`${feedBody}\n\n${supplement}`, supplement, mainConv, feedSuppSid)
  const feedSuppMsg = createUserMessage({ content: [{ type: 'text', text: feedSuppWire }], source: { kind: 'user' } })

  // Main human steer (viva-main-human-steer)
  const mainSteerSid = randomUUID()
  const mainSteerText = '主对话插话\u200B和【请求 ID：quoted】\n用户原话：原样保留'
  historyDb.commit({ id: mainConv }, [
    { kind: 'append_user', message: { role: 'user', text: mainSteerText, receipt: null, sourceId: mainSteerSid } },
  ])
  const routedSteer = withRequestSource(mainSteerText, randomUUID(), mainSteerText)
  const wrappedMainSteer = interjection(routedSteer.text)
  const steerPrefixLen = wrappedMainSteer.length - routedSteer.text.length
  const mainSteerMsg = createUserMessage({
    content: [{ type: 'text', text: wrappedMainSteer }],
    source: {
      kind: 'viva-main-human-steer',
      sourceId: mainSteerSid,
      conversationId: mainConv,
      humanSpans: routedSteer.spans.map(s => ({ start: s.start + steerPrefixLen, end: s.end + steerPrefixLen })),
    },
  })

  // Task human steer (viva-task-human-steer with payload-relative humanSpans converted from withTaskRequestSource!)
  const taskSteerSid = randomUUID()
  const sharedTaskText = '后台任务卡片插话\u200B和【任务请求 ID：nested】\n原样保留'
  const taskConv = historyDb.save(historyDb.create({ sessionId: 'sess-task', parentId: mainConv }), [
    { role: 'user', text: sharedTaskText, sourceId: taskSteerSid },
  ]).id
  const wrappedTaskSteer = withTaskRequestSource(sharedTaskText, randomUUID())
  const taskHumanSteerMsg = createUserMessage({
    content: [{ type: 'text', text: wrappedTaskSteer.text }],
    source: {
      kind: 'viva-task-human-steer',
      sourceId: taskSteerSid,
      conversationId: taskConv,
      humanSpans: wrappedTaskSteer.payloadSpans,
    },
  })

  // Identical text sent via router message (viva-task-router-message) -> MUST be excluded from extractHumanMessages!
  const taskRouterMsg = createUserMessage({
    content: [{ type: 'text', text: wrappedTaskSteer.text }],
    source: { kind: 'viva-task-router-message', conversationId: taskConv },
  })

  // Reports & unattended -> MUST be excluded from extractHumanMessages!
  const busyReportMsg = createUserMessage({
    content: [{ type: 'text', text: '后台任务完成汇报' }],
    source: { kind: 'viva-report', reportId: 'r1', token: 't1', form: 'notice', summary: 'report' } as unknown as UserMessage['source'],
  })
  const idleBatchReportMsg = createUserMessage({
    content: [{ type: 'text', text: wrapRawWithProvenance('【后台任务结束】汇总内容', { origin: 'router', sourceKind: 'viva-report-batch', sessionKind: 'main', conversationId: mainConv }, '').text }],
    source: { kind: 'user' },
  })
  const unattendedMsg = createUserMessage({
    content: [{ type: 'text', text: wrapRawWithProvenance('定时无人值守任务', { origin: 'unattended', sourceKind: 'unattended', sessionKind: 'unattended' }, '').text }],
    source: { kind: 'user' },
  })

  // Verify unified extractHumanMessages exact L3 queries (zero wrapper headers, verbatim \u200B, strict exclusions)!
  const extracted = extractHumanMessages(
    [mainPromptMsg, feedOnlyMsg, feedSuppMsg, mainSteerMsg, taskHumanSteerMsg, taskRouterMsg, busyReportMsg, idleBatchReportMsg, unattendedMsg],
    { host: true },
  )
  assert.deepEqual(
    extracted.map(item => ({ sourceId: item.sourceId, sourceKind: item.sourceKind, text: item.text })),
    [
      { sourceId: mainSid, sourceKind: 'main-human', text: tricky },
      { sourceId: feedSuppSid, sourceKind: 'main-human', text: supplement },
      { sourceId: mainSteerSid, sourceKind: 'main-human', text: mainSteerText },
      { sourceId: taskSteerSid, sourceKind: 'task-human-steer', text: sharedTaskText },
    ],
  )
  assert.equal(extracted.some(item => item.text.includes(carried) || item.text.includes(feedBody)), false)

  // 2. Cold ingestion replay through createSessionIngestion + real openMemoryOwner:
  // Verify all 3 human paths resolve historyDb.sourceLink(), router task-brief + task-assistant are recallable in main chat & excluded from L2,
  // reports & unattended produce 0 sources, and mid-turn memory_remember rejects task-brief & feed-only!
  const owner = openMemoryOwner({
    root,
    hostNamespace: 'viva',
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    compute: job => {
      if (job.stage === 'note') {
        const input = JSON.parse(job.input) as { existing?: { markdown: string }, turns: Array<{ user: Array<{ text: string }> }> }
        return Promise.resolve(JSON.stringify({
          status: 'write',
          title: '任务与对话记录',
          markdown: [input.existing?.markdown, ...input.turns.flatMap(t => t.user.map(u => u.text))].filter(Boolean).join('\n'),
        }))
      }
      return null
    },
  })
  defer(() => owner.close())
  await owner.recover()

  const persisted = new Map<string, Session>()
  const makeSession = (id: string) => {
    const s = Session.create(SessionId(id), [], { version: 4, id: SessionId(id), createdAt: Date.now(), cwd: dir, isSeeded: false })
    persisted.set(id, s)
    return s
  }
  const persistence = {
    async open(id: SessionId) {
      const s = persisted.get(String(id))
      if (!s) throw notFoundError()
      return {
        inheritedEventCount: s.inheritedEventCount,
        async read(offset: number, limit: number) { return { events: s.snapshotEvents().slice(offset, offset + limit) } },
        async close() {},
      }
    },
    async list() {
      return [...persisted.values()].map(s => ({ header: s.header, revision: 1, inheritedEventCount: s.inheritedEventCount }))
    },
  } as unknown as Parameters<typeof createSessionIngestion>[2]
  const ownerAdapter: Parameters<typeof createSessionIngestion>[0] = {
    epoch: owner.epoch,
    inEpoch: (_e, work) => work(),
    intakeCursor: async s => owner.intakeCursor(s),
    advanceIntakeCursor: async i => owner.advanceIntakeCursor(i),
    beginTurn: async i => owner.beginTurn(i),
    stageOpenTurnSources: async i => owner.stageOpenTurnSources(i),
    settleTurn: async i => owner.settleTurn(i),
  }
  const ingestion = createSessionIngestion(ownerAdapter, { flush: async () => true }, persistence, { host: true })

  // Main session: Turn 1 (carried + tricky + mainSteer), Turn 2 (feed-only), Turn 3 (idle batch report), Turn 4 (busy report)
  const sMain = makeSession('sess-main')
  sMain.append('turn/start', { turn: 1 })
  sMain.append('user/message', mainPromptMsg, { surfaceOp: 'append' })
  sMain.append('user/message', mainSteerMsg, { surfaceOp: 'append' })
  sMain.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sMain.append('turn/start', { turn: 2 })
  sMain.append('user/message', feedOnlyMsg, { surfaceOp: 'append' })
  sMain.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  sMain.append('turn/start', { turn: 3 })
  sMain.append('user/message', idleBatchReportMsg, { surfaceOp: 'append' })
  sMain.append('assistant/message', { message: { id: 'a-rep', role: 'assistant', content: [{ type: 'text', text: '汇报总结' }] }, interrupted: false } as never, { surfaceOp: 'append' })
  sMain.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  sMain.append('turn/start', { turn: 4 })
  sMain.append('user/message', busyReportMsg, { surfaceOp: 'append' })
  sMain.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
  await ingestion.synchronize(sMain)

  // Task session: Turn 1 (router task-brief + task-assistant conclusion), Turn 2 (task-human-steer + task-router-message)
  const sTask = makeSession('sess-task')
  const taskBriefText = '核对华东机房季度迁移计划'
  const taskConclusionText = '华东机房迁移结论：蓝绿切换窗口定在周六凌晨。'
  const wrappedBrief = withTaskRequestSource(taskBriefText, randomUUID())
  const briefMsg = createUserMessage({
    content: [{ type: 'text', text: withProvenanceHeader(wrappedBrief.text, { origin: 'router', sourceKind: 'task-brief', sessionKind: 'task', conversationId: taskConv, humanSpans: wrappedBrief.spans }) }],
    source: { kind: 'user' },
  })
  sTask.append('turn/start', { turn: 1 })
  sTask.append('user/message', briefMsg, { surfaceOp: 'append' })
  // Test mid-turn memory_remember on task-brief -> MUST be rejected (no-explicit-user-source)!
  await ingestion.stageOpenTurn(sTask)
  assert.equal(await owner.rememberSidecarFile('sess-task', taskBriefText, new AbortController().signal), null, 'memory_remember must reject router task-brief')

  sTask.append('assistant/message', { message: { id: 'a-task', role: 'assistant', content: [{ type: 'text', text: taskConclusionText }] }, interrupted: false } as never, { surfaceOp: 'append' })
  sTask.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  sTask.append('turn/start', { turn: 2 })
  sTask.append('user/message', taskHumanSteerMsg, { surfaceOp: 'append' })
  sTask.append('user/message', taskRouterMsg, { surfaceOp: 'append' })
  // Test mid-turn memory_remember on task-human-steer -> MUST succeed!
  await ingestion.stageOpenTurn(sTask)
  const remembered = await owner.rememberSidecarFile('sess-task', sharedTaskText, new AbortController().signal)
  assert.ok(remembered, 'mid-turn memory_remember must accept verified task-human-steer without sourceAlias')
  sTask.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await ingestion.synchronize(sTask)

  // Unattended session -> 0 sources!
  const sUnatt = makeSession('sess-unatt')
  sUnatt.append('turn/start', { turn: 1 })
  sUnatt.append('user/message', unattendedMsg, { surfaceOp: 'append' })
  sUnatt.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ingestion.synchronize(sUnatt)

  await owner.runtime.wake()

  const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
  defer(() => db.close())
  // Verify all 3 human paths resolve historyDb.sourceLink() & exact verbatim text!
  for (const [id, expectedText, expectedKind] of [
    [mainSid, tricky, 'main-human'],
    [mainSteerSid, mainSteerText, 'main-human'],
    [taskSteerSid, sharedTaskText, 'task-human-steer'],
  ] as const) {
    const row = db.prepare('SELECT id, text, author, source_kind, profile_eligible FROM memory_sources WHERE id=?').get(id) as
      { id: string, text: string, author: string, source_kind: string, profile_eligible: number } | undefined
    assert.ok(row, `expected canonical source for ${expectedKind}`)
    assert.equal(row.text, expectedText)
    assert.equal(row.author, 'user')
    assert.equal(row.source_kind, expectedKind)
    assert.equal(row.profile_eligible, 1)
    assert.ok(historyDb.sourceLink(row.id), `historyDb.sourceLink must resolve ${expectedKind}`)
  }

  // Verify router task-brief + task-assistant conclusion stored under global userWorkspace with profile_eligible = 0 and recallable from main chat!
  const briefRow = db.prepare("SELECT author, source_kind, profile_eligible, context FROM memory_sources WHERE text=? AND author='agent'").get(taskBriefText) as
    { author: string, source_kind: string, profile_eligible: number, context: string } | undefined
  assert.ok(briefRow)
  assert.equal(briefRow.source_kind, 'task-brief')
  assert.equal(briefRow.profile_eligible, 0)
  assert.deepEqual(JSON.parse(briefRow.context), { kind: 'user' })

  const conclusionRow = db.prepare("SELECT author, source_kind, profile_eligible, context FROM memory_sources WHERE text=? AND author='assistant'").get(taskConclusionText) as
    { author: string, source_kind: string, profile_eligible: number, context: string } | undefined
  assert.ok(conclusionRow)
  assert.equal(conclusionRow.source_kind, 'task-assistant')
  assert.equal(conclusionRow.profile_eligible, 0)
  assert.deepEqual(JSON.parse(conclusionRow.context), { kind: 'user' })

  // Router message with identical text to task-human-steer must be stored as author='agent', profile_eligible=0!
  const routerSteerRow = db.prepare("SELECT author, source_kind, profile_eligible FROM memory_sources WHERE text=? AND author='agent'").get(sharedTaskText) as
    { author: string, source_kind: string, profile_eligible: number } | undefined
  assert.ok(routerSteerRow)
  assert.equal(routerSteerRow.source_kind, 'task-brief')
  assert.equal(routerSteerRow.profile_eligible, 0)

  // Global recall from main chat finds background task conclusion!
  assert.ok(await eventually(async () => {
    const recallPacket = JSON.parse(await owner.runtime.handleModelRequest(
      { op: 'recall', session: 'sess-main', query: '蓝绿切换窗口' },
      owner.sessionContext('sess-main'),
      () => true,
    )) as { notes?: Array<{ markdown: string }> }
    return Boolean(recallPacket.notes?.some(n => n.markdown.includes('蓝绿切换窗口')))
  }, { timeoutMs: 5_000 }), 'background task conclusion must be globally recallable in main chat')

  // Unattended & reports produced 0 sources!
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE session=?').get('sess-unatt')?.n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE text LIKE ?').get('%汇总内容%')?.n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_sources WHERE text LIKE ?').get('%生成内容正文%')?.n, 0)

  // 3. Standalone DSH non-project (profileEligible: true) vs project-scoped (profileEligible: false)!
  const standaloneRoot = path.join(dir, 'standalone-memory')
  const standaloneOwner = openMemoryOwner({ root: standaloneRoot, dailyNotes: false, compute: () => null, route: () => null })
  defer(() => standaloneOwner.close())
  await standaloneOwner.recover()
  const projectDir = path.join(dir, 'git-repo')
  mkdirSync(path.join(projectDir, '.git', 'objects'), { recursive: true })
  writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const nonProjId = randomUUID(), projId = randomUUID()
  await standaloneOwner.settleTurn({
    sessionId: 'standalone-user', cwd: dir, sessionKind: 'main', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: nonProjId, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '独立非项目偏好', at: Date.now(), timezone: 'UTC' }],
    assistantText: '', at: Date.now(), timezone: 'UTC',
  })
  await standaloneOwner.settleTurn({
    sessionId: 'standalone-proj', cwd: projectDir, sessionKind: 'main', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: projId, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '独立项目内部规范', at: Date.now(), timezone: 'UTC' }],
    assistantText: '', at: Date.now(), timezone: 'UTC',
  })
  const sDb = new DatabaseSync(path.join(standaloneRoot, 'memory.db'), { readOnly: true })
  defer(() => sDb.close())
  const nonProjRow = sDb.prepare('SELECT source_kind, profile_eligible, project FROM memory_sources WHERE id=?').get(nonProjId) as { source_kind: string, profile_eligible: number, project: string | null }
  const projRow = sDb.prepare('SELECT source_kind, profile_eligible, project FROM memory_sources WHERE id=?').get(projId) as { source_kind: string, profile_eligible: number, project: string | null }
  assert.equal(nonProjRow.source_kind, 'main-human')
  assert.equal(nonProjRow.profile_eligible, 1)
  assert.equal(nonProjRow.project, null)
  assert.equal(projRow.source_kind, 'project-user')
  assert.equal(projRow.profile_eligible, 0)
  assert.ok(projRow.project)
})

test('Phase 4A §5.7.2k: valid & revoked direct question metadata on memory_sources survives range consumption and session-log deletion', async t => {
  const { dir, defer } = scratch(t, 'p4a-direct-question-meta-')
  const nowMs = Date.parse('2026-11-22T12:00:00Z')
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => nowMs)

  let noteInputs: Array<{ turns: Array<{ user: Array<{ sourceId: string, text: string, question: string | null }> }> }> = []
  let dreamProfileInputs: Array<{ canonicalSources: Array<{ sourceId: string, text: string, question: string | null, questionUnavailable: boolean }> }> = []

  const runtime = createMemoryRuntime({
    store,
    now: () => nowMs,
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    // Simulate DSH session logs ALREADY DELETED when WRITE_NOTE runs (or after):
    readSessionRange: async () => ({ status: 'ok', assistant: '' }),
    canCommit: () => true,
    changed: () => {},
    compute(job) {
      if (job.stage === 'note') {
        const input = JSON.parse(job.input) as typeof noteInputs[number]
        noteInputs.push(input)
        return Promise.resolve(JSON.stringify({
          status: 'write',
          title: '问答记录',
          markdown: input.turns.flatMap(t => t.user.map(u => u.text)).join('\n'),
        }))
      }
      if (job.stage === 'dream') {
        if (job.system === DREAM_PROFILE_SYSTEM) {
          const input = JSON.parse(job.input) as typeof dreamProfileInputs[number]
          dreamProfileInputs.push(input)
          return Promise.resolve(JSON.stringify({ action: 'NOOP' }))
        }
        return Promise.resolve(JSON.stringify({ operations: [] }))
      }
      return null
    },
  })
  defer(() => runtime.close())

  // Case A: Valid question -> WRITE_NOTE consumes range -> purge memory_note_ranges -> Dream profile planner STILL receives valid question via memory_sources metadata!
  const sessionA = 'sess-q-valid'
  const prereqA = randomUUID()
  const ansA = randomUUID()
  runtime.accept('帮我记一下饮品习惯', { conversation: sessionA, session: sessionA, scope: { kind: 'user' }, context: { kind: 'user' }, profileEligible: true }, prereqA, undefined, { at: nowMs, timezone: 'UTC' })
  store.tx(() => {
    runtime.recordNoteRangeInTx?.({ session: sessionA, fromSeq: 0, toSeq: 3, turn: 1, ids: [prereqA], assistant: '' })
  })
  await runtime.wake()

  runtime.accept('只喝无糖乌龙茶', { conversation: sessionA, session: sessionA, scope: { kind: 'user' }, context: { kind: 'user' }, profileEligible: true }, ansA,
    { question: '你平时喝什么饮品？', requestId: 'req-a', questionId: 'q-a', custom: true, questionAt: nowMs + 100, questionProfileGen: 0 },
    { at: nowMs + 200, timezone: 'UTC' })
  store.tx(() => {
    runtime.recordNoteRangeInTx?.({ session: sessionA, fromSeq: 3, toSeq: 6, turn: 2, ids: [ansA], assistant: '' })
  })
  await runtime.wake()

  // Confirm production journal commit retired Turn 1 automatically (only Turn 2 retained for previous()),
  // and verify Dream profile planner still admits valid question even if memory_note_ranges is empty!
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_note_ranges WHERE session=?').get(sessionA)?.n, 1)
  assert.equal(store.db.prepare("SELECT status FROM memory_note_ranges WHERE session=? AND turn=2").get(sessionA)?.status, 'written')
  assert.equal(store.db.prepare('SELECT question_sources_json FROM memory_note_ranges WHERE session=? AND turn=2').get(sessionA)?.question_sources_json, '[]')
  store.db.prepare('DELETE FROM memory_note_ranges WHERE session=?').run(sessionA)

  // Verify Dream profile planner STILL admits the valid question from memory_sources direct columns!
  await runtime.runDocumentDream()
  assert.ok(dreamProfileInputs.length >= 1)
  const validEntry = dreamProfileInputs.at(-1)!.canonicalSources.find(s => s.sourceId === ansA)
  assert.ok(validEntry, 'valid custom answer must reach Dream profile planner')
  assert.equal(validEntry.question, '你平时喝什么饮品？', 'valid question must survive range deletion via memory_sources metadata')
  assert.equal(validEntry.questionUnavailable, false)

  // Case B: Revoking a question-only prerequisite preserves the independently valid human custom answer while withholding ONLY the question text!
  const sessionB = 'sess-q-revoked'
  const prereqB = randomUUID()
  const ansB = randomUUID()
  const prevDayMs = nowMs - 86_400_000
  runtime.accept('旧前提：先看这个敏感草稿', { conversation: sessionB, session: sessionB, scope: { kind: 'user' }, context: { kind: 'user' }, profileEligible: true }, prereqB, undefined, { at: prevDayMs, timezone: 'UTC' })
  store.tx(() => {
    runtime.recordNoteRangeInTx?.({ session: sessionB, fromSeq: 0, toSeq: 3, turn: 1, ids: [prereqB], assistant: '' })
  })
  await runtime.wake()
  // Answer depends on prereqB via session context, then we revoke prereqB BEFORE WRITE_NOTE runs on turn 2 (next day)!
  runtime.accept('以后汇报统一用要点列表', { conversation: sessionB, session: sessionB, scope: { kind: 'user' }, context: { kind: 'user' }, profileEligible: true }, ansB,
    { question: '汇报格式是否沿用上面草稿？', requestId: 'req-b', questionId: 'q-b', custom: true, questionAt: nowMs + 1_100, questionProfileGen: 0 },
    { at: nowMs + 1_200, timezone: 'UTC' })
  store.tx(() => {
    runtime.recordNoteRangeInTx?.({ session: sessionB, fromSeq: 3, toSeq: 6, turn: 2, ids: [ansB], assistant: '' })
  })
  // Revoke ONLY the prerequisite source prereqB (simulating forgotten/redacted prior turn)!
  store.db.prepare("UPDATE memory_sources SET text=NULL, hash=NULL, outcome='rejected' WHERE id=?").run(prereqB)
  noteInputs = []
  await runtime.wake()

  // WRITE_NOTE must STILL retain the valid custom answer text while withholding the revoked question!
  const noteInputForB = noteInputs.find(inp => inp.turns.some(turn => turn.user.some(u => u.sourceId === ansB)))
  assert.ok(noteInputForB, 'WRITE_NOTE must preserve valid custom answer when only question prerequisite is revoked')
  const userInNoteB = noteInputForB.turns.flatMap(t => t.user).find(u => u.sourceId === ansB)!
  assert.equal(userInNoteB.text, '以后汇报统一用要点列表')
  assert.equal(userInNoteB.question, null, 'revoked question prerequisite must withhold question text in WRITE_NOTE')

  // And after deleting memory_note_ranges, Dream profile planner ALSO preserves the custom answer while withholding the question!
  store.db.prepare('DELETE FROM memory_note_ranges WHERE session=?').run(sessionB)
  dreamProfileInputs = []
  await runtime.runDocumentDream()
  assert.ok(dreamProfileInputs.length >= 1)
  const revokedEntry = dreamProfileInputs.at(-1)!.canonicalSources.find(s => s.sourceId === ansB)
  assert.ok(revokedEntry, 'Dream profile planner must preserve valid custom answer after question prerequisite revocation')
  assert.equal(revokedEntry.text, '以后汇报统一用要点列表')
  assert.equal(revokedEntry.question, null)
  assert.equal(revokedEntry.questionUnavailable, true)
})

test('Phase 4A Codex R1 P1-1..P1-4: task custom answer settlement, human-only deleted range, unattended zero L3 pre-step, and unavailable standalone cwd retry', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4a-r1-p1-')

  // P1-1: Task custom answer via acceptQuestionAnswer (with legacy context.kind==='task') normalizes to global user workspace
  // and settles alongside task-brief + task-assistant in one transaction without memory-turn-scope!
  const root1 = path.join(dir, 'mem-p11')
  const owner1 = openMemoryOwner({
    root: root1,
    hostNamespace: 'viva',
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async () => ({ status: 'ok', assistant: '华东部署结论' }),
    compute: job => job.stage === 'note'
      ? Promise.resolve(JSON.stringify({ status: 'write', title: '任务问答', markdown: '任务问答记录' }))
      : null,
  })
  defer(() => owner1.close())
  await owner1.recover()
  const taskSid = randomUUID(), taskConv = randomUUID(), ansOpId = randomUUID(), nowMs = Date.now()
  owner1.beginTurn({ sessionId: taskSid, turn: 1, sessionKind: 'task', conversation: taskConv, cwd: dir })
  await owner1.handleHost('acceptQuestionAnswer', {
    operationId: ansOpId,
    text: '本次任务部署到上海机房',
    session: taskSid,
    turn: 1,
    conversation: taskConv,
    cards: [{ id: 'q1', question: '部署到哪个机房？', header: '机房', options: [{ label: '北京' }], multiSelect: false }],
    requestId: 'req-task-q1',
    questionId: 'q1',
    context: { kind: 'task', id: taskSid },
    questionAt: nowMs,
    questionProfileGen: 0,
  })
  const settled1 = await owner1.settleTurn({
    sessionId: taskSid, cwd: dir, sessionKind: 'task', conversation: taskConv, inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 5, turn: 1, reasonKind: 'completed',
    sources: [
      { sourceId: randomUUID(), author: 'agent', sourceKind: 'task-brief', profileEligible: false, text: '执行机房部署检查', conversation: taskConv, at: nowMs, timezone: 'UTC' },
      { sourceId: randomUUID(), author: 'assistant', sourceKind: 'task-assistant', profileEligible: false, text: '华东部署结论', conversation: taskConv, at: nowMs + 1, timezone: 'UTC' },
    ],
    assistantText: '华东部署结论', at: nowMs + 2, timezone: 'UTC', flushNotes: true,
  })
  assert.deepEqual(settled1, { status: 'ok', nextSeq: 5 })
  const db1 = new DatabaseSync(path.join(root1, 'memory.db'), { readOnly: true })
  defer(() => db1.close())
  const ansRow = db1.prepare('SELECT context, source_kind, profile_eligible FROM memory_sources WHERE id=?').get(ansOpId) as
    { context: string, source_kind: string, profile_eligible: number }
  assert.deepEqual(JSON.parse(ansRow.context), { kind: 'user' })
  assert.equal(ansRow.source_kind, 'task-question-answer')
  assert.equal(ansRow.profile_eligible, 1)
  assert.equal(db1.prepare('SELECT next_seq FROM owner_intake_cursors WHERE session=?').get(taskSid)?.next_seq, 5)

  // P1-2: Human-only completed turn (assistantText: '', assistantDigest: null) whose DSH session was deleted
  // BEFORE WRITE_NOTE MUST still call readSessionRange, skip the range, and emit 0 new Daily Notes!
  const root2 = path.join(dir, 'mem-p12')
  let rangeReads = 0
  let noteComputeCalls = 0
  const owner2 = openMemoryOwner({
    root: root2,
    hostNamespace: 'viva',
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async () => { rangeReads++; return { status: 'deleted' } },
    compute: job => {
      if (job.stage === 'note') {
        noteComputeCalls++
        return Promise.resolve(JSON.stringify({ status: 'write', title: '不应该写出', markdown: '不应写出' }))
      }
      return null
    },
  })
  defer(() => owner2.close())
  await owner2.recover()
  const deletedHumanSrc = randomUUID()
  await owner2.settleTurn({
    sessionId: 'sess-human-only-deleted', cwd: dir, sessionKind: 'main', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: deletedHumanSrc, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '仅真人口述已删除会话', at: nowMs, timezone: 'UTC' }],
    assistantText: '', at: nowMs, timezone: 'UTC',
  })
  await owner2.runtime.wake()
  assert.ok(rangeReads >= 1, 'WRITE_NOTE must check readSessionRange even when assistantDigest is null')
  assert.equal(noteComputeCalls, 0, 'confirmed deleted session must not generate a new Daily Note')
  const db2 = new DatabaseSync(path.join(root2, 'memory.db'), { readOnly: true })
  defer(() => db2.close())
  assert.equal(db2.prepare('SELECT status FROM memory_note_ranges WHERE session=?').get('sess-human-only-deleted')?.status, 'skipped')
  assert.equal(db2.prepare('SELECT text FROM memory_sources WHERE id=?').get(deletedHumanSrc)?.text, '仅真人口述已删除会话')

  // P1-3: Unattended prompt with empty humanSpans triggers ZERO L3 automaticRecall calls on real agent/pre-step!
  const unattendedWire = wrapRawWithProvenance('定时汇总日报内容', { origin: 'unattended', sourceKind: 'unattended', sessionKind: 'unattended' }, '').text
  const unattendedMsg = createUserMessage({ content: [{ type: 'text', text: unattendedWire }], source: { kind: 'user' } })
  assert.deepEqual(extractRecallQueries([unattendedMsg], { host: true }), [])
  const cfg = path.join(dir, 'cordis-p13.yml')
  writeFileSync(cfg, JSON.stringify([
    ...['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions']
      .map(name => ({ id: name, name: '@deepseek-ai/' + name })),
    { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(dir, 'sessions-p13'), compression: 'zstd' } },
  ]))
  const ctx = await boot('p4a-r1-p13', cfg, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx.fiber.dispose() })
  const seenRequests: string[] = []
  class StaticAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      seenRequests.push(JSON.stringify(options.messages))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new StaticAdapter())
  const port = makeFakePort()
  const pluginOwner = applyMemoryAdapter(ctx, { host: true, dataRoot: path.join(dir, 'mem-p13'), dailyNotes: false }, port as unknown as NodeJS.Process)
  t.after(async () => { await pluginOwner.close() })
  assert.ok(await eventually(() => pluginOwner.ready(), { timeoutMs: 15_000 }))
  await pluginOwner.handleHost('createFile', { args: [{ operationId: randomUUID(), title: '定时汇总日报内容', text: '定时汇总日报内容 PRIVATE_UNATTENDED_SECRET_MARKER' }] })
  const unattHandle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: dir }, agentOptions: { provider: 'mock', model: 'mock' } })
  t.after(async () => { await unattHandle.dispose() })
  const unattDone = deferred<void>()
  ctx.on('session/event', (s, ev) => { if (s.id === unattHandle.agent.session.id && ev.type === 'turn/end') unattDone.resolve() })
  unattHandle.agent.send(createUserMessage({ content: [{ type: 'text', text: unattendedWire }], source: { kind: 'user' } }), 'next-turn', true)
  await unattDone.promise
  assert.equal(seenRequests.length, 1)
  assert.equal(seenRequests[0]!.includes('<memory-recall'), false, 'unattended pre-step must never inject L3 memory-recall')
  assert.equal(seenRequests[0]!.includes('PRIVATE_UNATTENDED_SECRET_MARKER'), false)

  // P1-4: Temporarily unavailable standalone project directory leaves cursor untouched; restoring cwd succeeds!
  const root4 = path.join(dir, 'mem-p14')
  const owner4 = openMemoryOwner({ root: root4, dailyNotes: false, compute: () => null, route: () => null })
  defer(() => owner4.close())
  await owner4.recover()
  const missingCwd = path.join(dir, 'temp-offline-repo')
  const srcId4 = randomUUID()
  const blocked = await owner4.settleTurn({
    sessionId: 'sess-offline-cwd', cwd: missingCwd, sessionKind: 'main', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: srcId4, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '离线目录恢复后保留的偏好', at: nowMs, timezone: 'UTC' }],
    assistantText: '', at: nowMs, timezone: 'UTC',
  })
  assert.equal(blocked.status, 'scope_unavailable')
  assert.equal(owner4.intakeCursor('sess-offline-cwd').nextSeq, null, 'cursor must NOT advance when cwd scope is temporarily unavailable')
  mkdirSync(missingCwd, { recursive: true })
  const recovered = await owner4.settleTurn({
    sessionId: 'sess-offline-cwd', cwd: missingCwd, sessionKind: 'main', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: srcId4, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '离线目录恢复后保留的偏好', at: nowMs, timezone: 'UTC' }],
    assistantText: '', at: nowMs, timezone: 'UTC',
  })
  assert.deepEqual(recovered, { status: 'ok', nextSeq: 3 })
  const db4 = new DatabaseSync(path.join(root4, 'memory.db'), { readOnly: true })
  defer(() => db4.close())
  assert.equal(db4.prepare('SELECT text FROM memory_sources WHERE id=?').get(srcId4)?.text, '离线目录恢复后保留的偏好')
})

test('Phase 4A Codex R1 P2-1..P2-6: standalone verbatim text, open-turn UUID verification, real task-card producer, retry rearm/disposal handoff, O(1) range cleanup, and multi-step final task conclusion', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4a-r1-p2-')
  const nowMs = Date.parse('2026-11-23T12:00:00Z')

  // P2-1: Standalone DSH (host: false) preserves literal Viva header verbatim and never switches sessionKind to unattended!
  const spoofedHeader = wrapRawWithProvenance('示例文本', { origin: 'unattended', sourceKind: 'unattended', sessionKind: 'unattended' }, '').text
  const standaloneMsg1 = createUserMessage({ content: [{ type: 'text', text: spoofedHeader }], source: { kind: 'user' } })
  const standaloneMsg2 = createUserMessage({ content: [{ type: 'text', text: '普通偏好：喜欢深色主题' }], source: { kind: 'user' } })
  const extractedStandalone = extractHumanMessages([standaloneMsg1, standaloneMsg2], { host: false })
  assert.deepEqual(extractedStandalone.map(item => item.text), [spoofedHeader, '普通偏好：喜欢深色主题'])

  const root1 = path.join(dir, 'mem-p21')
  const owner1 = openMemoryOwner({ root: root1, dailyNotes: false, compute: () => null, route: () => null })
  defer(() => owner1.close())
  await owner1.recover()
  const persistedMap = new Map<string, Session>()
  const makePersisted = (id: string) => {
    const s = Session.create(SessionId(id), [], { version: 4, id: SessionId(id), createdAt: nowMs, cwd: dir, isSeeded: false })
    persistedMap.set(id, s)
    return s
  }
  const fakePersistenceObj = {
    async open(id: SessionId) {
      const s = persistedMap.get(String(id))
      if (!s) throw notFoundError()
      return {
        inheritedEventCount: s.inheritedEventCount,
        async read(from: number, limit: number) { return { events: s.snapshotEvents().slice(from, from + limit) } },
        async close() {},
      }
    },
    async list() { return [...persistedMap.values()].map(s => ({ header: s.header, revision: 'r1' as never })) },
  }
  const fakePersistence = fakePersistenceObj as unknown as Parameters<typeof createSessionIngestion>[2]
  const makeAdapter = (o: typeof owner1) => ({
    get epoch() { return 'ep-1' },
    inEpoch: async <T,>(_ep: string | undefined, fn: () => Promise<T>) => fn(),
    intakeCursor: async (s: string) => o.intakeCursor(s),
    advanceIntakeCursor: async (i: Parameters<typeof o.advanceIntakeCursor>[0]) => o.advanceIntakeCursor(i),
    beginTurn: async (i: Parameters<typeof o.beginTurn>[0]) => o.beginTurn(i),
    stageOpenTurnSources: async (i: Parameters<typeof o.stageOpenTurnSources>[0]) => o.stageOpenTurnSources(i),
    settleTurn: async (i: Parameters<typeof o.settleTurn>[0]) => o.settleTurn(i),
  })
  const standaloneIngest = createSessionIngestion(makeAdapter(owner1), { flush: async () => true }, fakePersistence, { host: false })
  const sStandalone = makePersisted('sess-standalone-verbatim')
  sStandalone.append('turn/start', { turn: 1 })
  sStandalone.append('user/message', standaloneMsg1, { surfaceOp: 'append' })
  sStandalone.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sStandalone.append('turn/start', { turn: 2 })
  sStandalone.append('user/message', standaloneMsg2, { surfaceOp: 'append' })
  sStandalone.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await standaloneIngest.synchronize(sStandalone)
  const db1 = new DatabaseSync(path.join(root1, 'memory.db'), { readOnly: true })
  defer(() => db1.close())
  assert.equal(db1.prepare('SELECT session_kind FROM owner_intake_cursors WHERE session=?').get('sess-standalone-verbatim')?.session_kind, 'main')
  const standaloneTexts = (db1.prepare('SELECT text FROM memory_sources WHERE session=? ORDER BY rowid').all('sess-standalone-verbatim') as Array<{ text: string }>).map(r => r.text)
  assert.deepEqual(standaloneTexts, [spoofedHeader, '普通偏好：喜欢深色主题'])

  // P2-2: Open-turn staging rejects cross-session UUID reuse with different text!
  const sharedUuid = randomUUID()
  owner1.stageOpenTurnSources({
    sessionId: 'sess-A', turn: 1, sessionKind: 'main', conversation: 'conv-A', cwd: dir,
    sources: [{ sourceId: sharedUuid, author: 'user', sourceKind: 'main-human', profileEligible: true, text: 'A会话的机密偏好', at: nowMs, timezone: 'UTC' }],
  })
  const spoofStage = owner1.stageOpenTurnSources({
    sessionId: 'sess-B', turn: 1, sessionKind: 'main', conversation: 'conv-B', cwd: dir,
    sources: [{ sourceId: sharedUuid, author: 'user', sourceKind: 'main-human', profileEligible: true, text: 'B会话伪造文本', at: nowMs + 1, timezone: 'UTC' }],
  })
  assert.deepEqual(spoofStage.staged, [], 'conflicting UUID replay in another session must not be staged')
  assert.equal(await owner1.rememberSidecarFile('sess-B', 'A会话的机密偏好', new AbortController().signal), null)

  // P2-3: Real task-card human follow-up producer path through taskRuntime.window.message() -> historyDb.sourceLink()!
  const appDb = openAppDb({ file: path.join(dir, 'app-p23.db') })
  defer(() => appDb.close())
  const historyDb = openHistoryDb({ db: appDb.db })
  defer(() => historyDb.close())
  const mainConv = historyDb.save(historyDb.create({ sessionId: 'main-s' }), [{ role: 'user', text: '主对话', receipt: null }]).id
  const taskStore = createTaskStore({ db: appDb.db })
  const dispatchedSteers: Array<{ taskId: string, text: string, meta: unknown }> = []
  const taskSessionId = randomUUID()
  const taskRuntime = createTaskRuntime({
    db: historyDb,
    store: taskStore,
    current: () => historyDb.get(mainConv)!.conversation,
    agentInfo: () => ({ mode: 'ready', model: 'mock' }),
    agent: {
      startTask: async () => ({ ok: true, taskId: taskSessionId }),
      promptTask: () => {},
      steerTask: async (taskId, text, meta) => { dispatchedSteers.push({ taskId, text, meta }); return { ok: true } },
      resumeTask: async () => ({ ok: true }),
      cancelTask: async () => {},
      closeTask: async () => {},
    },
  })
  defer(() => taskRuntime.dispose())
  await taskRuntime.agent.start('后台检查配置', '检查配置')
  const humanFollowupText = '卡片真人追问：优先核对华南集群\u200B配置'
  const delivered = await taskRuntime.window.message(taskSessionId, humanFollowupText)
  assert.ok('sourceId' in delivered && typeof delivered.sourceId === 'string')
  assert.equal(dispatchedSteers.length, 1)
  const sentMeta = dispatchedSteers[0]!.meta as { origin: string, sourceId?: string, conversationId?: string }
  assert.equal(sentMeta.origin, 'human')
  assert.equal(sentMeta.sourceId, delivered.sourceId)
  assert.ok(sentMeta.conversationId)
  // Feed the exact steer output through viva-task-human-steer ingestion -> memory_sources -> historyDb.sourceLink()!
  const root2 = path.join(dir, 'mem-p23')
  const owner2 = openMemoryOwner({ root: root2, hostNamespace: 'viva', dailyNotes: false, compute: () => null, route: () => null })
  defer(() => owner2.close())
  await owner2.recover()
  const hostIngest = createSessionIngestion(makeAdapter(owner2), { flush: async () => true }, fakePersistence, { host: true })
  const wrappedFollowup = withTaskRequestSource(humanFollowupText, randomUUID())
  const sTaskCard = makePersisted(taskSessionId)
  sTaskCard.append('turn/start', { turn: 1 })
  sTaskCard.append('user/message', createUserMessage({
    content: [{ type: 'text', text: wrappedFollowup.text }],
    source: { kind: 'viva-task-human-steer', sourceId: sentMeta.sourceId, conversationId: sentMeta.conversationId, humanSpans: wrappedFollowup.payloadSpans },
  }), { surfaceOp: 'append' })
  // P2-6: Two-step background task: preliminary wrong guess -> tool result -> corrected final conclusion!
  sTaskCard.append('assistant/message', { message: { id: 'a-step-1', role: 'assistant', content: [{ type: 'text', text: '初步猜测：配置在北美机房（待核实）' }] }, interrupted: false } as never, { surfaceOp: 'append' })
  sTaskCard.append('assistant/message', { message: { id: 'a-step-2', role: 'assistant', content: [{ type: 'text', text: '最终结论：已核实华南集群配置正常。' }] }, interrupted: false } as never, { surfaceOp: 'append' })
  sTaskCard.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await hostIngest.synchronize(sTaskCard)
  const db2 = new DatabaseSync(path.join(root2, 'memory.db'), { readOnly: true })
  defer(() => db2.close())
  const humanSteerRow = db2.prepare('SELECT id, text, source_kind, profile_eligible FROM memory_sources WHERE id=?').get(sentMeta.sourceId!) as
    { id: string, text: string, source_kind: string, profile_eligible: number } | undefined
  assert.ok(humanSteerRow)
  assert.equal(humanSteerRow.text, humanFollowupText)
  assert.equal(humanSteerRow.source_kind, 'task-human-steer')
  assert.equal(humanSteerRow.profile_eligible, 1)
  assert.ok(historyDb.sourceLink(humanSteerRow.id), 'task-card human follow-up produced by taskRuntime.window.message must resolve historyDb.sourceLink()')
  const taskAsstRow = db2.prepare("SELECT text FROM memory_sources WHERE session=? AND source_kind='task-assistant'").get(taskSessionId) as { text: string } | undefined
  assert.equal(taskAsstRow?.text, '最终结论：已核实华南集群配置正常。', 'multi-step task must publish ONLY the final corrected assistant conclusion')
  assert.equal(taskAsstRow?.text.includes('初步猜测'), false)

  // P2-4: Cold retry rearms past 2+ consecutive intakeCursor() failures; live retry recovers from short-read;
  // disposed session with unresolved work hands off to read-only cold scanner!
  let cursorFailsLeft = 2
  const flakyOwnerAdapter = {
    ...makeAdapter(owner2),
    async intakeCursor(s: string) {
      if (s === 'sess-cold-flaky' && cursorFailsLeft > 0) {
        cursorFailsLeft--
        throw new Error('transient owner RPC failure')
      }
      return owner2.intakeCursor(s)
    },
  }
  const sColdFlaky = makePersisted('sess-cold-flaky')
  const coldFlakySrcId = randomUUID()
  sColdFlaky.append('turn/start', { turn: 1 })
  sColdFlaky.append('user/message', createUserMessage({ content: [{ type: 'text', text: makeHeadedMainPrompt('两次失败后冷恢复成功', '两次失败后冷恢复成功', 'conv-flaky', coldFlakySrcId) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  sColdFlaky.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const liveSessions = new Map<string, Session>()
  let liveShortReadsLeft = 1
  const flakyPersistence = {
    ...fakePersistenceObj,
    async open(id: SessionId) {
      if (String(id) === 'sess-live-dispose' && liveShortReadsLeft > 0) {
        liveShortReadsLeft--
        return { inheritedEventCount: 0, async read() { return { events: [] } }, async close() {} }
      }
      return fakePersistenceObj.open(id)
    },
  } as unknown as Parameters<typeof createSessionIngestion>[2]
  const retryIngest = createSessionIngestion(
    flakyOwnerAdapter,
    { flush: async () => true, get: id => liveSessions.get(String(id)), list: () => [...liveSessions.values()] },
    flakyPersistence,
    { host: true },
  )
  defer(() => retryIngest.drain())
  retryIngest.startColdCatchup()
  assert.ok(await eventually(() => Boolean(db2.prepare('SELECT 1 FROM memory_sources WHERE id=?').get(coldFlakySrcId)), { timeoutMs: 5_000 }),
    'cold retry must rearm after 2+ consecutive intakeCursor failures')

  const sDispose = makePersisted('sess-live-dispose')
  const disposeSrcId = randomUUID()
  sDispose.append('turn/start', { turn: 1 })
  sDispose.append('user/message', createUserMessage({ content: [{ type: 'text', text: makeHeadedMainPrompt('销毁后转冷扫补齐', '销毁后转冷扫补齐', 'conv-disp', disposeSrcId) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  sDispose.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  liveSessions.set('sess-live-dispose', sDispose)
  await retryIngest.synchronize(sDispose) // hits short-read once and arms retry
  liveSessions.delete('sess-live-dispose')
  retryIngest.release(sDispose) // disposal must hand unresolved session to read-only cold scanner!
  assert.ok(await eventually(() => Boolean(db2.prepare('SELECT 1 FROM memory_sources WHERE id=?').get(disposeSrcId)), { timeoutMs: 5_000 }),
    'disposed session with unresolved durable work must hand off to read-only cold recovery')

  // P2-5: 30 ordinary user/assistant turns keep memory_note_ranges retired (<= 1 row) and retained assistant refs O(1) bounded (NOT 465)!
  const root5 = path.join(dir, 'mem-p25')
  const owner5 = openMemoryOwner({
    root: root5,
    hostNamespace: 'viva',
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async () => ({ status: 'ok', assistant: '已收到回答' }),
    compute: job => job.stage === 'note'
      ? Promise.resolve(JSON.stringify({ status: 'write', title: '连续对话', markdown: '连续对话记录' }))
      : null,
  })
  defer(() => owner5.close())
  await owner5.recover()
  for (let i = 0; i < 30; i++) {
    const fromSeq = i * 3
    await owner5.settleTurn({
      sessionId: 'sess-30-turns', cwd: dir, sessionKind: 'main', inheritedSeq: 0,
      expectedNextSeq: i === 0 ? null : fromSeq, fromSeq, toSeq: fromSeq + 3, turn: i + 1, reasonKind: 'completed',
      sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: `第 ${i + 1} 轮普通偏好记录`, at: nowMs + i * 1000, timezone: 'UTC' }],
      assistantText: '已收到回答', at: nowMs + i * 1000, timezone: 'UTC',
    })
    await owner5.runtime.wake()
  }
  const db5 = new DatabaseSync(path.join(root5, 'memory.db'), { readOnly: true })
  defer(() => db5.close())
  const remainingRows = db5.prepare('SELECT assistant_sources_json, question_sources_json FROM memory_note_ranges WHERE session=?').all('sess-30-turns') as
    Array<{ assistant_sources_json: string, question_sources_json: string }>
  assert.equal(remainingRows.length, 1, 'consumed ranges must retire at journal commit, retaining at most 1 latest row')
  const totalAssistantRefs = remainingRows.reduce((sum, row) => sum + (JSON.parse(row.assistant_sources_json) as unknown[]).length, 0)
  assert.ok(totalAssistantRefs <= 2, `retained assistant references across 30 turns must stay O(1) bounded, got ${totalAssistantRefs}`)
  assert.equal(remainingRows[0]!.question_sources_json, '[]')
})
