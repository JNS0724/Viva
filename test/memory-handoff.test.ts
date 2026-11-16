import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs, { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, Session, SessionId, SessionLogOffset, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import { createNativeOutputAttempts } from '../src/memory/node/native-output-attempts.ts'
import { createNativeToolReads } from '../src/memory/node/native-tool-reads.ts'
import { NATIVE_OUTPUT_MARKER } from '../plugins/memory/lib/native/output-attempts.ts'
import { nativeEventDigest } from '../plugins/memory/lib/native/event-digest.ts'
import { recordCompactionInputs } from '../plugins/memory/lib/native/compaction-inputs.ts'
import { openTraceDb, traceStepDigest } from '../plugins/trace/lib/store.ts'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { MEMORY_PROFILE_SYSTEM } from '../src/memory/core/memory-profile.ts'
import { createBackend } from '../src/backend/compose.ts'
import type { FeedItem } from '../src/backend/feed-store.ts'
import type { HostCapabilities, HostEvent } from '../src/backend/host.ts'
import { MEMORY_EMBEDDING_DIMENSIONS } from '../src/memory/node/memory-embedder.ts'
const MEMORY_EMBEDDING_FINGERPRINT = 'handoff-test-vector-space'
import { memoryHash, openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import type { MemoryFileDetail, MemoryFileListResult } from '../src/memory/contracts/file-management.ts'
import { openMemorySemanticIndex } from '../src/memory/node/memory-semantic.ts'
import type { AgentInfo } from '../src/shared/agent-info.ts'
import type { IpcRegistry } from '../src/shared/ipc-contract.ts'
import type { IpcResults, MemorySummaryView } from '../src/shared/ipc-results.ts'
import { CODE_ROOT } from '../src/shared/node/app-roots.ts'
import { requestsIn } from '../src/shared/request-routing/header.ts'
import { eventually } from './fixtures/eventually.ts'
import { lastWords, questionOf, routeFixtureTools, startFakeLlm } from './fixtures/fake-llm.js'
import { runToCrash } from './fixtures/memory-crash-process.ts'
import { scratch } from './fixtures/scratch.js'
import { modelToolResults } from './fixtures/model-tool-results.ts'

const oldValue = 'amber@example.com'
const newValue = 'cobalt@example.com'
const oldFact = `记住：我的周报提交邮箱是 ${oldValue}`
const replacement = `记住：从现在起，我的周报提交邮箱从 ${oldValue} 改为 ${newValue}`
const withdrawalCrashFixture = new URL('./fixtures/memory-withdrawal-crash.ts', import.meta.url)
type ModelMessage = { role?: string, content?: string | { text?: string, type?: string }[] }
type Request = { system?: unknown, messages: ModelMessage[] }
type Task = IpcResults['task:finished'][number]
type Change = IpcResults['memory:list-changes'][number]

function makeScheduleDue(directory: string) {
  const db = new DatabaseSync(join(directory, 'app.db'))
  try {
    db.prepare("UPDATE schedules SET record=json_set(record, '$.scheduledAt', ?) WHERE status='active'")
      .run(new Date(Date.now() - 1000).toISOString())
  } finally { db.close() }
}

function contextGeneration(directory: string, session: string): number {
  const db = new DatabaseSync(join(directory, 'memory', 'memory.db'), { readOnly: true })
  try { return Number(db.prepare('SELECT generation FROM owner_context_generations WHERE session=?').get(session)?.generation ?? 0) }
  finally { db.close() }
}

async function setup(t: TestContext, decide: (request: Request) => object | null, { image = false, dailyNotes = false, fileMode = false } = {}) {
  const { dir: directory, defer } = scratch(t, 'viva-memory-handoff-')
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  const original = { AGENT_CWD: process.env.AGENT_CWD, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DSH_NODE: process.env.DSH_NODE, NO_PROXY: process.env.NO_PROXY }
  delete process.env.DEEPSEEK_API_KEY
  Object.assign(process.env, { AGENT_CWD: workspace, NO_PROXY: '127.0.0.1,localhost' })
  // Electron's executable needs ELECTRON_RUN_AS_NODE, which a plain Node override deliberately omits.
  if (!process.versions.electron && !process.env.DSH_NODE) process.env.DSH_NODE = process.execPath
  const model = await startFakeLlm({ decideFirst: routeFixtureTools(raw => decide(raw as Request)) })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const register: IpcRegistry['handle'] = (channel, listener) => {
    handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
  }
  const call = <T = unknown>(channel: string, ...args: unknown[]): T => {
    const handler = handlers.get(channel)
    assert.ok(handler, channel)
    return handler({}, ...args) as T
  }
  const events: HostEvent[] = []
  const noOp = () => {}
  const host: HostCapabilities = {
    paths: { userData: directory, documents: directory, home: directory }, packaged: false, automation: true, locale: () => 'zh-CN',
    secrets: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() },
    dialogs: { chooseFolder: async () => null, chooseFiles: async () => null, saveFile: async () => null },
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noOp, trash: async () => {} },
    notify: noOp, power: { idleSeconds: () => 0 }, window: { send: event => { events.push(event) },
      broadcastLanguage: noOp, inFront: () => true, setPending: noOp, refreshNative: noOp },
    loginItem: { set: noOp }, shellSettings: () => ({ shortcut: null, openAtLogin: { available: false } }),
  }
  let backend: ReturnType<typeof createBackend> | null = null
  async function stopBackend() {
    if (!backend) return
    const stopped = backend
    backend = null
    stopped.markQuitting()
    try { await stopped.stop() } finally { stopped.close() }
  }
  function openBackend() {
    assert.equal(backend, null)
    backend = createBackend({ host, ipc: { handle: register, on: register }, dailyNotes, fileMode })
    backend.open()
    return backend
  }
  defer(async () => {
    try {
      await stopBackend()
    } finally {
      try { await model.close() } finally {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }
  })
  openBackend()
  await call('models:add', { name: 'Local fixture', api: 'anthropic-messages', baseURL: model.url, models: [{ id: 'deepseek-chat', image }], key: 'test-gateway-key' })
  assert.ok(await eventually(() => call<AgentInfo>('agent:info').sessionId))
  async function ask(text: string) {
    // A completed task may still be reporting in the foreground. The real composer waits for that turn too.
    assert.ok(await eventually(() => events.findLast(event =>
      event.type === 'turn_started' || event.type === 'turn_end' || event.type === 'error')?.type !== 'turn_started'),
    'the foreground is ready for the next prompt')
    const sourceId = randomUUID()
    await call<Promise<void>>('agent:prompt', text, [], sourceId)
    return sourceId
  }
  const newTopic = () => call<Promise<AgentInfo>>('agent:new-session')
  const tasks = () => call<Task[]>('task:finished')
  const feed = () => call<FeedItem[]>('feed:list')
  const memories = async () => (await call<Promise<{ items: { text: string }[] }>>('memory:list', '周报提交邮箱')).items
  const restart = () => call<Promise<unknown>>('settings:set-permission', 'workspace-write')
  async function schedule(text: string) {
    await ask(text)
    const proposal = events.findLast(event => event.type === 'schedule_propose')?.proposal
    assert.equal(proposal?.title, text)
    await call('schedules:accept', proposal.proposalId)
  }
  async function recallOld() {
    await ask(oldFact)
    assert.ok(await eventually(async () => (await memories()).some(item => item.text.includes(oldValue))))
    await ask('查一下 周报提交邮箱')
  }
  async function replace() {
    await newTopic()
    await ask(replacement)
    assert.ok(await eventually(async () => (await call<Promise<Change[]>>('memory:list-changes')).find(change => change.kind === 'supersede')))
    assert.ok((await memories()).some(item => item.text.includes(newValue)))
  }
  return { ask, call, defer, directory, events, feed, memories, model, newTopic, recallOld, replace, restart, schedule, stopBackend, tasks,
    startBackend: () => openBackend().startBridge(),
    wake: () => backend?.signal({ kind: 'system.woke' }) }
}

test('the fifth completed Viva prompt sends actual user and visible assistant text to the daily-note model', { timeout: 45_000 }, async t => {
  const turns = ['我要每周写一份周报', '模板沿用上周', '新增客户反馈', '把进展放在开头', '周五提交']
  const incoming: Array<{ user: Array<{ text: string }>, assistant: string }> = []
  const app = await setup(t, request => {
    if (!JSON.stringify(request.system).includes('整理最近完成的会话回合')) return null
    const input = JSON.parse(questionOf(request.messages)) as { turns: typeof incoming }
    incoming.push(...input.turns)
    return { text: JSON.stringify({ status: 'write', title: '周报安排', markdown: '沿用上周模板，周五提交周报。' }) }
  }, { dailyNotes: true })
  for (const text of turns.slice(0, -1)) await app.ask(text)
  assert.equal(incoming.length, 0)
  await app.ask(turns.at(-1)!)
  assert.ok(await eventually(() => incoming.length === 5))
  assert.deepEqual(incoming.map(turn => turn.user.map(source => source.text)), turns.map(text => [text]))
  assert.ok(incoming[0]?.assistant.includes(turns[0]!))
  assert.equal((await app.memories()).length, 0)
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    const card = await eventually(() => db.prepare('SELECT workspace,path,day FROM memory_daily_notes').get()) as
      { workspace: string, path: string, day: string } | undefined
    assert.ok(card)
    const root = join(app.directory, 'memory', 'memory-files', card.workspace)
    assert.match(fs.readFileSync(join(root, card.path), 'utf8'), /沿用上周模板，周五提交周报/u)
    assert.ok(fs.readFileSync(join(root, `daily/${card.day}.md`), 'utf8').includes(card.path))
    const sessions = fs.readdirSync(join(root, 'session/dialog'))
    assert.equal(sessions.length, 1)
    assert.equal(fs.readFileSync(join(root, 'session/dialog', sessions[0]!), 'utf8').trim().split('\n').length, 5)
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_note_turns WHERE written=0').get()?.n, 0)
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
  }, { dailyNotes: true, fileMode: true })
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

  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva', dailyNotes: true, fileMode: true,
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
  }, { dailyNotes: true, fileMode: true })
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
      for (const item of [compactedOriginal, compactedCheckpoint, compactedTool]) {
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
        const evidence = { sources: [sourceId], dependencies: [], epoch: 0, turnOnly: false }
        archive.record(failedProof, evidence)
        archive.finish(failedProof, { seq: failed.seq, kind: 'attempt', digest: nativeEventDigest(failed) })
        archive.record(reasoningProof, evidence)
        archive.finish(reasoningProof, { seq: reasoning.seq, kind: 'reply', digest: nativeEventDigest(reasoning) })
        archive.record(groupProof, evidence)
        archive.finish(groupProof, { seq: announcement.seq, kind: 'reply', digest: nativeEventDigest(announcement) })
        const affected = archive.affected([{ sourceId, spans: [{ start: 0, end: erased.length }] }], [])
        assert.ok(affected.length >= 2, 'real DSH foreground sends must bind proof before handing over their model payload')
        for (const { result, session, floor, id, generation, turn, step } of affected) {
          assert.equal(session, parentId)
          const prefix = events[floor - 1]
          const marker = prefix && pluginRecordOf(prefix)
          assert.equal(marker?.type, NATIVE_OUTPUT_MARKER)
          assert.deepEqual(marker.data, { id, generation, turn, step })
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

  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva', dailyNotes: true, fileMode: true,
    compute: () => null, route: () => null, quiesce: async () => {} })
  const operationId = randomUUID(), nextOperation = randomUUID()
  try {
    await owner.recover()
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
  const hiddenTrace = await app.call<Promise<{ available: boolean }>>('history:trace', savedHistory.id)
  assert.equal(hiddenTrace.available, false)
  const rewindTrace = await app.call<Promise<{ commands: string[] }>>('timeline:rewind-effects', { keep: 0 })
  assert.ok(!rewindTrace.commands.includes(awaitingToolCleanup))
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
        assert.equal(rewrittenCompactions.length, 7)
        assert.doesNotMatch(JSON.stringify(rewrittenCompactions), new RegExp(compactionSecret, 'u'))
        assert.match(JSON.stringify(events[unconnectedSummary]), /independent compaction remains/)
      } finally { await reader.close() }
    }
  } finally { await mounted.dispose() }
  const settled = new DatabaseSync(join(memoryRoot, 'memory.db'), { readOnly: true })
  try {
    assert.equal(settled.prepare('SELECT count(*) AS count FROM owner_native_original_publications WHERE operation=? AND published=1').get(operationId)?.count, 2)
    assert.equal(settled.prepare('SELECT count(*) AS count FROM owner_native_original_publications WHERE operation=? AND published=1').get(nextOperation)?.count, 2)
    for (const id of [operationId, nextOperation]) assert.ok(settled.prepare('SELECT 1 FROM owner_native_original_completed WHERE operation=?').get(id))
    assert.ok(settled.prepare('SELECT 1 FROM owner_file_native_erasures WHERE operation=?').get(operationId),
      'other native events and host replicas remain independently pending')
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
  const entry = await eventually(async () => (await app.call<Promise<{ items: { id: number, revision: number, text: string }[] }>>('memory:list', '周报提交邮箱'))
    .items.find(item => item.text.includes(oldValue)))
  assert.ok(entry)
  const memoryFile = join(app.directory, 'memory', 'memory.db')
  const hasProfileRef = (db: DatabaseSync) => Boolean(db.prepare(`SELECT 1 FROM memory_projections p, json_each(p.refs) refs
    WHERE json_extract(refs.value,'$.kind')='memory' AND json_extract(refs.value,'$.id')=?`).get(entry.id))
  const profileDb = new DatabaseSync(memoryFile, { readOnly: true })
  try { assert.ok(await eventually(() => hasProfileRef(profileDb))) } finally { profileDb.close() }
  await app.call('history:save', [{ role: 'user', text: oldFact, receipt: null, sourceId }])
  const profileProbe = '随手核对背景资料'
  const unsavedSource = await app.ask(profileProbe)
  assert.ok(app.model.requests.some(raw => {
    const request = raw as Request
    const content = request.messages.at(-1)?.content
    const context = Array.isArray(content) ? content.find(part => part.text?.startsWith('<about-user>'))?.text : null
    return questionOf(request.messages) === profileProbe && context?.includes('助手整理的画像') && context.includes(oldValue)
  }))
  await app.ask('查一下 周报提交邮箱')
  const injected = app.events.filter(event => event.type === 'memory_context')
  assert.ok(injected.some(event => JSON.stringify(event).includes(oldValue) && JSON.stringify(event).includes('周报')), 'native owner contextUsed must preserve the selected facts and match reasons for the foreground trace')
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
    // Finish the no-fact extraction before recovery so its cleanup cannot race this test.
    assert.ok(await eventually(() => survivorStore.prepare(
      "SELECT 1 FROM memory_sources WHERE id=? AND outcome='skipped'",
    ).get(survivorId)), 'the independent prompt finished extraction without a memory fact')
  } finally { survivorStore.close() }
  const generationBeforeRestart = contextGeneration(app.directory, initial.sessionId!)
  await app.stopBackend()
  const copies = new DatabaseSync(memoryFile)
  try {
    assert.ok(hasProfileRef(copies))
    assert.ok(copies.prepare('SELECT rowid FROM memory_lexical_fts WHERE rowid=?').get(entry.id))
    // Seed one normalized passage vector even when the optional local E5 model is unavailable in CI.
    const index = openMemorySemanticIndex(copies)
    assert.ok(index)
    index.configure(MEMORY_EMBEDDING_FINGERPRINT)
    const version = index.version(MEMORY_EMBEDDING_FINGERPRINT)
    assert.ok(version !== null)
    const vector = new Float32Array(MEMORY_EMBEDDING_DIMENSIONS)
    vector[0] = 1
    assert.equal(index.put(MEMORY_EMBEDDING_FINGERPRINT, [{ id: entry.id, revision: entry.revision, vector }], version), 1)
  } finally { copies.close() }

  await runToCrash(withdrawalCrashFixture, 'before-withdrawal', app.directory, conversationId)

  const appDb = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  const memoryDb = new DatabaseSync(memoryFile, { readOnly: true })
  try {
    assert.equal(appDb.prepare('SELECT deleted_at IS NOT NULL AS removed FROM conversations WHERE id=?')
      .get(conversationId)?.removed, 1)
    assert.ok(appDb.prepare("SELECT generation FROM effects WHERE kind='memory.withdraw' AND key=?").get(conversationId))
    assert.equal(String(memoryDb.prepare('SELECT text FROM memory_sources WHERE id=?').get(sourceId)?.text).trim(), oldFact.replace(/^记住：/, ''))
    assert.ok(hasProfileRef(memoryDb))
    assert.ok(memoryDb.prepare('SELECT memory FROM memory_semantic_vectors WHERE memory=?').get(entry.id))
  } finally {
    memoryDb.close()
    appDb.close()
  }

  const offset = app.model.requests.length
  assert.ok(await app.startBackend())
  assert.equal((await app.memories()).length, 0)
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
    assert.equal(hasProfileRef(recoveredMemory), false)
    assert.equal(recoveredMemory.prepare('SELECT rowid FROM memory_lexical_fts WHERE rowid=?').get(entry.id), undefined)
    assert.equal(recoveredMemory.prepare('SELECT memory FROM memory_semantic_vectors WHERE memory=?').get(entry.id), undefined)
  } finally {
    recoveredMemory.close()
    recoveredApp.close()
  }
})

test('generated project summaries, exact recall and chat history remain in their Git workspace', { timeout: 45_000 }, async t => {
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
  const app = await setup(t, request => {
    const system = JSON.stringify(request.system ?? '')
    const last = request.messages.at(-1)
    if (system.includes('你是记忆整理员')) {
      const content = last?.content
      const text = typeof content === 'string' ? content : content?.[0]?.text
      assert.ok(text)
      const { user, spans } = JSON.parse(text) as { user: string, spans: { start: number, end: number }[] }
      return { text: JSON.stringify({ proposals: [firstFact, secondFact].includes(user) ? [{
        spans, kind: 'project', scope: 'project',
        modality: 'asserted', attribution: 'context', keywords: ['构建标记'],
      }] : [] }) }
    }
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
  }, { image: true })
  const repo = (name: string) => {
    const path = join(app.directory, name)
    mkdirSync(join(path, '.git', 'objects'), { recursive: true })
    writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return path
  }
  const projectA = repo('project-a')
  const projectB = repo('project-b')
  const enter = async (directory: string, text: string) => {
    const switched = await app.call<Promise<{ ok: boolean, info: AgentInfo }>>('workdir:switch', directory, { confirmed: true })
    assert.ok(switched.ok)
    const sourceId = randomUUID()
    await app.call('agent:prompt', text, [], sourceId)
    await app.call('history:save', [{ role: 'user', text, receipt: null, sourceId }])
    const summary = await eventually(async () => {
      const { summaries } = await app.call<Promise<{ summaries: { project: MemorySummaryView | null } }>>('memory:get')
      return summaries.project?.generated && summaries.project.items.find(item => item.text === text.replace(/^记住：/u, ''))
    })
    assert.ok(summary && summary.source?.link)
    return switched.info
  }
  const check = async (present: string, excluded: string) => {
    const count = app.model.requests.length
    await app.ask('查看本项目的基本资料')
    await app.ask(recall)
    await app.ask(history)
    // Independent background profile refreshes may run after a workspace switch. Check delivery
    // isolation here; the profile builder's own scoped input is tested in memory-profile.test.ts.
    const messages = app.model.requests.slice(count).filter(raw => !JSON.stringify((raw as Request).system).includes(MEMORY_PROFILE_SYSTEM.split('\n')[0]!)).map(raw => (raw as Request).messages)
    assert.ok(messages.some(rows => {
      const last = JSON.stringify(rows.at(-1))
      return last.includes('<about-user>') && last.includes('项目摘要') && last.includes(present)
    }))
    for (const name of ['memory_recall', 'search_conversations']) assert.ok(messages.some(rows =>
      modelToolResults({ messages: rows }, name).some(result => JSON.stringify(result).includes(present))),
    JSON.stringify({ name, results: messages.flatMap(rows => modelToolResults({ messages: rows }, name)) }))
    assert.ok(messages.every(rows => !JSON.stringify(rows).includes(excluded)), JSON.stringify({ excluded, leaked: messages.filter(rows => JSON.stringify(rows).includes(excluded)) }))
  }
  const sessionA = await enter(projectA, firstFact)
  await check(firstMarker, secondMarker)
  const taskOffset = app.model.requests.length
  await app.ask(`后台做：${backgroundBrief}`)
  assert.ok(await eventually(() => app.tasks().some(task => task.endedAt && task.task.title === backgroundBrief)))
  assert.ok(app.model.requests.slice(taskOffset).some(raw => {
    const request = raw as Request
    return questionOf(request.messages) === backgroundBrief && JSON.stringify(request.messages).includes(firstMarker)
  }), JSON.stringify({ tasks: app.tasks(), requests: app.model.requests.slice(taskOffset).map(raw => ({ question: questionOf((raw as Request).messages), messages: (raw as Request).messages.at(-1) })), errors: app.events.filter(event => event.type === 'error' || event.type === 'task_end') }))
  await app.schedule(scheduleTitle)
  const schedules = () => app.call<{ id: string, title: string }[]>('schedules:list')
  scheduleId = schedules().find(item => item.title === scheduleTitle)?.id
  assert.ok(scheduleId)
  const listOffset = app.model.requests.length
  await app.ask(listSchedules)
  const listResults = (app.model.requests.slice(listOffset) as Request[]).flatMap(request => modelToolResults(request, 'schedule_list'))
  assert.ok(listResults.some(result => JSON.stringify(result).includes(scheduleTitle)),
    JSON.stringify({ schedules: schedules(), results: listResults, lastMessages: (app.model.requests.slice(listOffset) as Request[]).map(request => request.messages.at(-1)) }))
  const subdirectory = join(projectA, 'nested')
  mkdirSync(subdirectory)
  const forked = await app.call<Promise<{ ok: boolean, info: AgentInfo }>>('workdir:switch', subdirectory, { confirmed: true })
  assert.ok(forked.ok)
  assert.equal(forked.info.topicId, sessionA.topicId)
  await check(firstMarker, secondMarker)
  const beforeSwitch = app.model.requests.length
  const sessionB = await enter(projectB, secondFact)
  assert.notEqual(sessionA.sessionId, sessionB.sessionId)
  await check(secondMarker, firstMarker)
  const restrictedOffset = app.model.requests.length
  await app.ask(listSchedules)
  const modelLists = (app.model.requests.slice(restrictedOffset) as Request[]).flatMap(request => modelToolResults(request, 'schedule_list'))
  assert.ok(modelLists.length)
  assert.ok(modelLists.every(result => !JSON.stringify(result).includes(scheduleId)))
  const updateOffset = app.model.requests.length
  await app.ask(updateSchedule)
  assert.ok((app.model.requests.slice(updateOffset) as Request[]).some(request => modelToolResults(request, 'schedule_update').length))
  assert.equal(schedules().find(item => item.id === scheduleId)?.title, scheduleTitle)
  const afterSwitch = app.model.requests.slice(beforeSwitch) as Request[]
  assert.ok(afterSwitch.some(request => questionOf(request.messages) === secondFact && JSON.stringify(request.system).includes('个人工作助手')))
  assert.ok(afterSwitch.filter(request => JSON.stringify(request.system).includes('个人工作助手')
    || questionOf(request.messages).includes(secondMarker)).every(request => !JSON.stringify(request).includes(firstMarker)))

  // A picture-only conversation has delivery provenance without a memory source to recover its original project from.
  assert.ok(sessionA.conversationId)
  const resumedA = await app.call<Promise<{ ok: boolean, info: AgentInfo }>>('history:resume-topic', sessionA.conversationId)
  assert.ok(resumedA.ok)
  const pictureTopic = await app.newTopic()
  assert.ok(pictureTopic.sessionId)
  const sourceId = randomUUID()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = app.call<{ id: string }>('images:keep', Buffer.from(png, 'base64'))
  assert.ok(image)
  await app.call('agent:prompt', '', [image], sourceId)
  assert.ok(app.model.requests.some(raw => JSON.stringify(raw).includes(png)))
  await app.call('history:save', [
    { role: 'user', text: '', images: [image], receipt: null, sourceId },
    { role: 'assistant', text: rawHistoryText, receipt: null },
  ])
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.ok(db.prepare('SELECT project FROM memory_session_projects WHERE session=?').get(pictureTopic.sessionId))
  } finally { db.close() }
  await app.stopBackend()
  rmSync(join(projectA, '.git'), { recursive: true })
  const outsideOffset = app.model.requests.length
  assert.ok(await app.startBackend())
  assert.notEqual(app.call<AgentInfo>('agent:info').sessionId, pictureTopic.sessionId)
  await app.ask('继续查看现在可以用的记录')
  const outside = join(app.directory, 'workspace')
  const loose = await app.call<Promise<{ ok: boolean }>>('workdir:switch', outside, { confirmed: true })
  assert.ok(loose.ok)
  await app.ask(history)
  await app.ask(imageHistory)
  const outsideRequests = (app.model.requests.slice(outsideOffset) as Request[])
    .filter(request => JSON.stringify(request.system).includes('个人工作助手'))
  assert.ok(outsideRequests.some(request => JSON.stringify(request.messages.at(-1)).includes('tool_result')))
  const leaked = outsideRequests.filter(request => {
    const text = JSON.stringify(request.messages)
    return text.includes(firstMarker) || text.includes(rawHistoryText)
  })
  assert.deepEqual(leaked.map(request => JSON.stringify(request.messages.at(-1))), [])
})

test('an explicit save completes in a foreground session that already received a generated profile', { timeout: 30_000 }, async t => {
  const app = await setup(t, () => null)
  await app.ask(oldFact)
  const page = async () => (await app.call<Promise<{ summaries: { user: MemorySummaryView } }>>('memory:get')).summaries.user
  assert.ok(await eventually(async () => { const summary = await page(); return summary.generated && summary.items.some(item => item.text.includes(oldValue)) }))
  await app.newTopic()
  const offset = app.model.requests.length
  await app.ask('核对下背景资料')
  assert.ok((app.model.requests.slice(offset) as Request[]).some(request =>
    JSON.stringify(request.messages.at(-1)).includes('助手整理的画像')))
  const preference = '我以后使用紫罗兰色图标'
  const count = app.model.requests.length
  await app.ask(`记住：${preference}`)
  assert.ok(await eventually(async () => (await app.call<Promise<{ items: { text: string }[] }>>('memory:list', preference)).items.some(item => item.text === preference)))
  assert.ok(app.events.some(event => event.type === 'memory_changed' && 'memories' in event && Array.isArray(event.memories) && event.memories.includes(preference)), 'verified save receipt must reach the renderer notification')
  const foreground = () => app.model.requests.slice(count) as Request[]
  assert.ok(await eventually(() => foreground().some(request => questionOf(request.messages) === `记住：${preference}`)), JSON.stringify({ requests: foreground().map(request => ({ question: questionOf(request.messages), system: JSON.stringify(request.system).slice(0, 80) })), errors: app.events.filter(event => event.type === 'error') }))
  assert.ok(await eventually(() => foreground().some(request => JSON.stringify(request.messages.at(-1)).includes('tool_result'))))
})

async function rewriteRejectedSource(app: Awaited<ReturnType<typeof setup>>, sourceId: string, original: string) {
  await app.call('history:save', [{ role: 'user', text: original, receipt: null, sourceId }])
  const text = '已经替换前面的临时说明'
  const edit = await app.call<Promise<{ ok: boolean, sourceId: string }>>('timeline:rewind', { words: original, keep: 0, text })
  assert.ok(edit.ok)
  await app.call('agent:prompt', text, [], edit.sourceId)
}

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

test('withdrawing a picture-only prompt also invalidates tasks that depended on its session', { timeout: 30_000 }, async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const brief = '按刚才的图片汇总'
  const instruction = '继续处理源图片'
  const next = '基于先前图片给出结果'
  let taskId: string | undefined
  const app = await setup(t, request => {
    if (taskId && questionOf(request.messages) === instruction && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) {
      return { tool: { name: 'message_background_task', input: { taskId, text: next } } }
    }
    return null
  }, { image: true })
  const info = app.call<AgentInfo>('agent:info')
  const image = app.call<{ id: string }>('images:keep', Buffer.from(png, 'base64'))
  const sourceId = randomUUID()
  await app.call('agent:prompt', '', [image], sourceId)
  assert.ok(app.model.requests.some(request => JSON.stringify(request).includes(png)))
  await app.ask(`后台做：${brief}`)
  taskId = (await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === brief)))?.task.id
  assert.ok(taskId)
  await app.call('history:save', [{ role: 'user', text: '', images: [image], receipt: null, sourceId }])
  await app.newTopic()
  await app.call('history:delete', info.conversationId)

  const offset = app.model.requests.length
  await app.ask(instruction)
  const requests = app.model.requests.slice(offset)
  assert.ok(requests.some(request => JSON.stringify(request).includes(instruction)))
  assert.ok(!requests.some(request => questionOf((request as Request).messages) === next))
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'))
  try {
    assert.ok(db.prepare('SELECT id FROM memory_delivered_sources WHERE id=?').get(sourceId))
    assert.equal(db.prepare('SELECT id FROM memory_sources WHERE id=?').get(sourceId), undefined)
    assert.ok(db.prepare('SELECT id FROM memory_excluded_sources WHERE id=?').get(sourceId))
  } finally { db.close() }
})

test('a persisted schedule and foreground requests wait for the independent memory owner', { timeout: 45_000 }, async t => {
  const title = '给邮箱建立定时归档'
  const prompt = '归档到 ' + oldValue
  const app = await setup(t, request => {
    if (questionOf(request.messages) !== title || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    return { tool: { name: 'schedule_create', input: {
      title, prompt, kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
  })
  await app.recallOld()
  await app.schedule(title)
  const manifest = join(CODE_ROOT, 'plugins', 'memory', 'package.json')
  const read = fs.readFileSync
  const invalid = JSON.parse(read(manifest, 'utf8')) as { viva: { contract: { memory: number } } }
  invalid.viva.contract.memory++
  const override = t.mock.method(fs, 'readFileSync', ((file: unknown, ...args: unknown[]) => file === manifest
    ? JSON.stringify(invalid) : Reflect.apply(read, fs, [file, ...args])) as typeof fs.readFileSync)
  const db = new DatabaseSync(join(app.directory, 'app.db'))
  try {
    db.prepare("UPDATE schedules SET record=json_set(record, '$.scheduledAt', ?) WHERE status='active'").run(new Date(Date.now() - 1000).toISOString())
    await app.restart()
  } finally {
    db.close()
    override.mock.restore()
  }
  const words = '记忆 owner 恢复前不应发出模型请求'
  const offset = app.model.requests.length
  await assert.rejects(app.ask(words))
  assert.ok(!app.model.requests.slice(offset).some(raw => questionOf((raw as Request).messages) === words))
  assert.ok(!app.model.requests.some(raw => questionOf((raw as Request).messages) === prompt))
  await app.restart()
  assert.ok(await eventually(() => app.feed().find(item => item.title === title)))
  assert.ok(app.model.requests.some(raw => questionOf((raw as Request).messages) === prompt))
})

test('an ordinary city clarification stays scoped to the routed background task', { timeout: 45_000 }, async t => {
  const marker = 'Set up a background check with a confirmed city'
  const answer = 'Use Shanghai for this task only'
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (JSON.stringify(request.system).includes('记忆整理员') || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    if (question === marker) {
      const requestId = request.messages.flatMap(message => typeof message.content === 'string'
        ? requestsIn(message.content)
        : (message.content ?? []).flatMap((part: { text?: string }) => requestsIn(part.text ?? '')))
        .find(request => request.words === marker)?.id
      if (!requestId) return null
      return { tool: { name: 'commit_route', input: { requestId, goals: [{ goal: marker, disposition: 'needs_input' }],
        actions: [{ kind: 'clarify', question: '在哪个城市？' }] } } }
    }
    if (question === answer && request.messages.some(message => JSON.stringify(message.content).includes('【请求 ID：'))) {
      return { tool: { name: 'start_background_task', input: { title: answer, brief: answer } } }
    }
    return null
  })
  await app.ask(marker)
  await app.ask(answer)
  assert.ok(await eventually(() => app.tasks().some(task => task.endedAt && task.task.title === answer), { timeoutMs: 4_000 }),
    JSON.stringify({
      tasks: app.tasks().map(task => ({ title: task.task.title, status: task.status })),
      requests: (app.model.requests as Request[]).map(request => questionOf(request.messages)),
      errors: app.events.filter(event => event.type === 'error').map(event => event.message),
    }))
  assert.ok(app.model.requests.some(request => questionOf((request as Request).messages) === answer))
  assert.equal((await app.memories()).length, 0)
})

test('an old brief forwarded to an existing task cannot reach DSH after memory replacement', { timeout: 45_000 }, async t => {
  const forward = '交给之前的后台任务补一条'
  const after = '通知旧任务继续核对'
  const followUp = '后续核对，别重复旧内容'
  const unrelated = '另一个无关后台任务'
  const brief = '审计制表复核签署交易合并结算归档质检补齐格式只追加发送目的地址，内部合成：' + oldValue
  let taskId: string | undefined
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (!taskId || ![forward, after].includes(question) || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    return { tool: { name: 'message_background_task', input: { taskId, text: question === forward ? brief : followUp } } }
  })
  await app.ask('后台做：这是一个完全独立的旧后台任务')
  taskId = (await eventually(() => app.tasks().find(task => task.endedAt)))?.task.id
  assert.ok(taskId)
  await app.newTopic()
  await app.recallOld()
  await app.ask(forward)
  assert.ok(await eventually(() => app.tasks().find(task => task.endedAt && task.messages.some(row => row.text.includes(brief)))))
  assert.ok(app.model.requests.some(raw => questionOf((raw as Request).messages).includes(brief)))

  await app.replace()
  await app.newTopic()
  const count = app.model.requests.length
  await app.ask(after)
  await app.ask(`后台做：${unrelated}`)
  assert.ok(await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === unrelated)))
  const prompts = app.model.requests.slice(count).map(raw => questionOf((raw as Request).messages))
  assert.ok(!prompts.includes(followUp))
  assert.ok(prompts.some(text => text.includes(unrelated)))
})

test('task resume and scheduled execution reject a persisted generated-profile dependency after its collection changes', { timeout: 45_000 }, async t => {
  const title = '替我准备定时汇总'
  const scheduled = '运行旧的定时汇总指令'
  const brief = '在后台生成先前约定的汇总'
  const forward = '请继续运行之前的后台检查'
  const followup = '运行旧任务最后一步'
  let taskId: string | undefined
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    if (question === title) return { tool: { name: 'schedule_create', input: {
      title, prompt: scheduled, kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
    if (question === forward && taskId) return { tool: { name: 'message_background_task', input: { taskId, text: followup } } }
    return null
  })
  await app.ask(oldFact)
  assert.ok(await eventually(async () => (await app.memories()).some(item => item.text.includes(oldValue))))
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.ok(await eventually(() => db.prepare("SELECT 1 FROM memory_projections WHERE json_array_length(refs)>0").get()))
    await app.newTopic()
    await app.ask(`后台做：${brief}`)
    taskId = (await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === brief)))?.task.id
    assert.ok(taskId)
    await app.schedule(title)
    const stored = db.prepare(`SELECT fact AS id, revision, collection_revision AS collectionRevision
      FROM memory_session_profile_dependencies WHERE session=?`).get(taskId)
    assert.ok(stored && typeof stored.id === 'number' && typeof stored.collectionRevision === 'number')
    const epoch = db.prepare("SELECT value FROM memory_meta WHERE key='epoch'").get()?.value
    assert.equal(db.prepare('SELECT revision FROM memories WHERE id=?').get(stored.id)?.revision, stored.revision)
    const scheduleDb = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
    try {
      const saved = scheduleDb.prepare(`SELECT 1 FROM schedules s, json_each(s.memory,'$.dependencies') dep
        WHERE json_extract(s.record,'$.title')=? AND json_extract(dep.value,'$.collectionRevision')=?`).get(title, stored.collectionRevision)
      assert.ok(saved)
    } finally { scheduleDb.close() }
    await app.newTopic()
    await app.call('memory:add', '我的可访问性偏好是高对比度', 'preference', randomUUID())
    assert.equal(db.prepare('SELECT revision FROM memories WHERE id=?').get(stored.id)?.revision, stored.revision)
    assert.equal(db.prepare("SELECT value FROM memory_meta WHERE key='epoch'").get()?.value, epoch)
    assert.ok(Number(db.prepare("SELECT value FROM memory_meta WHERE key='revision'").get()?.value) > stored.collectionRevision)
  } finally { db.close() }

  await app.stopBackend()
  makeScheduleDue(app.directory)
  const first = app.model.requests.length
  assert.ok(await app.startBackend())
  assert.ok(await eventually(() => app.feed().find(item => item.title === '定时任务需要重新确认')))
  await app.ask(forward)
  const actual = app.model.requests.slice(first).map(raw => questionOf((raw as Request).messages))
  assert.ok(actual.some(text => text.includes(forward)))
  assert.ok(actual.every(text => !text.includes(followup) && !text.includes(scheduled)))
})

test('a scheduled prompt cannot replay old memory after replacement, and an unrelated schedule runs', { timeout: 45_000 }, async t => {
  const scheduleOld = '替我定时归档周报'
  const scheduleIndependent = '替我定时核对独立数字'
  const stalePrompt = `定时归档到 ${oldValue}`
  const freshPrompt = '执行独立数字核对'
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (![scheduleOld, scheduleIndependent].includes(question) || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    const prompt = question === scheduleOld ? stalePrompt : freshPrompt
    const at = new Date(Date.now() + 60_000).toISOString()
    return { tool: { name: 'schedule_create', input: { title: question, prompt, kind: 'at', at } } }
  })
  await app.schedule(scheduleIndependent)
  await app.newTopic()
  await app.recallOld()
  await app.schedule(scheduleOld)
  await app.replace()

  // Move both durable occurrences to the past so reattaching DSH wakes them.
  const db = new DatabaseSync(join(app.directory, 'app.db'))
  try {
    db.prepare("UPDATE schedules SET record=json_set(record, '$.scheduledAt', ?) WHERE status='active'").run(new Date(Date.now() - 1000).toISOString())
  } finally { db.close() }
  const offset = app.model.requests.length
  await app.call('settings:set-permission', 'workspace-write')
  assert.ok(await eventually(() => app.feed().find(item => item.title === '定时任务需要重新确认')))
  assert.ok(await eventually(() => app.feed().find(item => item.title === scheduleIndependent)))
  const actual = app.model.requests.slice(offset).map(raw => JSON.stringify((raw as Request).messages))
  assert.ok(!actual.some(text => text.includes(stalePrompt)))
  assert.ok(actual.some(text => text.includes(freshPrompt)))
})

test('a scheduled prompt cannot use a fact past its validity window even without a memory write', { timeout: 45_000 }, async t => {
  // The independent owner has its own clock; exercise real expiry instead of mocking only the host.
  const validUntil = new Date(Date.now() + 12_000)
  const localTime = validUntil.toLocaleTimeString('en-GB', { hourCycle: 'h23' })
  const localDate = validUntil.toLocaleDateString('sv-SE')
  const timePhrase = `在 ${localDate} ${localTime} 前`
  const fact = `记住：${timePhrase}，${oldFact.replace(/^记住：/u, '')}`
  const title = '为这次周报设一个归档任务'
  const prompt = `定时归档这次周报到 ${oldValue}`
  const scheduledAt = new Date(validUntil.valueOf() + 5000).toISOString()
  const app = await setup(t, request => {
    if (JSON.stringify(request.system).includes('记忆整理员') && JSON.stringify(request.messages).includes(fact)) {
      const span = (part: string) => ({ start: fact.indexOf(part), end: fact.indexOf(part) + part.length })
      return { text: JSON.stringify({ proposals: [{
        spans: [span(fact.slice(3))], kind: 'fact', scope: 'user', modality: 'asserted', attribution: 'self', keywords: ['周报提交邮箱'],
        fact: { predicate: 'report_email', polarity: 'positive', subject: { kind: 'user', span: span('我') },
          relation: span('周报提交邮箱'), object: span(oldValue) },
        temporal: { kind: 'interval', from: null, to: { date: localDate, time: localTime }, evidence: [span(timePhrase)] },
      }] }) }
    }
    if (questionOf(request.messages) !== title || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    return { tool: { name: 'schedule_create', input: { title, prompt, kind: 'at', at: scheduledAt } } }
  })
  await app.ask(fact)
  assert.ok(await eventually(async () => (await app.memories()).some(item => item.text.includes(oldValue))))
  await app.ask('查一下 周报提交邮箱')
  await app.schedule(title)
  await delay(Math.max(0, new Date(scheduledAt).valueOf() + 100 - Date.now()))
  {
    const offset = app.model.requests.length
    app.wake()
    assert.ok(await eventually(() => app.feed().find(item => item.title === '定时任务需要重新确认')))
    assert.ok(!(await app.memories()).some(item => item.text.includes(oldValue)))
    assert.ok(!app.model.requests.slice(offset).some(request => JSON.stringify(request).includes(prompt)))
  }
})

test('schedule results recheck the facts read during execution before publication', { timeout: 30_000 }, async t => {
  const title = '设置一次定时整理'
  const prompt = '整理本次材料'
  const draft = `定时结果沿用 ${oldValue}`
  let responding = false
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    const tool = JSON.stringify(request.messages.at(-1)).includes('tool_result')
    if (question === title && !tool) return { tool: { name: 'schedule_create', input: {
      title, prompt, kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
    if (question === prompt && !tool) return { tool: { name: 'memory_recall', input: { query: '周报提交邮箱' } } }
    if (tool && JSON.stringify(request.messages).includes(prompt) && JSON.stringify(request.messages.at(-1)).includes(oldValue)) {
      responding = true
      return { text: draft, delayMs: 3000 }
    }
    return null
  })
  await app.schedule(title)
  await app.newTopic()
  await app.recallOld()
  makeScheduleDue(app.directory)
  app.wake()
  assert.ok(await eventually(() => responding))
  await app.replace()
  const db = new DatabaseSync(join(app.directory, 'app.db'))
  app.defer(() => db.close())
  assert.ok(await eventually(() => db.prepare('SELECT attempts FROM schedule_runs').get()?.attempts === 1))
  assert.equal(app.feed().length, 0)
  db.prepare('UPDATE schedule_runs SET due_at=?').run(Date.now() - 1000)
  app.wake()
  const refreshed = await eventually(() => app.feed().find(item => item.title === title))
  assert.ok(refreshed)
  assert.ok(!refreshed.body.includes(draft))
  const recalls = app.model.requests.filter(raw => {
    const request = raw as Request
    return questionOf(request.messages) === prompt && !JSON.stringify(request.messages.at(-1)).includes('tool_result')
  })
  assert.ok(recalls.length >= 2)
  assert.ok(!JSON.stringify(recalls.at(-1)).includes(oldValue))
})

test('an Updates draft keeps the result identity until dispatch and never becomes a user memory source', { timeout: 30_000 }, async t => {
  const title = '定时整理原始材料'
  const prompt = '核对这份日报'
  const draft = `派生内容已核对 ${oldValue}`
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    const tool = JSON.stringify(request.messages.at(-1)).includes('tool_result')
    if (question === title && !tool) return { tool: { name: 'schedule_create', input: {
      title, prompt, kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
    if (question === prompt && !tool) return { tool: { name: 'memory_recall', input: { query: '周报提交邮箱' } } }
    if (tool && JSON.stringify(request.messages).includes(prompt)) return { text: draft }
    return null
  })
  await app.schedule(title)
  await app.newTopic()
  await app.recallOld()
  makeScheduleDue(app.directory)
  app.wake()
  const item = await eventually(() => app.feed().find(item => item.title === title))
  assert.ok(item)
  const text = await app.call<Promise<string>>('feed:continue', item.id)
  assert.ok(text.endsWith(draft))
  await app.newTopic()
  const offset = app.model.requests.length
  const seen = app.events.length
  const operation = randomUUID()
  const send = (words: string, id: string, source = randomUUID()) => app.call<Promise<void>>('agent:prompt', words, [], source, id)
  await assert.rejects(() => send('与结果无关的旧片段', item.id), /保留.*原文/)
  await send(`${text}\n\n解释这段结果`, item.id, operation)
  assert.ok(await eventually(() => app.model.requests.slice(offset).some(raw => JSON.stringify(raw).includes('解释这段结果'))))
  assert.ok(await eventually(() => app.events.slice(seen).find(event => event.type === 'turn_end')))
  const memoryDb = new DatabaseSync(join(app.directory, 'memory', 'memory.db'))
  try { assert.equal(memoryDb.prepare('SELECT id FROM memory_sources WHERE id=?').get(operation), undefined) }
  finally { memoryDb.close() }
  await app.replace()
  const before = app.model.requests.length
  await assert.rejects(async () => app.call('feed:continue', item.id), /已变更/)
  await assert.rejects(() => send(text, item.id), /已变更/)
  assert.ok(!app.model.requests.slice(before).some(raw => JSON.stringify(raw).includes(draft)))
  assert.ok(app.feed().some(row => row.id === item.id && row.body === draft))
})


test('schedule assertions find the matching result before a trailing runtime notice without accepting other tools', () => {
  const request = { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'list-call', name: 'schedule_list', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'list-call', content: '[{"title":"甲项目定时汇总"}]' }] },
    { role: 'user', content: [{ type: 'text', text: '后台任务完成通知' }] },
  ] }
  // This is the old assertion's false negative: the result exists but is no longer last.
  assert.equal(JSON.stringify(request.messages.at(-1)).includes('tool_result'), false)
  assert.deepEqual(modelToolResults(request, 'schedule_list'), ['[{"title":"甲项目定时汇总"}]'])
  assert.deepEqual(modelToolResults(request, 'schedule_update'), [])
  assert.deepEqual(modelToolResults({ messages: [{ content: [{ type: 'tool_result', tool_use_id: 'unrelated', content: '甲项目定时汇总' }] }] }, 'schedule_list'), [])
})

test('custom human answers inside a background task are original sources with task scope and history identity', { timeout: 30_000 }, async t => {
  const brief = '确认工作城市后整理背景任务'
  const app = await setup(t, request => {
    if (JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    if (questionOf(request.messages) === brief) return { tool: { name: 'ask_user_question', input: { questions: [
      { id: 'task-city', question: '这项任务在哪个城市进行？', header: '城市', options: [{ label: '上海', description: '使用上海' }], multiSelect: false },
    ] } } }
    return null
  })
  await app.ask(`后台做：${brief}`)
  const event = await eventually(() => app.events.find(item => item.type === 'task_question'))
  assert.ok(event && 'questionId' in event && typeof event.questionId === 'string' && 'taskId' in event && typeof event.taskId === 'string', JSON.stringify({ tasks: app.tasks(), events: app.events.filter(item => item.type.startsWith('task_') || item.type === 'error'), questions: app.model.requests.map(raw => questionOf((raw as Request).messages)) }))
  const answer = '这项任务在杭州进行'
  assert.equal(await app.call('agent:answer', event.questionId, [{ id: 'task-city', selected: [], custom: answer }], randomUUID()), true)
  assert.ok(await eventually(() => app.tasks().some(task => task.task.id === event.taskId && task.endedAt)))
  const memory = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  const history = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  try {
    const source = memory.prepare("SELECT id,conversation,context FROM memory_sources WHERE author='answer' AND hash=?").get(memoryHash(answer))
    assert.ok(source, 'The canonical answer identity survives automatic source compaction')
    assert.deepEqual(JSON.parse(String(source.context)), { kind: 'task', id: event.taskId })
    assert.equal(history.prepare('SELECT text FROM messages WHERE conversation_id=? AND source_id=?').get(source.conversation, source.id)?.text, answer)
  } finally { memory.close(); history.close() }
})

test('the real DSH send surface removes a stopped original and still delivers a verified disjoint file fragment', { timeout: 45_000 }, async t => {
  const old = '灰桦发布窗口定在周五。', safe = '红茶在周一供应。', query = '红茶什么时候供应？'
  const app = await setup(t, request => {
    if (questionOf(request.messages) === query && !modelToolResults(request, 'memory_recall').length) {
      return { tool: { name: 'memory_recall', input: { query: '红茶' } } }
    }
    return null
  }, { dailyNotes: true, fileMode: true })
  const sourceId = randomUUID()
  await app.call('agent:prompt', old + safe, [], sourceId)
  const first = app.call<AgentInfo>('agent:info')
  assert.ok(first.sessionId && first.conversationId)
  assert.ok(app.model.requests.some(request => JSON.stringify(request).includes(old)))
  const store = openMemoryStore(join(app.directory, 'memory', 'memory.db'))
  try {
    const original = store.readSource(sourceId)
    assert.equal(original?.text, old + safe)
    const workspace = memorySourceWorkspace(original!)
    const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, deferRecovery: true, source(id) {
      const row = store.readSource(id)
      return row?.text ? { text: row.text, workspace: memorySourceWorkspace(row), token: memorySourceToken(row) } : undefined
    } })
    const digest = (slug: string, text: string, start: number, end: number) => documents.commit({
      operationId: randomUUID(), workspace, path: `digest/wiki/${slug}.md`, action: 'CREATE', expectedRevision: null,
      markdown: text, sources: [{ id: sourceId, token: memorySourceToken(original!), spans: [{ start, end }] }], reads: [],
    })
    const stopped = digest('release', old, 0, old.length)
    digest('tea', safe, old.length, old.length + safe.length)
    const list = await app.call<Promise<MemoryFileListResult>>('memory:list-files', { kind: 'digest' })
    const item = list.items.find(file => file.identity.id === stopped.documentId)
    assert.ok(item)
    await app.call('memory:set-file-enabled', { operationId: randomUUID(), identity: item.identity, version: item.version, enabled: false })
  } finally { store.close() }
  const offset = app.model.requests.length
  await app.ask(query)
  const after = app.model.requests.slice(offset) as Request[]
  assert.ok(after.some(request => questionOf(request.messages) === query))
  assert.ok(after.some(request => modelToolResults(request, 'memory_recall').some(result => JSON.stringify(result).includes(safe))))
  assert.ok(!after.some(request => JSON.stringify(request).includes(old)), 'stopped raw history never reaches the provider')
  const continued = app.call<AgentInfo>('agent:info')
  assert.equal(continued.conversationId, first.conversationId)
  assert.notEqual(continued.sessionId, first.sessionId)
})

for (const outcome of ['answer', 'stop'] as const) {
  test(`real DSH recall asks through the foreground Viva card and handles ${outcome}`, { timeout: 45_000 }, async t => {
    const topic = '会场安排', earlier = '会场安排原先是北厅，南厅尚未确认。', query = '这次会场安排是什么？', reply = '这次确定使用图书馆礼堂。'
    let resolveWork: (() => void) | undefined
    const app = await setup(t, request => {
      if (JSON.stringify(request.system).includes('整理最近完成的会话回合')) {
        return { text: JSON.stringify({ status: 'write', title: topic, markdown: earlier }) }
      }
      if (questionOf(request.messages) !== query && lastWords(request.messages) !== query) return null
      const recalled = modelToolResults(request, 'memory_recall')
      if (!recalled.length) return { tool: { name: 'memory_recall', input: { query: topic } } }
      const result = recalled.at(-1)
      const ref = typeof result === 'string' ? (JSON.parse(result) as { clarification?: { ref: string } }).clarification?.ref : undefined
      if (ref && !modelToolResults(request, 'memory_clarify').length) return { tool: { name: 'memory_clarify', input: { ref } } }
      if (resolveWork && modelToolResults(request, 'memory_clarify').some(answer => JSON.stringify(answer).includes(reply))) {
        const resolve = resolveWork
        resolveWork = undefined
        resolve()
        return { tool: { name: 'memory_recall', input: { query: '图书馆礼堂' } } }
      }
      return null
    }, { dailyNotes: true, fileMode: true })
    const sourceId = randomUUID()
    await app.call('agent:prompt', earlier, [], sourceId)
    for (const prompt of ['准备下一次见面。', '先检查交通。', '还是要确认人数。', '我再同步日程。']) await app.ask(prompt)
    const memory = openMemoryStore(join(app.directory, 'memory', 'memory.db'))
    const workId = `dream:${randomUUID()}`
    try {
      const summary = await eventually(async () => (await app.call<Promise<MemoryFileListResult>>('memory:list-files', { kind: 'daily' })).items[0])
      assert.ok(summary)
      const file = await app.call<Promise<MemoryFileDetail>>('memory:read-file', summary.identity)
      const original = memory.readSource(sourceId)!
      const documents = openMemoryDocuments({ db: memory.db, root: memory.fileRoot, deferRecovery: true, source(id) {
        const row = memory.readSource(id)
        return row?.text ? { text: row.text, workspace: memorySourceWorkspace(row), token: memorySourceToken(row) } : undefined
      } })
      const originalRef = { id: original.id, token: memorySourceToken(original) }
      const seeded = documents.commit({ operationId: randomUUID(), workspace: file.identity.workspace, path: 'digest/wiki/follow-up-venue.md',
        action: 'CREATE', expectedRevision: null, markdown: earlier, sources: [originalRef], reads: [] })
      const digest = documents.read(file.identity.workspace, seeded.path)!
      documents.defer({ operationId: workId, workspace: file.identity.workspace, unit: { name: topic, bucket: 'personal', summary: '确认本次会场安排', paths: [file.path] },
        reason: '会场尚有不确定性', sources: [originalRef], reads: [{ id: digest.id, revision: digest.revision, usageVersion: digest.usageVersion }], readPolicies: [],
        files: [{ path: file.path, revision: file.version.contentRevision, policyToken: file.version.policyToken }],
      })
      const offset = app.events.length, asked = app.ask(query)
      const card = await eventually(() => app.events.slice(offset).find(event => event.type === 'question'))
      assert.ok(card && 'questionId' in card && typeof card.questionId === 'string' && 'questions' in card && Array.isArray(card.questions),
        JSON.stringify({ eventTypes: app.events.slice(offset).map(event => event.type), recall: app.model.requests.flatMap(raw => modelToolResults(raw as Request, 'memory_recall')) }))
      const question = card.questions[0] as { id: string; question: string; options: unknown[] }
      assert.match(question.id, /^memory-clarify:file:/)
      assert.match(question.question, /这次关于「会场安排」/)
      assert.deepEqual(question.options, [])
      const answer = () => app.call('agent:answer', card.questionId, [{ id: question.id, selected: [], custom: reply }], randomUUID())
      if (outcome === 'stop') {
        await app.call('agent:cancel')
        await asked
        assert.equal(await answer(), false)
        assert.equal(documents.deferred(file.identity.workspace, workId)?.status, 'pending_clarification')
        assert.equal(memory.readSource(question.id.slice('memory-clarify:file:'.length)), null)
        return
      }
      resolveWork = () => {
        // Consume the ready payload at the provider boundary to exercise the fast
        // resolution race with a real subsequent memory tool and physical send.
        const evidence = documents.deferred(file.identity.workspace, workId)?.answer?.source
        assert.ok(evidence)
        const line = file.markdown.split(/\r?\n/u).findIndex(value => value === earlier) + 1
        assert.ok(line > 0)
        documents.commit({ operationId: workId, workspace: file.identity.workspace, path: digest.path,
          action: 'CORRECT', expectedRevision: digest.revision, markdown: reply, sources: [originalRef, evidence], reads: [digest],
          corrections: [{ path: file.path, revision: file.version.contentRevision, startLine: line, endLine: line, text: earlier, condition: '本次会场', time: '当前' }] })
        documents.resolve(file.identity.workspace, workId)
      }
      assert.equal(await answer(), true)
      await asked
      const receipts = memory.db.prepare('SELECT operation FROM memory_document_answers WHERE deferred=?').all(workId)
      assert.deepEqual(receipts.map(row => row.operation), [question.id.slice('memory-clarify:file:'.length)])
      assert.equal(documents.deferred(file.identity.workspace, workId), null)
      assert.ok(documents.receipt(file.identity.workspace, workId))
      const recalled = app.model.requests.flatMap(raw => modelToolResults(raw as Request, 'memory_recall'))
      assert.doesNotMatch(JSON.stringify(recalled), /北厅|南厅/)
      assert.ok(recalled.some(result => JSON.stringify(result).includes(reply)), 'the real provider receives a subsequent recall after resolution')
      const answers = app.model.requests.flatMap(raw => modelToolResults(raw as Request, 'memory_clarify'))
      assert.match(JSON.stringify(answers), /status.*answered.*图书馆礼堂/)
    } finally { memory.close() }
  })
}
