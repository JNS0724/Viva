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
import { openHistoryDb } from '../src/backend/history-db.ts'
import { openAppDb } from '../src/backend/app-db.ts'
import { applyMemoryAdapter } from '../plugins/memory/lib/adapter.ts'
import {
  createSessionIngestion,
  extractHumanMessages,
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_note_ranges WHERE status='written'").get()?.n, 2)
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

  // Confirm range consumed AND delete all memory_note_ranges rows (simulating post-consumption + DSH log deletion)!
  assert.equal(store.db.prepare("SELECT status FROM memory_note_ranges WHERE session=? AND turn=2").get(sessionA)?.status, 'written')
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
