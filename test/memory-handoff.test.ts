import { pauseOwnedProcess } from './fixtures/diagnostics-process-pause.ts'
import { recordPartialOriginalErasure, withdrawNativeFile } from './fixtures/native-file-erasure.ts'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { ChildProcess } from 'node:child_process'
import fs, { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, Session, SessionId, SessionLogOffset, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import { DREAM_CONSOLIDATE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import { createNativeOutputAttempts } from '../src/memory/node/native-output-attempts.ts'
import { createNativeToolReads } from '../src/memory/node/native-tool-reads.ts'
import { eraseColdNativeCopies } from '../plugins/memory/lib/native/maintenance.ts'
import { NATIVE_OUTPUT_MARKER } from '../plugins/memory/lib/native/output-attempts.ts'
import { nativeEventDigest } from '../plugins/memory/lib/native/event-digest.ts'
import { recordCompactionInputs } from '../plugins/memory/lib/native/compaction-inputs.ts'
import { memoryOriginalContentDigest } from '../plugins/memory/lib/context-recovery.ts'
import { openTraceDb, traceStepDigest } from '../plugins/trace/lib/store.ts'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { createBackend } from '../src/backend/compose.ts'
import type { FeedItem } from '../src/backend/feed-store.ts'
import type { HostCapabilities, HostEvent } from '../src/backend/host.ts'
import { MEMORY_EMBEDDING_DIMENSIONS } from '../src/memory/node/memory-embedder.ts'
const MEMORY_EMBEDDING_FINGERPRINT = 'handoff-test-vector-space'
import { memoryHash, openMemoryStore } from '../src/memory/node/memory-store.ts'
import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'
import { SQLITE_BUSY_TIMEOUT_MS } from '../src/memory/node/sqlite.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import type { MemoryFileDetail, MemoryFileListResult, MemoryFileProfile } from '../src/memory/contracts/file-management.ts'
import { openMemoryFileIndex } from '../src/memory/node/memory-file-index.ts'
import type { AgentInfo } from '../src/shared/agent-info.ts'
import type { IpcRegistry } from '../src/shared/ipc-contract.ts'
import type { IpcResults } from '../src/shared/ipc-results.ts'
import { CODE_ROOT } from '../src/shared/node/app-roots.ts'
import { requestsIn } from '../src/shared/request-routing/header.ts'
import { eventually } from './fixtures/eventually.ts'
import { openMemoryControlDb } from './fixtures/memory-control-db.ts'
import { lastWords, questionOf, routeFixtureTools, startFakeLlm } from './fixtures/fake-llm.ts'
import { scratch } from './fixtures/scratch.js'
import { modelToolResults } from './fixtures/model-tool-results.ts'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import { recordingDiagnosticPort } from './fixtures/diagnostic-port.ts'

const oldValue = 'amber@example.com'
const newValue = 'cobalt@example.com'
const oldFact = `记住：我的周报提交邮箱是 ${oldValue}`

test('a newly selected native session registers its owner metadata once before selection commits', async t => {
  const app = await setup(t, () => null)
  let registrations = 0
  const restore = installDiagnosticPort(recordingDiagnosticPort(event => {
    if (event.event === 'wait.begin' && event.operation === 'memory.owner' && event.identities?.methodId === 'recordSession') registrations++
    return undefined
  }))
  t.after(restore)
  const selected = await app.newTopic()
  assert.ok(selected.sessionId)
  assert.equal(registrations, 1, 'a second post-selection registration can race owner recovery after native initialization already succeeded')
})
type ModelMessage = { role?: string, content?: string | { text?: string, type?: string }[] }
type Request = { system?: unknown, messages: ModelMessage[] }
type Task = IpcResults['task:finished'][number]

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

async function setup(t: TestContext, decide: (request: Request) => object | null, { image = false, dailyNotes = false, ptc = false, ptcFailure = '', ptcDrainSpill = false, onEvent = (_event: HostEvent) => {} } = {}) {
  const { dir: directory, defer } = scratch(t, 'viva-memory-handoff-')
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  if (ptc) {
    const profile = join(directory, 'dsh', 'profiles', 'viva')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: memory-ptc-task-fixture\n      name: ${JSON.stringify(new URL('./fixtures/memory-ptc-tasks.ts', import.meta.url).href)}\n      config: ${JSON.stringify(ptcFailure === 'crash' ? { crashBeforeSearch: join(directory, 'ptc-prepared') } : { rejectSearch: ptcFailure === 'reject', ...(ptcDrainSpill ? { drainReadLog: join(directory, 'ptc-drained-read-log') } : {}) })}\n- id: spill-policy\n  name: '@deepseek-ai/dsh-spill-policy'\n  config:\n    maxInlineTokens: 512\n- id: spill-local\n  name: '@deepseek-ai/dsh-spill-local'\n  config:\n    root: ${JSON.stringify(join(directory, 'spills'))}\n    cleanupPeriodDays: 0\n`)
  }
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
    notify: noOp, power: { idleSeconds: () => 0 }, window: { send: event => { events.push(event); onEvent(event) },
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
    backend = createBackend({ host, ipc: { handle: register, on: register }, dailyNotes })
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
  const prompts = new Map<string, { result: IpcResults['agent:prompt'], requestOffset: number, eventOffset: number }>()
  // This fixture only sends the synthetic text below. Keep failure evidence to
  // that prompt's model messages and host events, without transport credentials.
  const promptDiagnostic = (sourceId: string) => {
    const prompt = prompts.get(sourceId)
    return JSON.stringify({ sourceId, operation: sourceId,
      returned: prompt?.result === undefined ? { kind: 'void' } : { kind: 'receipt', value: prompt.result },
      requests: model.requests.slice(prompt?.requestOffset ?? model.requests.length).map(raw => {
        const request = raw as Request
        return { question: questionOf(request.messages), messages: request.messages.slice(-4) }
      }),
      events: events.slice(prompt?.eventOffset ?? events.length).filter(event =>
        event.type === 'error' || event.type === 'turn_started' || event.type === 'turn_end' || event.type === 'schedule_propose'),
    })
  }
  async function ask(text: string) {
    // A completed task may still be reporting in the foreground. The real composer waits for that turn too.
    assert.ok(await eventually(() => events.findLast(event =>
      event.type === 'turn_started' || event.type === 'turn_end' || event.type === 'error')?.type !== 'turn_started'),
    'the foreground is ready for the next prompt')
    const sourceId = randomUUID()
    const requestOffset = model.requests.length, eventOffset = events.length
    const result = await call<Promise<IpcResults['agent:prompt']>>('agent:prompt', text, [], sourceId)
    prompts.set(sourceId, { result, requestOffset, eventOffset })
    return sourceId
  }
  const newTopic = () => call<Promise<AgentInfo>>('agent:new-session')
  const tasks = () => call<Task[]>('task:finished')
  const feed = () => call<FeedItem[]>('feed:list')
  const files = async () => {
    const result: MemoryFileDetail[] = []
    let cursor: MemoryFileListResult['nextCursor'] = null
    do {
      const page: MemoryFileListResult = await call<Promise<MemoryFileListResult>>('memory:list-files', { kind: 'digest', ...(cursor ? { cursor } : {}) })
      assert.equal(page.status, 'ok')
      for (const item of page.items) {
        if (!item.enabled || item.hasProjection === false) continue
        const detail = await call<Promise<MemoryFileDetail | null>>('memory:read-file', item.identity)
        if (detail) result.push(detail)
      }
      cursor = page.nextCursor
    } while (cursor)
    return result
  }
  const restart = () => call<Promise<unknown>>('settings:set-permission', 'workspace-write')
  async function schedule(text: string) {
    const sourceId = await ask(text)
    const proposal = events.findLast(event => event.type === 'schedule_propose')?.proposal
    assert.equal(proposal?.title, text, promptDiagnostic(sourceId))
    await call('schedules:accept', proposal.proposalId)
  }
  async function recallOld() {
    const sourceId = await ask(oldFact)
    assert.ok(await eventually(async () => (await files()).some(item => item.markdown.includes(oldValue))), promptDiagnostic(sourceId))
    await ask('查一下 周报提交邮箱')
  }
  async function replace() {
    await newTopic()
    const file = (await files()).find(item => item.markdown.includes(oldValue))
    assert.ok(file)
    const edited = await call<Promise<IpcResults['memory:edit-file']>>('memory:edit-file', {
      operationId: randomUUID(), identity: file.identity, version: file.version,
      text: `我的周报提交邮箱是 ${newValue}`,
    })
    assert.equal(edited.status, 'applied')
    assert.ok((await files()).some(item => item.markdown.includes(newValue)))
  }
  return { ask, call, defer, directory, events, feed, files, model, newTopic, recallOld, replace, restart, schedule, stopBackend, tasks,
    startBackend: () => openBackend().startBridge(),
    wake: () => backend?.signal({ kind: 'system.woke' }), agentPid: () => backend?.agentPid() }
}

function messageTexts(request: Request) {
  return request.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
    : (message.content ?? []).flatMap(part => part.text ? [part.text] : []))
}

test('a human prompt racing report busy delivery and its later steer both enter the same native turn once', { timeout: 45_000 }, async t => {
  const question = '报告刚启动时到达的新用户请求', later = '紧随新请求到达的补充'
  const operation = randomUUID(), laterOperation = randomUUID()
  let release = () => {}, reportWaiting = false
  const gate = new Promise<void>(resolve => { release = resolve })
  let app: Awaited<ReturnType<typeof setup>> | undefined
  let incoming: Promise<IpcResults['agent:prompt']> | undefined, retry: typeof incoming
  let offset = 0
  app = await setup(t, request => {
    if (reportWaiting || !questionOf(request.messages).startsWith('【后台任务结束】')) return null
    reportWaiting = true
    return { text: '后台结果已整理好', waitFor: gate }
  }, { onEvent(event) {
    if (!app || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    offset = app.events.length
    incoming = app.call('agent:prompt', question, [], operation)
    retry = app.call('agent:prompt', question, [], operation)
  } })
  app.defer(release)
  await app.ask('后台做：生成一份独立的报告')
  assert.ok(await eventually(() => reportWaiting && incoming !== undefined))
  assert.notEqual((await incoming)?.accepted, false)
  assert.notEqual((await retry)?.accepted, false)
  assert.deepEqual(await app.call('agent:steer', later, laterOperation), { ok: true, delivery: 'sent' })
  await app.call('agent:prompt', question, [], operation)
  await assert.rejects(async () => app!.call('agent:prompt', '同一操作不能改成其他原文', [], operation))
  assert.ok(!app.events.slice(offset).some(event => event.type === 'turn_end'))
  release()
  assert.ok(await eventually(() => app!.events.slice(offset).some(event => event.type === 'turn_end')))
  const after = app.events.slice(offset)
  assert.deepEqual(after.filter(event => event.type === 'turn_end').map(event => event.stopReason), ['end_turn'])
  assert.equal(new Set(after.filter(event => event.type === 'report_delivered').map(event => event.reportId)).size, 1)
  const messages = app.model.requests.map(raw => messageTexts(raw as Request)).findLast(texts =>
    texts.some(text => text.includes('【插话】') && requestsIn(text).some(entry => entry.words.startsWith(later))))
  assert.ok(messages)
  const interjections = messages.flatMap(text => text.includes('【插话】') ? requestsIn(text).map(entry => entry.words) : [])
  assert.deepEqual(interjections.flatMap(words => [question, later].filter(start => words.startsWith(start))), [question, later])
  const history = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.equal(history.prepare('SELECT count(*) n FROM report_records').get()?.n, 1)
    const promptSeq = history.prepare('SELECT seq FROM messages WHERE source_id=?').get(operation)?.seq
    assert.equal(typeof promptSeq, 'number')
    assert.equal(history.prepare('SELECT after_seq FROM report_records').get()?.after_seq, promptSeq)
    for (const id of [operation, laterOperation]) {
      assert.equal(db.prepare('SELECT count(*) n FROM memory_sources WHERE id=?').get(id)?.n, 1)
      assert.equal(history.prepare('SELECT count(*) n FROM routing_request_sources WHERE source=?').get(id)?.n, 1)
    }
  } finally { history.close(); db.close() }
})

test('a picture submitted while a report is opening stays below the report and starts a separate native turn', { timeout: 45_000 }, async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const operation = randomUUID(), question = '看看这张图片'
  let release = () => {}, reportWaiting = false, offset = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  let app: Awaited<ReturnType<typeof setup>> | undefined, incoming: Promise<IpcResults['agent:prompt']> | undefined
  app = await setup(t, request => {
    if (reportWaiting || !questionOf(request.messages).startsWith('【后台任务结束】')) return null
    reportWaiting = true
    return { text: '后台结果已整理好', waitFor: gate }
  }, { image: true, onEvent(event) {
    if (!app || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    offset = app.events.length
    const image = app.call<{ id: string }>('images:keep', Buffer.from(png, 'base64'))
    incoming = app.call('agent:prompt', question, [image], operation)
  } })
  app.defer(release)
  await app.ask('后台做：生成图片消息前的独立报告')
  assert.ok(await eventually(() => reportWaiting && incoming !== undefined))
  assert.ok(app.model.requests.every(raw => !JSON.stringify(raw).includes(png)))
  release()
  assert.notEqual((await incoming)?.accepted, false)
  const after = app.events.slice(offset)
  assert.deepEqual(after.filter(event => event.type === 'turn_end').map(event => event.stopReason), ['end_turn', 'end_turn'])
  assert.ok(app.model.requests.some(raw => messageTexts(raw as Request).some(text => text.includes(question)) && JSON.stringify(raw).includes(png)))
  assert.ok(after.some(event => event.type === 'report_delivered' && event.beforeSource === operation))
  const history = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  try {
    const promptSeq = history.prepare('SELECT seq FROM messages WHERE source_id=?').get(operation)?.seq
    assert.equal(typeof promptSeq, 'number')
    assert.deepEqual(history.prepare('SELECT after_seq FROM report_records').all().map(row => row.after_seq), [promptSeq])
  } finally { history.close() }
})

test('a report arriving during a human turn enters that native turn as a task result', { timeout: 45_000 }, async t => {
  const brief = '生成稍后到达的独立报告', question = '先处理这个独立问题'
  let finishTask = () => {}, finishHuman = () => {}, taskWaiting = false, humanWaiting = false
  let promptOnWire = false, reportSawIdle = false, reportSteered = false, admitPrompt = () => {}
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.stdin) {
      const pipe = this.stdin, write = pipe.write
      t.mock.method(pipe, 'write', function(chunk: unknown, ...rest: unknown[]) {
        const wire = chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk)
        if (!promptOnWire && wire.includes('session/prompt') && wire.includes(question)) {
          promptOnWire = true
          admitPrompt = () => { Reflect.apply(write, pipe, [chunk, ...rest]) }
          return true
        }
        return Reflect.apply(write, pipe, [chunk, ...rest])
      })
    }
    if (event === 'message') {
      const reply = args[0] as { type?: string, status?: string } | undefined
      if (reply?.type === 'report_result' && promptOnWire) {
        if (reply.status === 'idle') reportSawIdle = true
        if (reply.status === 'steered') reportSteered = true
      }
    }
    return Reflect.apply(emit, this, [event, ...args])
  })
  const taskGate = new Promise<void>(resolve => { finishTask = resolve })
  const humanGate = new Promise<void>(resolve => { finishHuman = resolve })
  const app = await setup(t, request => {
    const words = questionOf(request.messages)
    if (!taskWaiting && words === brief) {
      taskWaiting = true
      return { text: '已核对三条记录', waitFor: taskGate }
    }
    if (!humanWaiting && words === question) {
      const id = messageTexts(request).flatMap(requestsIn).find(entry => entry.words.startsWith(question))?.id
      if (!id) return null
      humanWaiting = true
      return { tool: { name: 'commit_route', input: { requestId: id, goals: [{ goal: question, disposition: 'answer' }],
        actions: [{ kind: 'reply', scope: question }] } }, waitFor: humanGate }
    }
    return null
  })
  app.defer(() => { if (promptOnWire && !humanWaiting) admitPrompt(); finishTask(); finishHuman() })
  await app.ask(`后台做：${brief}`)
  assert.ok(await eventually(() => taskWaiting))
  const offset = app.events.length
  const answer = app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', question, [], randomUUID())
  assert.ok(await eventually(() => promptOnWire), 'the host submitted the prompt before native admission')
  finishTask()
  assert.ok(await eventually(() => reportSawIdle), 'the report found no running native turn yet')
  admitPrompt()
  assert.ok(await eventually(() => humanWaiting && reportSteered), 'the actual native start wakes the report before the reply')
  finishHuman(); await answer
  const after = app.events.slice(offset)
  const records = after.filter(event => event.type === 'report_delivered')
  assert.equal(new Set(records.map(event => event.reportId)).size, 1)
  assert.ok(String(records[0]?.text).includes('它在你这一轮工作时到达'))
  assert.ok(String(records[0]?.text).includes('已核对三条记录'))
  assert.ok(!after.some(event => event.type === 'turn_started' && event.by === 'task'))
})

test('a missing native report agent keeps its user interjection retryable after restart', { timeout: 45_000 }, async t => {
  const question = '等待原生会话恢复的用户插话', source = randomUUID()
  const emit = ChildProcess.prototype.emit
  let refused = false, waiting = false, release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', (message: unknown, ...rest: unknown[]) => {
        const request = message as { type?: string, id?: string, text?: string }
        if (request.type === 'steer' && request.text?.includes(question) && !refused) {
          refused = true
          this.emit('message', { type: 'steer_result', id: request.id, ok: false, reason: 'missing' })
          return true
        }
        return Reflect.apply(send, this, [message, ...rest])
      })
    }
    return Reflect.apply(emit, this, [event, ...args])
  })
  const app = await setup(t, request => {
    if (waiting || !questionOf(request.messages).startsWith('【后台任务结束】')) return null
    waiting = true
    return { text: '已完成', waitFor: gate }
  })
  app.defer(release)
  await app.ask('后台做：汇报一个已完成的结果')
  assert.ok(await eventually(() => waiting))
  const result = await app.call<Promise<IpcResults['agent:steer']>>('agent:steer', question, source)
  assert.equal(result.ok, false)
  assert.equal(result.delivery, 'not-sent')
  release()
  assert.ok(await eventually(() => app.events.at(-1)?.type === 'turn_end' || app.events.findLast(event =>
    event.type === 'turn_started' || event.type === 'turn_end')?.type === 'turn_end'))
  await app.stopBackend(); await app.startBackend()
  const receipt = await app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', question, [], source)
  assert.notEqual(receipt?.accepted, false)
  assert.ok(app.model.requests.some(raw => questionOf((raw as Request).messages) === question))
})

function cancelCurrent(app: Awaited<ReturnType<typeof setup>>) {
  const event = app.events.findLast(item => item.type === 'turn_started')
  assert.ok(event)
  return app.call<Promise<boolean>>('agent:cancel', { ...event.context as object, turnId: event.turnId })
}

test('the backend expires Stop while dsh is suspended and recovery only accepts fresh output', { timeout: 45_000 }, async t => {
  const question = '停下来验证超时反馈'
  const lateText = 'this-closed-turn-must-not-appear'
  let release!: () => void
  let waiting = false
  const hold = new Promise<void>(resolve => { release = resolve })
  const app = await setup(t, request => {
    if (questionOf(request.messages) !== question) return null
    waiting = true
    return { text: lateText, waitFor: hold }
  })
  const pending = app.ask(question)
  void pending.catch(() => {})
  app.defer(release)
  assert.ok(await eventually(() => waiting))
  const pid = app.agentPid()
  assert.ok(pid)
  const paused = await pauseOwnedProcess(pid)
  app.defer(() => paused.resume())

  const start = app.events.findLast(event => event.type === 'turn_started')
  assert.ok(start)
  assert.equal(await app.call('agent:cancel', { ...start.context as object, turnId: randomUUID() }), false)
  assert.equal(await app.call('agent:cancel', { ...start.context as object, sessionId: 'other', turnId: start.turnId }), false)
  const snapshot = () => app.call<IpcResults['agent:snapshot']>('agent:snapshot')
  const active = snapshot()
  assert.equal(active.activeTurn?.id, start.turnId)
  assert.equal(active.history?.messages[0]?.text, question)
  const before = app.events.length
  assert.equal(await app.call('agent:cancel', { ...active.context, turnId: active.activeTurn?.id }), true)
  assert.equal(snapshot().activeTurn?.stopping, true)
  assert.ok(app.events.slice(before).some(event => event.type === 'turn_stopping'))
  assert.ok(await eventually(() => app.events.slice(before).some(event => event.type === 'turn_end' && event.stopReason === 'cancel_unconfirmed'), { timeoutMs: 12_000 }))
  assert.throws(() => app.call('agent:prompt', '旧执行端仍不可接单'), /执行端未确认停止/)
  const stopped = snapshot()
  assert.equal(stopped.activeTurn, null)
  assert.equal(stopped.stopUnconfirmed, true)
  assert.deepEqual(stopped.context, start.context)
  assert.equal(stopped.history?.messages[0]?.text, question)
  assert.equal(stopped.history?.messages.at(-1)?.receipt?.stopReason, 'cancel_unconfirmed')
  assert.deepEqual(stopped.replay, [], 'terminal cancel_unconfirmed event is checkpointed by the backend writer')
  await assert.rejects(app.newTopic(), /执行端未确认停止/)
  const after = app.events.length

  await paused.resume()
  release()
  await pending.catch(() => {})
  assert.ok(await app.call('agent:recover'))
  assert.notEqual(app.agentPid(), pid)
  assert.equal(snapshot().stopUnconfirmed, false)
  assert.notEqual(app.call<AgentInfo>('agent:info').sessionId, (start.context as { sessionId: string }).sessionId)
  const requestCount = app.model.requests.length
  await app.ask('恢复后的新问题')
  assert.ok(app.model.requests.slice(requestCount).some(raw => questionOf((raw as Request).messages).includes('恢复后的新问题')),
    JSON.stringify({ questions: app.model.requests.slice(requestCount).map(raw => questionOf((raw as Request).messages)),
      events: app.events.slice(after).filter(event => ['error', 'turn_end', 'turn_started', 'ready'].includes(event.type)) }))
  assert.doesNotMatch(JSON.stringify(app.events.slice(after)), new RegExp(lateText))
})

test('cancelling a report rejects its queued human before any native source is delivered', { timeout: 45_000 }, async t => {
  const question = '取消报告时仍待发送的独立用户原文', operation = randomUUID()
  let app: Awaited<ReturnType<typeof setup>> | undefined
  let incoming: Promise<IpcResults['agent:prompt']> | undefined
  app = await setup(t, () => null, { onEvent(event) {
    if (!app || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    incoming = app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', question, [], operation)
    void cancelCurrent(app).catch(() => {})
  } })
  await app.ask('后台做：生成可以取消的报告')
  assert.ok(await eventually(() => Boolean(incoming)))
  assert.equal((await incoming)?.accepted, false)
  assert.ok(app.model.requests.every(request => !JSON.stringify(request).includes(question)))
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try { assert.equal(db.prepare('SELECT id FROM memory_sources WHERE id=?').get(operation), undefined) }
  finally { db.close() }
  const selected = app.call<AgentInfo>('agent:info')
  await app.stopBackend(); await app.startBackend()
  const restored = await app.call<Promise<{ id: string, messages: Array<{ sourceId?: string, delivery?: 'pending' | 'not-sent' }> } | null>>('history:load')
  assert.equal(restored?.id, selected.conversationId)
  assert.equal(restored?.messages.find(row => row.sourceId === operation)?.delivery, 'not-sent')
  const next = app.model.requests.length
  await app.ask('冷启动后的独立请求')
  assert.ok(app.model.requests.slice(next).every(request => !JSON.stringify(request).includes(question)))
})

test('an early admitted Updates prompt retains the queue until its native turn settles', { timeout: 45_000 }, async t => {
  const title = '准备一份合成资料', scheduled = '生成一次可续接的合成结果', draft = '合成结果只供这次续接使用'
  const later = '派生结果之后的人类原话', feedOperation = randomUUID(), laterOperation = randomUUID()
  let app: Awaited<ReturnType<typeof setup>> | undefined, feedId: string | undefined, feedText = ''
  let incoming: Promise<IpcResults['agent:prompt']> | undefined, following: Promise<unknown> | undefined
  let release = () => {}, modelHeld = false
  const gate = new Promise<void>(resolve => { release = resolve })
  app = await setup(t, request => {
    const question = questionOf(request.messages), tool = JSON.stringify(request.messages.at(-1)).includes('tool_result')
    if (question === title && !tool) return { tool: { name: 'schedule_create', input: {
      title, prompt: scheduled, kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
    if (question === scheduled && !tool) return { text: draft }
    if (!modelHeld && question.includes(draft)) {
      const id = request.messages.flatMap(message => typeof message.content === 'string' ? requestsIn(message.content)
        : (message.content ?? []).flatMap(part => requestsIn(part.text ?? ''))).find(entry => entry.words.includes(draft))?.id
      if (id) {
        modelHeld = true
        return { tool: { name: 'commit_route', input: { requestId: id, goals: [{ goal: '解释这份资料', disposition: 'answer' }],
          actions: [{ kind: 'reply', scope: '解释这份资料' }] } }, waitFor: gate }
      }
    }
    return null
  }, { onEvent(event) {
    if (!app || !feedId || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    incoming = app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', feedText, [], feedOperation, feedId)
    void incoming.catch(() => {})
    following = app.call<Promise<unknown>>('agent:prompt', later, [], laterOperation)
    void following.catch(() => {})
  } })
  app.defer(release)
  await app.schedule(title); makeScheduleDue(app.directory); app.wake()
  const item = await eventually(() => app!.feed().find(item => item.title === title))
  assert.ok(item)
  feedText = await app.call<Promise<string>>('feed:continue', item.id)
  feedId = item.id
  await app.ask('后台做：启动一份独立报告')
  assert.ok(await eventually(() => modelHeld))
  await incoming // The public feed receipt intentionally returns at native onStart.
  assert.ok(!app.model.requests.some(request => questionOf((request as Request).messages) === later))
  release(); await following
  assert.ok(app.model.requests.some(request => questionOf((request as Request).messages) === later))
})

for (const duringReport of [false, true]) test(`a lost host receipt stays unknown after cancellation (${duringReport ? 'report interjection' : 'human prompt'})`, { timeout: 45_000 }, async t => {
  const question = '已经进入原生请求但宿主回执写失败', operation = randomUUID()
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = Reflect.apply(prepare, this, [sql]) as ReturnType<DatabaseSync['prepare']>
    if (!sql.startsWith('UPDATE prompt_deliveries SET state=')) return statement
    return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (...args: unknown[]) => {
        if (args[0] === 'sent' && args[1] === operation) throw new Error('Synthetic delivery receipt failure')
        return Reflect.apply(target.run, target, args)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  let release = () => {}, held = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const app = await setup(t, request => {
    const words = questionOf(request.messages)
    if (!held && (duringReport ? words.startsWith('【后台任务结束】') : words === question)) { held = true; return { text: '等待这次请求结束', waitFor: gate } }
    return null
  })
  app.defer(release)
  if (duringReport) {
    await app.ask('后台做：启动回执故障验证')
    assert.ok(await eventually(() => held))
    const receipt = await app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', question, [], operation)
    assert.equal(receipt?.accepted, false)
    assert.deepEqual(receipt?.sourceIds, [])
    assert.match(receipt?.message ?? '', /Synthetic delivery receipt failure/)
    await cancelCurrent(app); release()
  } else {
    const incoming = app.call<Promise<unknown>>('agent:prompt', question, [], operation)
    const rejected = assert.rejects(incoming, /Synthetic delivery receipt failure/)
    assert.ok(await eventually(() => held))
    await cancelCurrent(app); release(); await rejected
  }
  const db = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  try { assert.equal(db.prepare('SELECT state FROM prompt_deliveries WHERE source=?').get(operation)?.state, 'pending') }
  finally { db.close() }
  const count = app.model.requests.length
  await assert.rejects(async () => app!.call('agent:prompt', question, [], operation))
  assert.equal(app.model.requests.length, count, 'an unknown cold/retired receipt cannot start another attempt')
})

test('a failed not-sent retirement receipt cannot skip cancelling the native report', { timeout: 45_000 }, async t => {
  const question = '明确尚未投递但写回执失败的原话', operation = randomUUID()
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = Reflect.apply(prepare, this, [sql]) as ReturnType<DatabaseSync['prepare']>
    if (!sql.startsWith('UPDATE prompt_deliveries SET state=')) return statement
    return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (...args: unknown[]) => {
        if (args[0] === 'not-sent' && args[1] === operation) throw new Error('Synthetic retirement receipt failure')
        return Reflect.apply(target.run, target, args)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  let app: Awaited<ReturnType<typeof setup>> | undefined, incoming: Promise<unknown> | undefined
  let release = () => {}, nativeHeld = false
  const gate = new Promise<void>(resolve => { release = resolve })
  app = await setup(t, request => {
    if (!nativeHeld && questionOf(request.messages).startsWith('【后台任务结束】')) {
      nativeHeld = true; return { text: '尚未返回的真实报告', waitFor: gate }
    }
    return null
  }, { onEvent(event) {
    if (!app || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    incoming = app.call<Promise<unknown>>('agent:prompt', question, [], [operation])
    void incoming.catch(() => {})
  } })
  app.defer(release)
  await app.ask('后台做：验证取消仍然发生')
  assert.ok(await eventually(() => nativeHeld))
  const rejected = assert.rejects(incoming!, /Synthetic retirement receipt failure/)
  const offset = app.events.length
  const cancelling = cancelCurrent(app)
  assert.throws(() => app!.call('agent:prompt', question, [], [randomUUID()]), /finish|等待|结束/i,
    'retired scheduling ownership cannot let a replay start over a still-cancelling native turn')
  await cancelling; release(); await rejected
  assert.ok(await eventually(() => app!.events.slice(offset).some(event => event.type === 'turn_end' && event.stopReason === 'cancelled')))
  assert.ok(app.model.requests.every(request => !JSON.stringify(request).includes(question)))
})

for (const outcome of ['replacement', 'ended', 'next-turn'] as const) test(`an ordinary steer held in source alias admission respects its original turn (${outcome})`, { timeout: 45_000 }, async t => {
  const before = '保持旧话题运行', after = '保持新话题运行', words = '只能送给旧话题的插话', operation = randomUUID()
  let releaseOld = () => {}, releaseNew = () => {}, releaseAlias = () => {}, aliasHeld = false
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve }), newGate = new Promise<void>(resolve => { releaseNew = resolve })
  let oldModel = false, newModel = false
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', function(this: ChildProcess, message: unknown, ...rest: unknown[]) {
        const frame = message as { type?: string, kind?: string, id?: string, method?: string, input?: { method?: string, input?: { sourceId?: string } } }
        if (!aliasHeld && frame?.type === 'memory_owner_rpc' && frame.kind === 'request' && frame.method === 'host'
          && frame.input?.method === 'sourceAlias' && frame.input.input?.sourceId === operation) {
          aliasHeld = true
          releaseAlias = () => { Reflect.apply(send, this, [message, ...rest]) }
          return true
        }
        return Reflect.apply(send, this, [message, ...rest]) as boolean
      })
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if ((question !== before || oldModel) && (question !== after || newModel)) return null
    const id = request.messages.flatMap(message => typeof message.content === 'string' ? requestsIn(message.content)
      : (message.content ?? []).flatMap(part => requestsIn(part.text ?? ''))).find(entry => entry.words.startsWith(question))?.id
    if (!id) return null
    if (question === before) oldModel = true
    else newModel = true
    return { tool: { name: 'commit_route', input: { requestId: id, goals: [{ goal: question, disposition: 'answer' }],
      actions: [{ kind: 'reply', scope: question }] } }, waitFor: question === before ? oldGate : newGate }
  })
  app.defer(() => { releaseAlias(); releaseOld(); releaseNew() })
  const original = app.ask(before); void original.catch(() => {})
  assert.ok(await eventually(() => oldModel))
  const steered = app.call<Promise<import('../src/shared/agent-info.ts').SteerResult>>('agent:steer', words, operation)
  void steered.catch(() => {})
  assert.ok(await eventually(() => aliasHeld))
  if (outcome === 'replacement') await cancelCurrent(app)
  releaseOld(); await original
  if (outcome === 'replacement') await app.newTopic()
  const fresh = outcome === 'replacement' || outcome === 'next-turn' ? app.ask(after) : null
  void fresh?.catch(() => {})
  if (fresh) assert.ok(await eventually(() => newModel))
  const count = app.model.requests.length
  releaseAlias()
  const result = await steered
  assert.equal(result.ok, false)
  assert.equal(result.delivery, 'not-sent')
  assert.equal(result.reason, outcome === 'replacement' ? 'unavailable' : 'idle')
  releaseOld(); releaseNew(); await original; await fresh
  assert.ok(app.model.requests.slice(count).every(request => !JSON.stringify(request).includes(words)))
  if (outcome === 'ended' || outcome === 'next-turn') {
    // The real renderer's idle path reuses the source for a new prompt, once the
    // currently visible turn ends, rather than steering the replacement turn.
    await assert.rejects(app.call<Promise<void>>('agent:prompt', words + ' 被改动', [], operation), /conflict|冲突/i,
      'a definite not-sent receipt never permits changing the original alias text')
    await app.call('agent:prompt', words, [], operation)
    const db = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM routing_request_sources WHERE source=?').get(operation)?.n, 1) }
    finally { db.close() }
    assert.ok(app.model.requests.slice(count).some(request => questionOf(request.messages) === words))
  }
})

test('first idle deliveries and canonical replay retain FIFO ahead of a later steer', { timeout: 90_000 }, async t => {
  const original = '正在结束的原会话', first = '原插话第一条', second = '原插话第二条', later = '后来到达的第三条'
  const canonical = '已被原生会话接收的独立原文'
  const firstId = randomUUID(), secondId = randomUUID(), laterId = randomUUID()
  const releases = new Map<string, () => void>(), gates = new Map<string, Promise<void>>()
  for (const words of [original, first, second]) gates.set(words, new Promise<void>(resolve => { releases.set(words, resolve) }))
  const aliases = new Map<string, () => void>(), order: string[] = []
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', function(this: ChildProcess, message: unknown, ...rest: unknown[]) {
        const frame = message as { type?: string, kind?: string, method?: string, input?: { method?: string, input?: { sourceId?: string } } }
        const id = frame.input?.input?.sourceId
        if (frame.type === 'memory_owner_rpc' && frame.kind === 'request' && frame.method === 'host'
          && frame.input?.method === 'sourceAlias' && id && (id === firstId || id === secondId) && !aliases.has(id)) {
          aliases.set(id, () => { Reflect.apply(send, this, [message, ...rest]) })
          return true
        }
        return Reflect.apply(send, this, [message, ...rest]) as boolean
      })
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (![original, first, second, later, canonical].includes(question) || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    const id = request.messages.flatMap(message => typeof message.content === 'string' ? requestsIn(message.content)
      : (message.content ?? []).flatMap(part => requestsIn(part.text ?? ''))).find(entry => entry.words.startsWith(question))?.id
    if (!id) return null
    order.push(question)
    return { tool: { name: 'commit_route', input: { requestId: id, goals: [{ goal: question, disposition: 'answer' }],
      actions: [{ kind: 'reply', scope: question }] } }, ...(gates.has(question) ? { waitFor: gates.get(question) } : {}) }
  })
  app.defer(() => { for (const release of aliases.values()) release(); for (const release of releases.values()) release() })
  const canonicalId = await app.ask(canonical)
  const old = app.ask(original); void old.catch(() => {})
  assert.ok(await eventually(() => order.includes(original)))
  const steers = [app.call<Promise<import('../src/shared/agent-info.ts').SteerResult>>('agent:steer', first, firstId),
    app.call<Promise<import('../src/shared/agent-info.ts').SteerResult>>('agent:steer', second, secondId)]
  for (const steer of steers) void steer.catch(() => {})
  assert.ok(await eventually(() => aliases.size === 2))
  releases.get(original)!(); await old
  for (const release of aliases.values()) release()
  for (const steer of steers) assert.deepEqual(await steer, { ok: false, reason: 'idle', delivery: 'not-sent' })
  const offset = order.length
  const one = app.call<Promise<void>>('agent:prompt', first, [], firstId)
  const replay = app.call<Promise<void>>('agent:prompt', canonical, [], [canonicalId])
  const two = app.call<Promise<void>>('agent:prompt', second, [], secondId)
  for (const pending of [one, replay, two]) void pending.catch(() => {})
  assert.ok(await eventually(() => order.includes(first)))
  const three = app.call<Promise<import('../src/shared/agent-info.ts').SteerResult>>('agent:steer', later, laterId)
  void three.catch(() => {})
  assert.deepEqual(order.slice(offset), [first], 'held first SSE cannot admit subsequent native work early')
  releases.get(first)!(); await one; await replay
  assert.ok(await eventually(() => order.includes(second)))
  assert.deepEqual(order.slice(offset), [first, canonical, second])
  releases.get(second)!(); await two
  assert.equal((await three).ok, true)
  assert.deepEqual(order.slice(offset), [first, canonical, second, later])
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    for (const id of [firstId, secondId, canonicalId, laterId]) assert.equal(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE id=?').get(id)?.n, 1)
  } finally { db.close() }
  const after = app.model.requests.length
  await assert.rejects(app.call<Promise<void>>('agent:prompt', canonical + ' 被改动', [], [canonicalId]))
  assert.equal(app.model.requests.length, after, 'canonical replay still requires the exact original text')
})

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
  assert.ok(incoming[0]?.assistant.includes(turns[0]!), JSON.stringify(incoming[0]))
  assert.equal((await app.files()).length, 0)
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

test('a real background tool loop keeps its result when the foreground appends to a daily note it read', { timeout: 45_000 }, async t => {
  const brief = '用记忆核实会议室后询问是否继续'
  const fact = '青岚项目周会使用银杏会议室'
  const update = '青岚项目周会的投屏也已测试'
  const question = '是否继续会后记录？'
  const observed: Request[] = []
  const app = await setup(t, request => {
    if (JSON.stringify(request.system).includes('整理最近完成的会话回合')) {
      const input = JSON.parse(questionOf(request.messages)) as { turns: { user: { text: string }[] }[], existing?: { markdown: string } }
      const markdown = [input.existing?.markdown, ...input.turns.flatMap(row => row.user.map(user => user.text))].filter(Boolean).join('\n')
      return { text: JSON.stringify({ status: 'write', title: '青岚项目周会', markdown }) }
    }
    const latest = questionOf(request.messages)
    const recalled = modelToolResults(request, 'memory_recall')
    if (latest !== brief && (latest || !JSON.stringify(recalled).includes(fact))) return null
    observed.push(request)
    if (!recalled.length) return { tool: { name: 'memory_recall', input: { query: '青岚项目周会 银杏会议室' } } }
    const hasQuestion = modelToolResults(request, 'ask_user_question').length
    if (!hasQuestion) return { tool: { name: 'ask_user_question', input: { questions: [
      { id: 'continue', question, options: [{ label: '继续' }], multiSelect: false },
    ] } } }
    return { text: '已保留会议室工具结果并继续记录。' }
  }, { dailyNotes: true })
  for (const text of [fact, '把议程放在开头', '预留讨论时间', '主持人负责计时', '周会记录统一归档']) await app.ask(text)
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  app.defer(() => db.close())
  const note = await eventually(() => db.prepare('SELECT key,revision FROM memory_daily_notes WHERE file_revision IS NOT NULL').get())
  assert.ok(note)
  await app.ask(`后台做：${brief}`)
  const wait = await eventually(() => app.events.find(event => event.type === 'task_question'))
  assert.ok(wait?.type === 'task_question', JSON.stringify({
    requests: (app.model.requests.slice(-15) as Request[]).map(request => [questionOf(request.messages).slice(0, 100), modelToolResults(request, 'memory_recall').length]),
    tasks: app.tasks().map(task => ({ title: task.task.title, status: task.status, messages: task.messages.map(row => row.text) })),
    errors: app.events.filter(event => event.type === 'error'),
  }))
  assert.ok(observed.some(request => JSON.stringify(modelToolResults(request, 'memory_recall')).includes(fact)))
  const offset = app.model.requests.length
  for (const text of [update, '安排一位替补主持人', '讨论超过十分钟时先记录', '下周继续复用议程']) await app.ask(text)
  assert.ok(await eventually(() => Number(db.prepare('SELECT revision FROM memory_daily_notes WHERE key=?').get(note.key)?.revision) > Number(note.revision)),
    'the foreground appended to the exact daily note the task had read')
  assert.equal(await app.call('agent:answer', wait.questionId, [{ id: 'continue', selected: ['继续'] }]), true)
  assert.ok(await eventually(() => app.model.requests.slice(offset).some(raw => {
    const request = raw as Request
    return modelToolResults(request, 'ask_user_question').length > 0
      && JSON.stringify(modelToolResults(request, 'memory_recall')).includes(fact)
  })), 'the next task request still contains the earlier tool result')
})

for (const failure of ['invalid-json', 'http-error'] as const) {
  // This scenario includes three native process launches and multiple real provider retry windows.
  test(`real foreground sends remain usable while dream ${failure} repeatedly fails and recovers across restart`, { timeout: 120_000 + DAILY_MEMORY_DEFAULTS.retryMaxMs }, async t => {
    let dreamRequests = 0
    const app = await setup(t, request => {
      const system = JSON.stringify(request.system)
      if (system.includes('整理最近完成的会话回合')) return { text: JSON.stringify({ status: 'write', title: '周报', markdown: '周报提交邮箱已记录。' }) }
      const blocks: readonly unknown[] = Array.isArray(request.system) ? request.system : [request.system]
      if (blocks.some(block => block === DREAM_CONSOLIDATE_SYSTEM
        || (typeof block === 'object' && block !== null && 'text' in block && block.text === DREAM_CONSOLIDATE_SYSTEM))) {
        dreamRequests++
        return failure === 'http-error' ? { httpError: 503 } : { text: 'not JSON' }
      }
      return null
    }, { dailyNotes: true })
    for (const text of [oldFact, '模板沿用上周', '新增客户反馈', '把进展放在开头', '周五提交']) await app.ask(text)
    const read = <T>(query: (db: DatabaseSync) => T) => {
      const db = openMemoryControlDb(join(app.directory, 'memory', 'memory.db'))
      try { return query(db) } finally { db.close() }
    }
    assert.ok(await eventually(() => read(db => db.prepare('SELECT 1 FROM memory_daily_notes WHERE file_revision IS NOT NULL').get())))
    await app.stopBackend()
    read(db => { assert.equal(db.prepare("UPDATE effects SET due_at=0 WHERE kind='memory.dream'").run().changes, 1) })
    await app.startBackend()
    // A cold native session chooses its model on its first real turn. Recall accepted evidence
    // before checking background failures, rather than counting an unavailable route as an HTTP failure.
    await app.ask('查一下 周报提交邮箱')
    assert.ok(await eventually(() => dreamRequests >= 2 && read(db => Number(db.prepare("SELECT attempts FROM effects WHERE kind='memory.dream'").get()?.attempts) >= 2), { timeoutMs: 25_000 }))
    assert.ok(dreamRequests >= 2)
    const first = '后台记忆整理失败时继续主对话'
    const offset = app.model.requests.length
    await app.ask(first)
    assert.ok(await eventually(() => app.model.requests.slice(offset).some(raw => questionOf((raw as Request).messages) === first && JSON.stringify(raw).includes(oldValue))))
    assert.ok(await app.call('memory:get'))
    await app.stopBackend()
    const attemptsBeforeRestart = dreamRequests
    read(db => { assert.equal(db.prepare("UPDATE effects SET due_at=0 WHERE kind='memory.dream'").run().changes, 1) })
    await app.startBackend()
    await app.ask('查一下 周报提交邮箱')
    // A cold attempt may run before the first foreground turn makes the model ready.
    // The restarted owner keeps its attempt count and can legitimately wait a full backoff.
    assert.ok(await eventually(() => dreamRequests > attemptsBeforeRestart, { timeoutMs: DAILY_MEMORY_DEFAULTS.retryMaxMs + 15_000 }),
      'the restarted owner must make a new provider request within its persisted retry window')
    const resumed = '恢复 dream 重试后继续主对话'
    const resumedOffset = app.model.requests.length
    await app.ask(resumed)
    assert.ok(await eventually(() => app.model.requests.slice(resumedOffset).some(raw => questionOf((raw as Request).messages) === resumed && JSON.stringify(raw).includes(oldValue))))
    assert.ok(await app.call('memory:get'))
    assert.equal(read(db => db.prepare("SELECT count(*) n FROM owner_operations WHERE state IN ('intent','preparing','prepared','host-committed')").get()?.n), 0)
  })
}

const STOP_AFTER_PTC_READ = `CREATE TRIGGER stop_after_ptc_read BEFORE INSERT ON owner_native_output_reads
  WHEN EXISTS(SELECT 1 FROM owner_native_tool_reads) BEGIN SELECT RAISE(ABORT, 'no later PTC model send'); END`

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
  const seedId = randomUUID()
  const created = await app.call<Promise<IpcResults['memory:create-file']>>('memory:create-file', { operationId: seedId, text: 'Initial draft note before PTC revision.' })
  assert.equal(created.status, 'applied', JSON.stringify(created))
  const seeded = await app.call<Promise<MemoryFileDetail>>('memory:read-file', created.receipt.identity)
  const edited = await app.call<Promise<IpcResults['memory:edit-file']>>('memory:edit-file', {
    operationId: randomUUID(), identity: created.receipt.identity, version: seeded.version, text: body,
  })
  assert.equal(edited.status, 'applied')
  fileId = created.receipt.identity.id
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
    assert.equal(app.model.requests.some(raw => JSON.stringify(modelToolResults(raw as Request, 'run_code')).includes('PTC_BODY')), !nextFails,
      JSON.stringify({ results: app.model.requests.flatMap(raw => modelToolResults(raw as Request, 'run_code')),
        tasks: app.tasks(), errors: app.events.filter(event => event.type === 'error') }))
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
      await withdrawNativeFile(owner, { identity: created.receipt.identity, seedId })
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
  const seedId = randomUUID()
  const created = await app.call<Promise<IpcResults['memory:create-file']>>('memory:create-file', { operationId: seedId, text: 'Initial draft note before prepare revision.' })
  assert.equal(created.status, 'applied', JSON.stringify(created))
  const seeded = await app.call<Promise<MemoryFileDetail>>('memory:read-file', created.receipt.identity)
  const edited = await app.call<Promise<IpcResults['memory:edit-file']>>('memory:edit-file', {
    operationId: randomUUID(), identity: created.receipt.identity, version: seeded.version, text: body,
  })
  assert.equal(edited.status, 'applied')
  id = created.receipt.identity.id
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
      await withdrawNativeFile(owner, { identity: created.receipt.identity, seedId })
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

test('a real DSH tool read archives and erases native results even when the next model send fails', { timeout: 90_000 }, async t => {
  const text = 'The file-only proof ORDINAL controls the native result.'
  const prompt = '执行单次工具归档测试'
  let fileId: string | undefined, requested = false
  const app = await setup(t, request => {
    if (requested || !fileId || questionOf(request.messages) !== prompt) return null
    requested = true
    return { tool: { name: 'memory_read', input: { id: fileId } } }
  }, { dailyNotes: true })
  const seedId = randomUUID(), editId = randomUUID()
  const created = await app.call<Promise<IpcResults['memory:create-file']>>('memory:create-file', { operationId: seedId, text: 'Initial draft note before tool revision.' })
  assert.equal(created.status, 'applied', JSON.stringify(created))
  const seeded = await app.call<Promise<MemoryFileDetail>>('memory:read-file', created.receipt.identity)
  const edited = await app.call<Promise<IpcResults['memory:edit-file']>>('memory:edit-file', {
    operationId: editId, identity: created.receipt.identity, version: seeded.version, text,
  })
  assert.equal(edited.status, 'applied')
  fileId = created.receipt.identity.id
  const file = await app.call<Promise<MemoryFileDetail>>('memory:read-file', created.receipt.identity)
  const source = file.sources.find(item => item.sourceId === editId)
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
    await withdrawNativeFile(owner, { identity: created.receipt.identity, seedId }, operationId)
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

test('cold Viva startup erases native originals and settled output in root and unseen fork logs', { timeout: 90_000 }, async t => {
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
  const savedHistory = app.call<{ id: string }>('history:load')
  assert.ok(savedHistory)
  assert.match(JSON.stringify(savedHistory), new RegExp(derived, 'u'), 'authenticated reply is persisted directly by the backend writer')
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
    } finally { store.close() }
  } finally { await owner.close() }
  for (const [excerpt, id] of [[erased, operationId], [second, nextOperation]] as const) {
    const start = text.indexOf(excerpt)
    recordPartialOriginalErasure(memoryRoot, {
      operationId: id, sourceId, spans: [{ start, end: start + excerpt.length }], extraSessions: [parentId], hostNamespace: 'viva',
    })
  }

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

  const history = app.call<{ messages: Array<{ sourceId?: string }> }>('history:load')
  const keep = history.messages.findIndex(message => message.sourceId === questionId)
  assert.ok(keep >= 0, 'the resumed-session prompt is already persisted')
  const forked = await app.call<Promise<{ ok: boolean, problem?: string, info?: AgentInfo }>>('timeline:rewind',
    { words: question, keep, text: question })
  assert.ok(forked.ok, JSON.stringify(forked))
  assert.notEqual(forked.info?.sessionId, parentId)
  const branchProbe = '验证已擦除会话的新分叉仍保留独立原文'
  const branchOffset = app.model.requests.length
  await app.ask(branchProbe)
  const branch = app.model.requests.slice(branchOffset) as Request[]
  assert.ok(branch.some(request => questionOf(request.messages) === branchProbe && JSON.stringify(request.messages).includes(survivor)))
  assert.ok(branch.every(request => ![erased, second].some(removed => JSON.stringify(request.messages).includes(removed))))
})

test('source-backed project files and exact recall remain in their Git workspace while main chat history spans the single timeline', { timeout: 90_000 }, async t => {
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
  const backgroundBrief = '在后台核对当前项目的构建标记'
  const scheduleTitle = '甲项目定时汇总'
  const listSchedules = '查看当前项目的定时任务'
  const updateSchedule = '修改指定的定时任务'
  const changedTitle = '不应写入的修改标题'
  let scheduleId: string | undefined
  const app = await step('setup', () => setup(t, request => {
    const last = request.messages.at(-1)
    const hasImage = request.messages.some(message => Array.isArray(message.content) && message.content.some((part: { type?: string }) => part.type === 'image'))
    if (hasImage && JSON.stringify(last).includes('tool_result')) return { text: rawHistoryText }
    if (JSON.stringify(last).includes('tool_result')) return null
    const question = questionOf(request.messages)
    if (question === recall) return { tool: { name: 'memory_recall', input: { query: '构建标记', scope: 'project' } } }
    if (question === history) return { tool: { name: 'search_conversations', input: { query: '构建标记' } } }
    if (question === '查甲项目的构建标记') return { tool: { name: 'search_conversations', input: { query: firstMarker } } }
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
    const summary = await step(`${label}:file-profile`, () => eventually(async () => {
      const { fileProfile } = await app.call<Promise<{ fileProfile: { project: { identity: MemoryFileDetail['identity'], text: string }[] | null } }>>('memory:get')
      return fileProfile.project?.find(item => item.text.includes(text.slice('记住：'.length)))
    }))
    assert.ok(summary)
    const detail = await step(`${label}:read-file`, () => app.call<Promise<IpcResults['memory:read-file']>>('memory:read-file', summary.identity))
    assert.ok(detail?.sources.some(source => source.link))
    return switched.info
  }
  const check = async (label: string, present: string, excluded: string, { crossProjectHistory = false } = {}) => {
    const count = app.model.requests.length
    await step(`${label}:profile-prompt`, () => app.ask('查看本项目构建标记的基本资料'))
    await step(`${label}:recall`, () => app.ask(recall))
    const beforeHistory = app.model.requests.length
    await step(`${label}:search-history`, () => app.ask(history))
    const scopedMessages = app.model.requests.slice(count, beforeHistory).map(raw => (raw as Request).messages)
    const historyMessages = app.model.requests.slice(beforeHistory).map(raw => (raw as Request).messages)
    assert.ok(scopedMessages.some(rows => {
      const last = JSON.stringify(rows.at(-1))
      return last.includes('<about-user>') && last.includes('File memory evidence') && last.includes(present)
    }))
    assert.ok(scopedMessages.some(rows =>
      modelToolResults({ messages: rows }, 'memory_recall').some(result => JSON.stringify(result).includes(present))),
    JSON.stringify({ name: 'memory_recall', results: scopedMessages.flatMap(rows => modelToolResults({ messages: rows }, 'memory_recall')) }))
    assert.ok(scopedMessages.every(rows => !JSON.stringify(rows).includes(excluded)),
      JSON.stringify({ excluded, leaked: scopedMessages.filter(rows => JSON.stringify(rows).includes(excluded)) }))
    const searchResults = historyMessages.flatMap(rows => modelToolResults({ messages: rows }, 'search_conversations'))
    assert.ok(searchResults.some(result => JSON.stringify(result).includes(present)),
      JSON.stringify({ name: 'search_conversations', results: searchResults }))
    if (crossProjectHistory) {
      const crossOffset = app.model.requests.length
      await step(`${label}:cross-project-history`, () => app.ask('查甲项目的构建标记'))
      const crossResults = (app.model.requests.slice(crossOffset) as Request[]).flatMap(request => modelToolResults(request, 'search_conversations'))
      const resultText = (result: unknown) => typeof result === 'string'
        ? result
        : Array.isArray(result)
          ? result.map(part => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('')
          : JSON.stringify(result)
      assert.ok(crossResults.some(result => {
        const text = resultText(result)
        return text.includes(excluded) && text.includes(projectA)
      }), JSON.stringify({ name: 'search_conversations', expectedCrossProject: excluded, results: crossResults }))
    } else {
      assert.ok(historyMessages.every(rows => !JSON.stringify(rows).includes(excluded)),
        JSON.stringify({ excluded, leaked: historyMessages.filter(rows => JSON.stringify(rows).includes(excluded)) }))
    }
    return beforeHistory
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
  const beforeProjectBHistory = await check('project-b', secondMarker, firstMarker, { crossProjectHistory: true })
  const restrictedOffset = app.model.requests.length
  await step('project-b:restricted-list', () => app.ask(listSchedules))
  const modelLists = (app.model.requests.slice(restrictedOffset) as Request[]).flatMap(request => modelToolResults(request, 'schedule_list'))
  assert.ok(modelLists.length)
  assert.ok(modelLists.every(result => !JSON.stringify(result).includes(scheduleId)))
  const updateOffset = app.model.requests.length
  await step('project-b:rejected-update', () => app.ask(updateSchedule))
  assert.ok((app.model.requests.slice(updateOffset) as Request[]).some(request => modelToolResults(request, 'schedule_update').length))
  assert.equal(schedules().find(item => item.id === scheduleId)?.title, scheduleTitle)
  const afterSwitchBeforeHistory = app.model.requests.slice(beforeSwitch, beforeProjectBHistory) as Request[]
  assert.ok(afterSwitchBeforeHistory.some(request => questionOf(request.messages) === secondFact && JSON.stringify(request.system).includes('个人工作助手')))
  assert.ok(afterSwitchBeforeHistory.filter(request => JSON.stringify(request.system).includes('个人工作助手')
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
  const beforeOutsideHistory = app.model.requests.length
  const outside = join(app.directory, 'workspace')
  const loose = await step('outside:switch', () => app.call<Promise<{ ok: boolean }>>('workdir:switch', outside, { confirmed: true }))
  assert.ok(loose.ok)
  await step('outside:search-history', () => app.ask('查甲项目的构建标记'))
  await step('outside:search-picture-history', () => app.ask(imageHistory))
  const beforeSearchRequests = (app.model.requests.slice(outsideOffset, beforeOutsideHistory) as Request[])
    .filter(request => JSON.stringify(request.system).includes('个人工作助手'))
  assert.ok(beforeSearchRequests.every(request => !JSON.stringify(request.messages).includes(firstMarker) && !JSON.stringify(request.messages).includes(rawHistoryText)))
  const outsideSearchResults = (app.model.requests.slice(beforeOutsideHistory) as Request[])
    .flatMap(request => modelToolResults(request, 'search_conversations'))
  assert.ok(outsideSearchResults.some(result => JSON.stringify(result).includes(firstMarker)), JSON.stringify({ outsideSearchResults }))
  assert.ok(outsideSearchResults.some(result => JSON.stringify(result).includes(rawHistoryText)), JSON.stringify({ outsideSearchResults }))
})

test('deleting a memory file preserves the original chat and the task and report that read it after restart', { timeout: 45_000 }, async t => {
  const app = await setup(t, () => null)
  const sourceId = await app.ask(oldFact)
  const file = await eventually(async () => (await app.files()).find(item => item.markdown.includes(oldValue)))
  assert.ok(file)
  const brief = '查一下 周报提交邮箱'
  await app.ask(`后台做：${brief}`)
  const task = await eventually(() => app.tasks().find(item => item.endedAt && item.task.title === brief))
  assert.ok(task)
  const history = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  app.defer(() => history.close())
  assert.ok(app.model.requests.some(request => modelToolResults(request, 'memory_recall').some(result => JSON.stringify(result).includes(oldValue))),
    'the task actually read the memory file')
  const reports = () => history.prepare('SELECT report_id,text FROM report_records WHERE report_id LIKE ?').all(`${task.task.id}:%`)
  assert.ok(await eventually(() => reports().length > 0), 'the task report reached history before deletion')
  const before = reports()
  const result = await app.call<Promise<IpcResults['memory:forget-file']>>('memory:forget-file', {
    operationId: randomUUID(), identity: file.identity, version: file.version,
  })
  assert.equal(result.status, 'applied')
  await app.stopBackend()
  await app.startBackend()
  assert.equal(await app.call('memory:read-file', file.identity), null)
  assert.equal(history.prepare('SELECT text FROM messages WHERE source_id=?').get(sourceId)?.text, oldFact)
  assert.deepEqual(reports(), before)
  const retained = app.tasks().find(item => item.task.id === task.task.id)
  const transcript = (item: Task) => item.messages?.map(({ role, text }) => ({ role, text }))
  assert.ok(retained)
  assert.deepEqual(transcript(retained), transcript(task))
  await app.ask('请继续处理本轮对话')
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

test('rewind and history deletion update the timeline without withdrawing remembered originals', { timeout: 45_000 }, async t => {
  const app = await setup(t, () => null)
  const before = app.call<AgentInfo>('agent:info')
  const original = await app.ask(oldFact)
  assert.ok(await eventually(async () => (await app.files()).some(file => file.markdown.includes(oldValue))))
  const loaded = app.call<{ messages: Array<{ sourceId?: string }> }>('history:load')
  const keep = loaded.messages.findIndex(message => message.sourceId === original)
  assert.ok(keep >= 0)
  const text = '已经在回退分支编辑这条消息'
  const edited = await app.call<Promise<{ ok: boolean, sourceId: string, info: AgentInfo }>>('timeline:rewind', { words: oldFact, keep, text })
  assert.equal(edited.ok, true)
  assert.notEqual(edited.sourceId, original)
  assert.equal(app.call<AgentInfo>('agent:info').conversationId, edited.info.conversationId)
  await app.call('agent:prompt', text, [], edited.sourceId)
  await app.newTopic()
  await app.call('history:delete', before.conversationId)
  await app.call('history:delete', edited.info.conversationId)
  assert.ok((await app.files()).some(file => file.markdown.includes(oldValue)))
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT withdrawn FROM memory_sources WHERE id=?').get(original)?.withdrawn, 0)
  } finally { db.close() }
})

test('Viva chats and runs a saved schedule with an incompatible memory database', { timeout: 45_000 }, async t => {
  const title = '每天归档测试结果'
  const scheduled = '运行测试结果归档'
  const chat = '记忆不可用时仍可以执行对话工具'
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (question === title && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) {
      return { tool: { name: 'schedule_create', input: { title, prompt: scheduled, kind: 'at', at: new Date(Date.now() + 60_000).toISOString() } } }
    }
    if (question === chat && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) {
      return { tool: { name: 'memory_recall', input: { query: chat } } }
    }
    return { text: '已完成' }
  })
  await app.schedule(title)
  await app.stopBackend()
  const history = new DatabaseSync(join(app.directory, 'app.db'))
  try {
    history.prepare("UPDATE schedules SET record=json_set(record, '$.scheduledAt', ?) WHERE status='active'").run(new Date(Date.now() - 1000).toISOString())
  } finally { history.close() }
  const file = join(app.directory, 'memory', 'memory.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA user_version=99')
  db.close()
  const before = fs.readFileSync(file)
  await app.startBackend()
  const offset = app.model.requests.length
  await app.ask(chat)
  const requests = (app.model.requests.slice(offset) as Request[]).map(request => request.messages)
  assert.ok(requests.some(messages => JSON.stringify(messages).includes(chat)
    && JSON.stringify(messages.at(-1)).includes('unavailable')), JSON.stringify(requests.map(messages => messages.slice(-2))))
  assert.ok(await eventually(() => app.feed().find(item => item.title === title)))
  assert.ok(app.model.requests.some(raw => questionOf((raw as Request).messages) === scheduled))
  assert.deepEqual(fs.readFileSync(file), before)
})

test('a late owner alias cannot write after a foreground prompt falls back', { timeout: 30_000 }, async t => {
  const operationId = randomUUID()
  const words = '这段原话应在 owner 超时后正常发送'
  let release: (() => void) | undefined
  let frameId: string | undefined
  let ownerResponse: unknown
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', function(this: ChildProcess, message: unknown, ...rest: unknown[]) {
        const frame = message as { type?: string, kind?: string, id?: string, method?: string, input?: { method?: string, input?: { sourceId?: string } } }
        if (frame?.type === 'memory_owner_rpc' && frame.kind === 'request' && frame.method === 'host'
          && frame.input?.method === 'sourceAlias' && frame.input.input?.sourceId === operationId) {
          frameId = frame.id
          release = () => { Reflect.apply(send, this, [message, ...rest]) }
          return true
        }
        return Reflect.apply(send, this, [message, ...rest]) as boolean
      })
    }
    const frame = args[0] as { type?: string, kind?: string, id?: string } | undefined
    if (event === 'message' && frameId && frame?.type === 'memory_owner_rpc' && frame.kind === 'result' && frame.id === frameId) ownerResponse = frame
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  const app = await setup(t, () => null)
  await app.files()
  await app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', words, [], operationId)
  assert.ok(release, 'the alias request was held until the prompt completed')
  assert.ok(app.model.requests.some(request => questionOf(request.messages) === words))
  release()
  assert.ok(await eventually(() => ownerResponse), 'the owner evaluated the expired request')
  assert.equal((ownerResponse as { ok?: boolean }).ok, false)
  const database = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.equal(database.prepare('SELECT 1 FROM owner_aliases WHERE source=?').get(operationId), undefined)
    assert.equal(database.prepare('SELECT 1 FROM memory_sources WHERE id=?').get(operationId), undefined)
  } finally { database.close() }
})

test('a new memory database starts after existing DSH events and resumes from a persisted cursor', { timeout: 45_000 }, async t => {
  const app = await setup(t, () => null)
  const original = await app.ask('记忆库创建以前保留在对话里的标记')
  const session = app.call<AgentInfo>('agent:info').sessionId
  assert.ok(session)
  await app.stopBackend()
  const root = join(app.directory, 'memory')
  fs.renameSync(root, join(app.directory, 'old-memory'))
  await app.startBackend()
  assert.equal(app.call<AgentInfo>('agent:info').sessionId, session)
  const first = await app.ask('新记忆库中的第一轮真人原话')
  const read = <T>(work: (db: DatabaseSync) => T) => {
    const db = new DatabaseSync(join(root, 'memory.db'), { readOnly: true })
    try { return work(db) } finally { db.close() }
  }
  const cursor = () => read(db => Number(db.prepare('SELECT next_seq FROM memory_session_cursors WHERE session=?').get(session)?.next_seq))
  const turnSaved = (seq: number) => read(db => Boolean(db.prepare('SELECT 1 FROM owner_turns WHERE session=? AND seq=?').get(session, seq - 1)))
  assert.ok(await eventually(() => turnSaved(cursor())))
  const firstCursor = cursor()
  assert.ok(firstCursor > 0)
  await app.stopBackend()
  await app.startBackend()
  assert.equal(cursor(), firstCursor)
  const second = await app.ask('owner 重连之后的第二轮真人原话')
  assert.ok(await eventually(() => cursor() > firstCursor && turnSaved(cursor())))
  const ids = read(db => db.prepare('SELECT id FROM memory_sources WHERE id IN (?,?,?)').all(original, first, second).map(row => row.id))
  assert.deepEqual(new Set(ids), new Set([first, second]))
})

// The deliberately absent owner consumes the real 30-second readiness deadline.
// The outer budget also covers preparation and both failed and recovered starts.
test('a persisted schedule and foreground requests wait for the independent memory owner', { timeout: 90_000 }, async t => {
  const began = performance.now()
  const timings: { step: string, startedMs: number, elapsedMs?: number }[] = []
  let inspect: () => unknown = () => ({ state: 'setting-up' })
  const snapshot = () => {
    try { return inspect() } catch { return { state: 'fixture-closed' } }
  }
  const cancelled = () => process.stderr.write(`[owner-readiness-cancelled] ${JSON.stringify({
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
      t.diagnostic(`[owner-readiness] ${JSON.stringify(timing)}`)
    }
  }
  const title = '给邮箱建立定时归档'
  const prompt = '归档到 ' + oldValue
  const app = await step('setup', () => setup(t, request => {
    if (questionOf(request.messages) !== title || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    return { tool: { name: 'schedule_create', input: {
      title, prompt, kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
  }))
  inspect = () => {
    const agent = app.call<AgentInfo>('agent:info')
    return {
      agent: { mode: agent.mode, cwd: agent.cwd, sessionId: agent.sessionId, conversationId: agent.conversationId, topicId: agent.topicId },
      requests: app.model.requests.length,
      recentQuestions: (app.model.requests.slice(-3) as Request[]).map(request => questionOf(request.messages)),
      events: app.events.filter(event => event.type === 'ready' || event.type === 'turn_started' || event.type === 'turn_end' || event.type === 'error').slice(-6)
        .map(event => event.type === 'ready' ? { type: event.type, mode: event.info.mode } : event),
    }
  }
  await step('remember-and-recall-source', () => app.recallOld())
  await step('persist-schedule', () => app.schedule(title))
  const manifest = join(CODE_ROOT, 'plugins', 'memory', 'package.json')
  const read = fs.readFileSync
  const invalid = JSON.parse(read(manifest, 'utf8')) as { viva: { contract: { memory: number } } }
  invalid.viva.contract.memory++
  const override = t.mock.method(fs, 'readFileSync', ((file: unknown, ...args: unknown[]) => file === manifest
    ? JSON.stringify(invalid) : Reflect.apply(read, fs, [file, ...args])) as typeof fs.readFileSync)
  const db = new DatabaseSync(join(app.directory, 'app.db'))
  try {
    db.prepare("UPDATE schedules SET record=json_set(record, '$.scheduledAt', ?) WHERE status='active'").run(new Date(Date.now() - 1000).toISOString())
    await step('restart-with-owner-rejected', () => app.restart())
  } finally {
    db.close()
    override.mock.restore()
  }
  const words = '记忆 owner 恢复前不应发出模型请求'
  const offset = app.model.requests.length
  await step('reject-foreground-without-owner', () => assert.rejects(app.ask(words)))
  assert.ok(!app.model.requests.slice(offset).some(raw => questionOf((raw as Request).messages) === words))
  assert.ok(!app.model.requests.some(raw => questionOf((raw as Request).messages) === prompt))
  await step('restart-with-owner-restored', () => app.restart())
  assert.ok(await step('recovered-schedule-result', () => eventually(() => app.feed().find(item => item.title === title))))
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
  assert.equal((await app.files()).length, 0)
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

test('task resume and scheduled execution reject a persisted file policy dependency after restart', { timeout: 45_000 }, async t => {
  const title = '替我准备周报定时汇总'
  const scheduled = '运行旧的定时汇总指令'
  const brief = '在后台生成周报提交邮箱汇总'
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
  await app.recallOld()
  const file = (await app.files()).find(item => item.markdown.includes(oldValue))
  assert.ok(file)
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    await app.newTopic()
    await app.ask(`后台做：${brief}`)
    taskId = (await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === brief)))?.task.id
    assert.ok(taskId)
    await app.schedule(title)
    const stored = db.prepare(`SELECT reference FROM memory_session_file_dependencies
      WHERE session=? AND json_extract(reference,'$.id')=?`).get(taskId, file.identity.id)
    assert.ok(stored)
    const proof = JSON.parse(String(stored.reference)) as { revision: string, usageVersion: number, policyToken: string }
    assert.equal(proof.revision, file.version.contentRevision)
    assert.equal(proof.policyToken, file.version.policyToken)
    const scheduleDb = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
    try {
      assert.ok(scheduleDb.prepare(`SELECT 1 FROM schedules s, json_each(s.memory,'$.files') dep
        WHERE json_extract(s.record,'$.title')=? AND json_extract(dep.value,'$.id')=?
          AND json_extract(dep.value,'$.revision')=? AND json_extract(dep.value,'$.policyToken')=?`)
        .get(title, file.identity.id, proof.revision, proof.policyToken))
    } finally { scheduleDb.close() }
    await app.newTopic()
    const unrelated = await app.call<Promise<IpcResults['memory:create-file']>>('memory:create-file', {
      operationId: randomUUID(), text: '我的可访问性偏好是高对比度',
    })
    assert.equal(unrelated.status, 'applied')
    const unchanged = await app.call<Promise<MemoryFileDetail>>('memory:read-file', file.identity)
    assert.deepEqual(unchanged.version, file.version, 'an unrelated file write does not change the consumed file proof')
    await app.call('memory:set-file-enabled', { operationId: randomUUID(), identity: file.identity, version: unchanged.version, enabled: false })
    const stopped = await app.call<Promise<MemoryFileDetail>>('memory:read-file', file.identity)
    assert.equal(stopped.version.contentRevision, proof.revision)
    assert.notEqual(stopped.version.usageVersion, proof.usageVersion)
    assert.notEqual(stopped.version.policyToken, proof.policyToken)
    assert.equal(db.prepare('SELECT revision FROM memory_documents WHERE id=?').get(file.identity.id)?.revision, proof.revision)
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

test('a scheduled prompt rechecks file usage policy even when no file content was rewritten', { timeout: 45_000 }, async t => {
  const title = '为这次周报设一个归档任务'
  const prompt = `定时归档这次周报到 ${oldValue}`
  const app = await setup(t, request => {
    if (questionOf(request.messages) !== title || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    return { tool: { name: 'schedule_create', input: { title, prompt, kind: 'at', at: new Date(Date.now() + 60_000).toISOString() } } }
  })
  await app.recallOld()
  const file = (await app.files()).find(item => item.markdown.includes(oldValue))
  assert.ok(file)
  await app.schedule(title)
  await app.newTopic()
  await app.call('memory:set-file-enabled', { operationId: randomUUID(), identity: file.identity, version: file.version, enabled: false })
  const stopped = await app.call<Promise<MemoryFileDetail>>('memory:read-file', file.identity)
  assert.equal(stopped.version.contentRevision, file.version.contentRevision)
  assert.notEqual(stopped.version.policyToken, file.version.policyToken)
  makeScheduleDue(app.directory)
  const offset = app.model.requests.length
  app.wake()
  assert.ok(await eventually(() => app.feed().find(item => item.title === '定时任务需要重新确认')))
  assert.ok(!(await app.files()).some(item => item.markdown.includes(oldValue)))
  assert.ok(!app.model.requests.slice(offset).some(request => JSON.stringify(request).includes(prompt)))
})

test('schedule results recheck the file evidence read during execution before publication', { timeout: 30_000 }, async t => {
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
    if (tool && JSON.stringify(request.messages).includes(prompt)) {
      const recalled = modelToolResults(request, 'memory_recall').at(-1)
      const recalledText = typeof recalled === 'string'
        ? recalled
        : Array.isArray(recalled)
          ? recalled.map(part => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('')
          : ''
      let currentHasOld = false
      if (recalledText) {
        try {
          const parsed = JSON.parse(recalledText) as { notes?: Array<{ markdown?: unknown }> }
          currentHasOld = Array.isArray(parsed.notes) && parsed.notes.some(note => typeof note.markdown === 'string' && note.markdown.includes(oldValue))
        } catch { /* ignore non-JSON tool results */ }
      }
      if (currentHasOld) {
        responding = true
        return { text: draft, delayMs: 3000 }
      }
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
  assert.ok(app.model.requests.some(request => questionOf(request.messages) === prompt && JSON.stringify(request).includes('【记忆规则】')),
    'a verified unattended prompt receives automatic memory context')
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
  try {
    assert.equal(memoryDb.prepare('SELECT id FROM memory_sources WHERE id=? OR text IN (?,?)').get(operation, prompt, draft), undefined)
  }
  finally { memoryDb.close() }
  await app.replace()
  assert.equal(await app.call('feed:continue', item.id), text)
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
  }, { dailyNotes: true })
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

test('removing the last model from an unconfirmed stop enters setup without retaining the retired session', { timeout: 40_000 }, async t => {
  let waiting = false, release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const app = await setup(t, request => {
    if (questionOf(request.messages) !== 'hold for setup') return null
    waiting = true
    return { text: 'obsolete output', waitFor: hold }
  })
  const pending = app.ask('hold for setup').catch(() => {})
  app.defer(release)
  assert.ok(await eventually(() => waiting))
  const pid = app.agentPid()
  assert.ok(pid)
  const paused = await pauseOwnedProcess(pid)
  app.defer(() => paused.resume())
  assert.equal(await cancelCurrent(app), true)
  const snapshot = () => app.call<IpcResults['agent:snapshot']>('agent:snapshot')
  assert.ok(await eventually(() => snapshot().stopUnconfirmed, { timeoutMs: 12_000 }))
  await paused.resume()
  release()
  await pending
  const providers = app.call<{ providers: { id: string }[] }>('models:get').providers
  assert.equal(providers.length, 1)
  await app.call('models:remove', providers[0]!.id)
  assert.equal(snapshot().info.mode, 'setup')
  assert.equal(snapshot().stopUnconfirmed, false)
  await app.call('settings:clear-key')
  assert.equal(snapshot().activeTurn, null)
})

test('main session oversees background tasks across git repos while background tasks stay isolated', { timeout: 90_000 }, async t => {
  let taskAId = '', repoA = '', repoB = ''
  let releaseTaskA!: () => void
  const holdTaskA = new Promise<void>(resolve => { releaseTaskA = resolve })
  let releaseHoldStop!: () => void
  const holdStop = new Promise<void>(resolve => { releaseHoldStop = resolve })
  const briefA = '在甲仓库盘点接口清单'
  const outputA1 = '甲仓库盘点完成：共 12 个接口'
  const followUpText = '把这 12 个接口按模块分组'
  const outputA2 = '甲仓库分组完成：3 个模块'
  const holdFollowUpText = '再做一轮深度静态扫描'
  const briefB = '在乙仓库核对自检边界'
  const firstRequestIdOf = (messages: Request['messages']) => [...JSON.stringify(messages).matchAll(/【请求 ID：([A-Za-z0-9-]{1,64})】/g)].at(-1)?.[1]
  const app = await setup(t, request => {
    const last = request.messages.at(-1)
    const lastJson = JSON.stringify(last)
    const question = questionOf(request.messages)
    if (question === holdFollowUpText) return { text: '不会完成的扫描', waitFor: holdStop }
    if (question === followUpText) return { text: outputA2 }
    if (question === briefA) return { text: outputA1, waitFor: holdTaskA }
    if (JSON.stringify(request.messages[0]).includes(briefB)) {
      const historyJson = JSON.stringify(request.messages)
      if (!historyJson.includes('list_background_tasks')) return { tool: { name: 'list_background_tasks', input: {} } }
      if (!historyJson.includes('search_conversations')) return { tool: { name: 'search_conversations', input: { query: '盘点接口' } } }
      return { text: '乙仓库自检完成' }
    }
    if (lastJson.includes('tool_result')) return null
    if (question === '查看全部后台任务') return { tool: { name: 'list_background_tasks', input: {} } }
    if (question === '按乙仓库过滤后台任务') return { tool: { name: 'list_background_tasks', input: { cwd: repoB } } }
    if (question === '按甲仓库过滤后台任务') return { tool: { name: 'list_background_tasks', input: { cwd: repoA } } }
    if (question === '读取甲仓库任务详情' && taskAId) return { tool: { name: 'get_background_task', input: { taskId: taskAId, includeRequest: true, includeOutput: true } } }
    if (question === '给甲仓库任务接着派活' && taskAId) return { tool: { name: 'message_background_task', input: { taskId: taskAId, text: followUpText } } }
    if (question === '让甲仓库任务开始深度扫描' && taskAId) return { tool: { name: 'message_background_task', input: { taskId: taskAId, text: holdFollowUpText } } }
    if (question === '停掉甲仓库任务' && taskAId) {
      const requestId = firstRequestIdOf(request.messages)
      if (requestId) return { tool: { name: 'commit_route', input: { requestId, notice: '已停掉甲仓库任务',
        goals: [{ goal: '停掉甲仓库任务', disposition: 'stop_task' }], actions: [{ kind: 'stop', taskId: taskAId }] } } }
    }
    return null
  })
  app.defer(releaseTaskA)
  app.defer(releaseHoldStop)
  const makeRepo = (name: string) => {
    const dir = join(app.directory, name)
    mkdirSync(join(dir, '.git', 'objects'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return dir
  }
  repoA = makeRepo('overseer-a')
  repoB = makeRepo('overseer-b')

  assert.equal((await app.call<Promise<{ ok: boolean }>>('workdir:switch', repoA, { confirmed: true })).ok, true)
  await app.ask(`后台做：${briefA}`)
  const startedA = await eventually(() => app.tasks().find(task => task.task.title === briefA))
  assert.ok(startedA)
  taskAId = startedA.task.id

  // Switch across .git repos while taskA is still running in repoA.
  const switchedB = await app.call<Promise<{ ok: boolean, info: AgentInfo }>>('workdir:switch', repoB, { confirmed: true })
  assert.equal(switchedB.ok, true)
  const sessionBId = switchedB.info.sessionId
  assert.ok(sessionBId)

  const listAllOffset = app.model.requests.length
  await app.ask('查看全部后台任务')
  const listAllResults = (app.model.requests.slice(listAllOffset) as Request[]).flatMap(request => modelToolResults(request, 'list_background_tasks'))
  assert.ok(listAllResults.some(result => {
    try {
      const parsed = JSON.parse(String(result)) as { tasks?: Array<{ taskId?: string, cwd?: string }> }
      return Array.isArray(parsed.tasks) && parsed.tasks.some(task => task.taskId === taskAId && task.cwd === repoA)
    } catch { return false }
  }), JSON.stringify({ listAllResults }))

  const filterBOffset = app.model.requests.length
  await app.ask('按乙仓库过滤后台任务')
  const filterBResults = (app.model.requests.slice(filterBOffset) as Request[]).flatMap(request => modelToolResults(request, 'list_background_tasks'))
  assert.equal(JSON.parse(String(filterBResults.at(-1))).total, 0, JSON.stringify({ filterBResults }))

  const filterAOffset = app.model.requests.length
  await app.ask('按甲仓库过滤后台任务')
  const filterAResults = (app.model.requests.slice(filterAOffset) as Request[]).flatMap(request => modelToolResults(request, 'list_background_tasks'))
  assert.ok(JSON.stringify(filterAResults.at(-1)).includes(taskAId), JSON.stringify({ filterAResults }))

  // Finish taskA after switching to repoB; its report must reach repoB's main session without stalling.
  const report1Offset = app.model.requests.length
  releaseTaskA()
  assert.ok(await eventually(() => app.tasks().some(task => task.task.id === taskAId && task.endedAt)))
  assert.ok(await eventually(() => (app.model.requests.slice(report1Offset) as Request[]).some(request => JSON.stringify(request.messages).includes(outputA1))),
    'taskA report must be delivered to repoB main session')

  // Inspect taskA details from repoB.
  const getOffset = app.model.requests.length
  await app.ask('读取甲仓库任务详情')
  const getResults = (app.model.requests.slice(getOffset) as Request[]).flatMap(request => modelToolResults(request, 'get_background_task'))
  assert.ok(getResults.some(result => {
    try {
      const parsed = JSON.parse(String(result)) as { task?: { cwd?: string, resultPreview?: string } }
      return parsed.task?.cwd === repoA && String(result).includes(outputA1)
    } catch { return false }
  }), JSON.stringify({ getResults }))

  // Message taskA from repoB and verify its updated report arrives back in repoB.
  const report2Offset = app.model.requests.length
  await app.ask('给甲仓库任务接着派活')
  assert.ok(await eventually(() => (app.model.requests.slice(report2Offset) as Request[]).some(request => JSON.stringify(request.messages).includes(outputA2))),
    'follow-up report from cross-repo messaged taskA must arrive in repoB')

  // Main session in repoB must stay alive without being forcibly reopened by cross-repo provenance.
  assert.equal(app.call<AgentInfo>('agent:info').sessionId, sessionBId)

  // Start a fresh taskB in repoB after receiving cross-repo reports; taskB stays isolated from repoA's tasks and history.
  const taskBOffset = app.model.requests.length
  await app.ask(`后台做：${briefB}`)
  const taskB = await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === briefB))
  assert.ok(taskB)
  assert.equal(app.call<AgentInfo>('agent:info').sessionId, sessionBId)
  const taskBRequests = (app.model.requests.slice(taskBOffset) as Request[]).filter(request => JSON.stringify(request.messages[0]).includes(briefB))
  const taskBListResults = taskBRequests.flatMap(request => modelToolResults(request, 'list_background_tasks'))
  assert.ok(taskBListResults.some(result => JSON.stringify(result).includes(taskB.task.id)), JSON.stringify({ taskBId: taskB.task.id, taskBListResults, taskBRequests }))
  assert.ok(taskBListResults.every(result => !JSON.stringify(result).includes(taskAId)), 'background task cannot see other tasks')
  const taskBHistoryResults = taskBRequests.flatMap(request => modelToolResults(request, 'search_conversations'))
  assert.ok(taskBHistoryResults.length > 0 && taskBHistoryResults.every(result => !JSON.stringify(result).includes(briefA)),
    'background task cannot read cross-project history')

  // Stop a running repoA task from repoB.
  await app.ask('让甲仓库任务开始深度扫描')
  assert.ok(await eventually(() => app.tasks().some(task => task.task.id === taskAId && task.status === 'running')))
  await app.ask('停掉甲仓库任务')
  assert.ok(await eventually(() => app.tasks().some(task => task.task.id === taskAId && task.status === 'stopped')))
  releaseHoldStop()

  // Switching to a nested directory within the same Git repo after cross-project reads/reports must fork cleanly.
  const nestedB = join(repoB, 'nested')
  mkdirSync(nestedB)
  const beforeNested = app.call<AgentInfo>('agent:info')
  const forkedB = await app.call<Promise<{ ok: boolean, info: AgentInfo }>>('workdir:switch', nestedB, { confirmed: true })
  assert.equal(forkedB.ok, true)
  assert.equal(forkedB.info.topicId, beforeNested.topicId)
  assert.notEqual(forkedB.info.sessionId, beforeNested.sessionId)
  const nestedGetOffset = app.model.requests.length
  await app.ask('读取甲仓库任务详情')
  const nestedGetResults = (app.model.requests.slice(nestedGetOffset) as Request[]).flatMap(request => modelToolResults(request, 'get_background_task'))
  assert.ok(nestedGetResults.some(result => {
    try {
      const parsed = JSON.parse(String(result)) as { task?: { cwd?: string } }
      return parsed.task?.cwd === repoA
    } catch { return false }
  }), JSON.stringify({ nestedGetResults }))
})
