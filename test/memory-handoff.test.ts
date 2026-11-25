import { ownerRpcFrame } from '../src/memory/contracts/owner-rpc.ts'
import { objectOf } from '../src/shared/unknown-value.ts'
import { pauseOwnedProcess } from './fixtures/diagnostics-process-pause.ts'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
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
import type { MemoryFileDetail, MemoryFileListResult } from '../src/memory/contracts/file-management.ts'
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

async function setup(t: TestContext, decide: (request: Request) => object | null, { image = false, dailyNotes = false, onEvent = (_event: HostEvent) => {} } = {}) {
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
  assert.ok(await eventually(() => backend?.memoryOwnerPid() !== null))
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
        if (!item.enabled) continue
        const detail = await call<Promise<MemoryFileDetail | null>>('memory:read-file', item.identity)
        if (detail) result.push(detail)
      }
      cursor = page.nextCursor
    } while (cursor)
    return result
  }
  const restart = async () => {
    await call<Promise<unknown>>('settings:set-permission', 'workspace-write')
    assert.ok(await eventually(() => backend?.memoryOwnerPid() !== null))
  }
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
    wake: () => backend?.signal({ kind: 'system.woke' }), agentPid: () => backend?.agentPid(), memoryOwnerPid: () => backend?.memoryOwnerPid() ?? null }
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
  let image: { id: string } | undefined
  let release = () => {}, nativeHeld = false
  const gate = new Promise<void>(resolve => { release = resolve })
  app = await setup(t, request => {
    if (!nativeHeld && questionOf(request.messages).startsWith('【后台任务结束】')) {
      nativeHeld = true; return { text: '尚未返回的真实报告', waitFor: gate }
    }
    return null
  }, { image: true, onEvent(event) {
    if (!app || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    assert.ok(image)
    incoming = app.call<Promise<unknown>>('agent:prompt', question, [image], operation)
    void incoming.catch(() => {})
  } })
  app.defer(release)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII='
  image = app.call('images:keep', Buffer.from(png, 'base64'))
  await app.ask('后台做：验证取消仍然发生')
  assert.ok(await eventually(() => nativeHeld))
  const rejected = assert.rejects(incoming!, /Synthetic retirement receipt failure/)
  const offset = app.events.length
  const cancelling = cancelCurrent(app)
  await cancelling; release(); await rejected
  assert.ok(await eventually(() => app!.events.slice(offset).some(event => event.type === 'turn_end' && event.stopReason === 'cancelled')))
  assert.ok(app.model.requests.every(request => !JSON.stringify(request).includes(question)))
})

test('first idle deliveries and canonical replay retain FIFO ahead of a later steer', { timeout: 90_000 }, async t => {
  const original = '正在结束的原会话', first = '原插话第一条', second = '原插话第二条', later = '后来到达的第三条'
  const canonical = '已被原生会话接收的独立原文'
  const firstId = randomUUID(), secondId = randomUUID(), laterId = randomUUID()
  const releases = new Map<string, () => void>(), gates = new Map<string, Promise<void>>()
  for (const words of [original, first, second]) gates.set(words, new Promise<void>(resolve => { releases.set(words, resolve) }))
  const order: string[] = []
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
  app.defer(() => { for (const release of releases.values()) release() })
  const canonicalId = await app.ask(canonical)
  const old = app.ask(original); void old.catch(() => {})
  assert.ok(await eventually(() => order.includes(original)))
  releases.get(original)!(); await old
  for (const [text, id] of [[first, firstId], [second, secondId]]) {
    const result = await app.call<Promise<import('../src/shared/agent-info.ts').SteerResult>>('agent:steer', text, id)
    assert.deepEqual(result, { ok: false, reason: 'idle', delivery: 'not-sent' })
  }
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

test('Viva writes and recalls global daily notes across broken, valid and absent Git markers', { timeout: 45_000 }, async t => {
  const unknownMarker = '暂未核实的项目使用雪松清单'
  const personalMarker = '我个人每周整理蓝色笔记'
  const app = await setup(t, request => {
    if (JSON.stringify(request.system).includes('整理最近完成的会话回合')) {
      const input = JSON.parse(questionOf(request.messages)) as { turns: { user: { text: string }[] }[] }
      return { text: JSON.stringify({ status: 'write', title: '测试日记', markdown: input.turns.flatMap(row => row.user.map(user => user.text)).join('\n') }) }
    }
    const question = questionOf(request.messages)
    if (question === '从记忆查找雪松清单' && !modelToolResults(request, 'memory_recall').length) {
      return { tool: { name: 'memory_recall', input: { query: '雪松清单' } } }
    }
    return null
  }, { dailyNotes: true })
  const select = async (folder: string) => {
    const moved = await app.call<Promise<{ ok: boolean }>>('workdir:switch', folder, { confirmed: true })
    assert.equal(moved.ok, true)
    await app.newTopic()
  }
  const unknown = join(app.directory, 'unknown')
  mkdirSync(unknown)
  writeFileSync(join(unknown, '.git'), 'gitdir: missing-worktree\n')
  await select(unknown)
  for (const count of [1, 2, 3, 4, 5]) await app.ask(`${unknownMarker}，第 ${count} 次`)
  const captured = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.ok(await eventually(() => captured.prepare('SELECT 1 FROM memory_daily_notes WHERE file_revision IS NOT NULL').get()),
      'the daily note reaches disk before the test restarts the backend')
  } finally { captured.close() }
  await app.stopBackend()
  await app.startBackend()

  const verified = join(app.directory, 'verified')
  mkdirSync(join(verified, '.git', 'objects'), { recursive: true })
  writeFileSync(join(verified, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await select(verified)
  const offset = app.model.requests.length
  await app.ask('从记忆查找雪松清单')
  const requests = app.model.requests.slice(offset) as Request[]
  assert.ok(requests.some(request => modelToolResults(request, 'memory_recall').length > 0))
  assert.ok(requests.some(request => JSON.stringify(modelToolResults(request, 'memory_recall')).includes(unknownMarker)))

  await select(join(app.directory, 'workspace'))
  for (const count of [1, 2, 3, 4, 5]) await app.ask(`${personalMarker}，第 ${count} 次`)
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.ok(await eventually(() => db.prepare('SELECT path FROM memory_daily_notes WHERE file_revision IS NOT NULL').get()))
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE text LIKE ? AND project IS NULL').get(`%${unknownMarker}%`)?.n, 5)
    assert.ok(await eventually(() => db.prepare('SELECT count(*) AS n FROM memory_sources WHERE text LIKE ? AND project IS NULL').get(`%${personalMarker}%`)?.n === 5))
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

test('global memory crosses work folders while native session and schedule boundaries still follow Git', { timeout: 90_000 }, async t => {
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
    if (question === recall) return { tool: { name: 'memory_recall', input: { query: '构建标记' } } }
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
    const saved = await step(`${label}:saved-file`, () => eventually(async () => {
      const files = await app.files()
      return files.find(item => item.markdown.includes(text.slice('记住：'.length)))
    }))
    assert.ok(saved)
    const detail = await step(`${label}:read-file`, () => app.call<Promise<IpcResults['memory:read-file']>>('memory:read-file', saved.identity))
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
    const trailingUsers = (rows: Request['messages']) => {
      let start = rows.length
      while (start > 0 && rows[start - 1]?.role === 'user') start -= 1
      return JSON.stringify(rows.slice(start))
    }
    assert.ok(scopedMessages.some(rows => {
      const last = trailingUsers(rows)
      return last.includes('<memory-recall') && last.includes('File memory evidence') && last.includes(present)
    }), JSON.stringify({ label, present, tails: scopedMessages.map(rows => rows.slice(-2)) }))
    assert.ok(scopedMessages.some(rows =>
      modelToolResults({ messages: rows }, 'memory_recall').some(result => JSON.stringify(result).includes(present))),
    JSON.stringify({ name: 'memory_recall', results: scopedMessages.flatMap(rows => modelToolResults({ messages: rows }, 'memory_recall')) }))
    if (crossProjectHistory) {
      assert.ok(scopedMessages.some(rows => modelToolResults({ messages: rows }, 'memory_recall').some(result => JSON.stringify(result).includes(excluded))))
    }
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
  assert.ok(afterSwitchBeforeHistory.some(request => {
    let start = request.messages.length
    while (start > 0 && request.messages[start - 1]?.role === 'user') start -= 1
    const last = JSON.stringify(request.messages.slice(start))
    return last.includes('<memory-recall') && last.includes('File memory evidence') && last.includes(firstMarker)
  }), 'memory from the other folder is automatically available')

  // A picture-only conversation still has a native history boundary.
  assert.ok(sessionA.conversationId)
  const resumedA = await step('project-a:resume-topic', () => app.call<Promise<{ ok: boolean, info: AgentInfo }>>('history:resume-topic', sessionA.conversationId))
  assert.ok(resumedA.ok)
  const pictureTopic = await step('project-a:picture-topic', () => app.newTopic())
  const pictureSession = pictureTopic.sessionId
  assert.ok(pictureSession)
  const sourceId = randomUUID()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = app.call<{ id: string }>('images:keep', Buffer.from(png, 'base64'))
  assert.ok(image)
  await step('project-a:picture-prompt', () => app.call('agent:prompt', '', [image], sourceId))
  assert.ok(app.model.requests.some(raw => JSON.stringify(raw).includes(png)))
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    assert.ok(await eventually(() => db.prepare('SELECT 1 FROM owner_sessions WHERE session=? AND project IS NULL').get(pictureSession)))
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
  assert.ok(beforeSearchRequests.every(request => !JSON.stringify(request.messages).includes(rawHistoryText)))
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
  assert.ok(await eventually(() => app.memoryOwnerPid() !== null))
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
  assert.ok((await app.files()).some(item => item.markdown.includes(oldValue)), 'a natural remembered original belongs to the managed memory files')
  await app.newTopic()
  const offset = app.model.requests.length
  await app.ask('核对下周报提交邮箱背景资料')
  assert.ok((app.model.requests.slice(offset) as Request[]).some(request =>
    JSON.stringify(request.messages).includes('memory-recall')
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
    assert.equal(typeof db.prepare('SELECT text FROM memory_sources WHERE id=?').get(original)?.text, 'string')
  } finally { db.close() }
})

test('Viva chats, reports background results and runs schedules with an incompatible memory database', { timeout: 45_000 }, async t => {
  const title = '每天归档测试结果'
  const scheduled = '运行测试结果归档'
  const taskBrief = '验收独立后台任务'
  const report = '离线时的任务已经核对完毕'
  const chat = '记忆不可用时仍可以执行对话工具'
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    if (question === title && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) {
      return { tool: { name: 'schedule_create', input: { title, prompt: scheduled, kind: 'at', at: new Date(Date.now() + 60_000).toISOString() } } }
    }
    if (question === chat && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) {
      return { tool: { name: 'memory_recall', input: { query: chat } } }
    }
    if (question === taskBrief) return { text: report }
    if (question === scheduled) return { text: '已完成' }
    return null
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
  const taskOffset = app.model.requests.length
  await app.ask(`后台做：${taskBrief}`)
  assert.ok(await eventually(() => app.tasks().some(task => task.endedAt && task.task.title === taskBrief)), JSON.stringify({
    questions: app.model.requests.slice(taskOffset).map(raw => questionOf((raw as Request).messages)),
    tasks: app.tasks(), errors: app.events.filter(event => event.type === 'error').slice(-4),
  }))
  assert.ok(await eventually(() => app.model.requests.slice(taskOffset).some(raw => {
    const input = questionOf((raw as Request).messages)
    return input.startsWith('【后台任务结束】') && input.includes(report)
  })))
  assert.ok(await eventually(() => app.feed().find(item => item.title === title)))
  assert.ok(app.model.requests.some(raw => questionOf((raw as Request).messages) === scheduled))
  assert.deepEqual(fs.readFileSync(file), before)
})

for (const hold of ['request', 'receipt'] as const) test(`memory alias ${hold} never holds a foreground prompt`, { timeout: 30_000 }, async t => {
  const operationId = randomUUID()
  const words = '这段真人原话无需等待记忆回执'
  let release: (() => void) | undefined
  let requestId: string | undefined
  let cancelled = false
  let dispatchedBeforeTimeout = false
  let ownerResponse: { ok?: boolean } | undefined
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', function(this: ChildProcess, message: unknown, ...rest: unknown[]) {
        const frame = message as { type?: string, requestId?: string, method?: string, input?: { sourceId?: string } }
        if (frame?.type === 'memory_host_request' && frame.method === 'sourceAlias' && frame.input?.sourceId === operationId) {
          requestId = frame.requestId
          if (hold === 'request') {
            release = () => { Reflect.apply(send, this, [message, ...rest]) }
            return true
          }
        }
        if (frame?.type === 'routing_bind' && requestId && !cancelled) dispatchedBeforeTimeout = true
        if (frame?.type === 'memory_host_cancel' && frame.requestId === requestId) cancelled = true
        return Reflect.apply(send, this, [message, ...rest]) as boolean
      })
    }
    const frame = args[0] as { type?: string, requestId?: string, ok?: boolean } | undefined
    if (event === 'message' && requestId && frame?.type === 'memory_host_result' && frame.requestId === requestId) {
      ownerResponse = frame
      if (hold === 'receipt') {
        release = () => { Reflect.apply(emit, this, [event, ...args]) }
        return true
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  const app = await setup(t, () => null)
  await app.files()
  await app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', words, [], operationId)
  assert.ok(release, 'the alias frame or its receipt stayed held until the prompt completed')
  assert.ok(dispatchedBeforeTimeout, 'the host dispatched DSH while the alias was still pending')
  assert.ok(app.model.requests.some(request => questionOf(request.messages) === words))
  assert.ok(await eventually(() => cancelled), 'the owner receipt deadline elapsed while the conversation proceeded')
  release()
  assert.ok(await eventually(() => ownerResponse))
  assert.equal(ownerResponse?.ok, hold === 'receipt')
  const database = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    const remembered = database.prepare('SELECT text FROM memory_sources WHERE id=?').get(operationId)
    assert.equal(remembered?.text, hold === 'receipt' ? words : undefined)
    assert.equal(database.prepare('SELECT 1 FROM owner_aliases WHERE source=?').get(operationId), undefined)
  } finally { database.close() }
})

test('DSH restarts cleanly with a replacement memory worker while continuing chat', { timeout: 45_000 }, async t => {
  const app = await setup(t, () => null)
  const firstOwner = app.memoryOwnerPid()
  assert.ok(firstOwner)
  await app.ask('重启前的对话')
  await app.restart()
  assert.ok(await eventually(() => app.memoryOwnerPid() !== null && app.memoryOwnerPid() !== firstOwner))
  const words = '重启后继续聊天'
  await app.ask(words)
  assert.ok(app.model.requests.some(request => questionOf(request.messages) === words))
})

test('owner replacement finishes an in-flight trusted original once from the persisted DSH turn', { timeout: 45_000 }, async t => {
  const words = '记忆进程退出期间完成的真人原话'
  let started = false, release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const app = await setup(t, request => {
    if (questionOf(request.messages) !== words) return null
    started = true
    return { text: '已确认', waitFor: hold }
  })
  app.defer(release)
  await app.files()
  const original = randomUUID()
  const sending = app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', words, [], original)
  assert.ok(await eventually(() => started))
  const firstPid = app.memoryOwnerPid()
  assert.ok(firstPid)
  const memory = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  app.defer(() => memory.close())
  const registered = () => memory.prepare('SELECT 1 FROM owner_aliases WHERE source=? UNION ALL SELECT 1 FROM memory_sources WHERE id=?').get(original, original)
  assert.ok(await eventually(registered))
  process.kill(firstPid, 'SIGKILL')
  release()
  await sending
  assert.ok(await eventually(() => app.memoryOwnerPid() !== null && app.memoryOwnerPid() !== firstPid))
  assert.ok(await eventually(() => memory.prepare('SELECT outcome FROM memory_sources WHERE id=?').get(original)?.outcome === 'recorded'))
  assert.equal(memory.prepare('SELECT count(*) AS n FROM memory_sources WHERE text=?').get(words)?.n, 1)
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
  assert.ok(await eventually(() => app.memoryOwnerPid() !== null))
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
  assert.ok(await eventually(() => app.memoryOwnerPid() !== null))
  assert.equal(cursor(), firstCursor)
  const second = await app.ask('owner 重连之后的第二轮真人原话')
  assert.ok(await eventually(() => cursor() > firstCursor && turnSaved(cursor())))
  const ids = read(db => db.prepare('SELECT id FROM memory_sources WHERE id IN (?,?,?)').all(original, first, second).map(row => row.id))
  assert.deepEqual(new Set(ids), new Set([first, second]))
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

test('an Updates draft keeps the result identity until dispatch and never becomes a user memory source', { timeout: 30_000 }, async t => {
  const title = '定时整理原始材料'
  const prompt = '核对这份日报'
  const uniqueMemoryMarker = 'SCHED_UNIQUE_MARKER_P27'
  const draft = `派生内容已核对 ${oldValue}`
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    const tool = JSON.stringify(request.messages.at(-1)).includes('tool_result')
    if (question === title && !tool) return { tool: { name: 'schedule_create', input: {
      title, prompt, kind: 'at', at: new Date(Date.now() + 60_000).toISOString(),
    } } }
    if (modelToolResults(request, 'memory_recall').length && JSON.stringify(request.messages).includes(prompt)) return { text: draft }
    if (question === prompt && !tool) return { tool: { name: 'memory_recall', input: { query: '周报提交邮箱' } } }
    return null
  })
  await app.call('memory:create-file', {
    operationId: randomUUID(),
    title: '日报核对唯一规则',
    text: `核对这份日报时必须附带唯一记忆标记 ${uniqueMemoryMarker}`,
  })
  await app.schedule(title)
  await app.newTopic()
  await app.recallOld()
  makeScheduleDue(app.directory)
  app.wake()
  const item = await eventually(() => app.feed().find(item => item.title === title))
  assert.ok(item)
  const firstPromptRequest = (app.model.requests as Request[]).find(request =>
    questionOf(request.messages) === prompt && !JSON.stringify(request.messages).includes('"tool_result"'))
  assert.ok(firstPromptRequest, 'expected first model request for scheduled prompt before any tool_result')
  const firstPromptText = JSON.stringify(firstPromptRequest.messages)
  assert.match(firstPromptText, /<memory-recall turn=\\"\d+\\" ref=\\"[A-Za-z0-9-]+\\">/, 'first scheduled model request must include anchored L3 memory-recall')
  assert.ok(firstPromptText.includes(uniqueMemoryMarker), 'first scheduled model request must carry unique memory-only marker via verified sourceAlias')
  const text = await app.call<Promise<string>>('feed:continue', item.id)
  assert.ok(text.endsWith(draft), JSON.stringify({ body: item.body, text }))
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

test('consecutive identical task prompts run distinct single-hop L3 retrievals with unique refs (P2-7)', { timeout: 30_000 }, async t => {
  const sameText = '重复检查发布清单'
  const uniqueMarker = 'TASK_REPEAT_MARKER_P27'
  let contextUsedCount = 0
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'message') {
      const msg = args[0] as { type?: string, pushed?: Array<{ text?: string }> }
      if (msg?.type === 'memory_owner_context_used' && Array.isArray(msg.pushed)
        && msg.pushed.some(hit => typeof hit.text === 'string' && hit.text.includes(uniqueMarker))) {
        contextUsedCount++
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  let taskIdToMessage: string | undefined
  const app = await setup(t, request => {
    const question = questionOf(request.messages)
    const tool = JSON.stringify(request.messages.at(-1)).includes('tool_result')
    if (question === '启动重复任务' && !tool) {
      return { tool: { name: 'start_background_task', input: { title: '重复任务', brief: sameText } } }
    }
    if (question === '再次发送相同任务' && !tool && taskIdToMessage) {
      return { tool: { name: 'message_background_task', input: { taskId: taskIdToMessage, text: sameText } } }
    }
    if (question === sameText) return { text: '已核对发布清单' }
    return null
  })
  await app.call('memory:create-file', {
    operationId: randomUUID(),
    title: '发布清单规范',
    text: `重复检查发布清单时务必核对 ${uniqueMarker}`,
  })
  await app.ask('启动重复任务')
  const firstDone = await eventually(() => app.tasks().find(task => task.endedAt && task.task.title === '重复任务'), { timeoutMs: 8_000 })
  assert.ok(firstDone)
  taskIdToMessage = firstDone.task.id
  const beforeSecondEnd = firstDone.endedAt
  await app.ask('再次发送相同任务')
  assert.ok(await eventually(() => {
    const task = app.tasks().find(row => row.task.id === taskIdToMessage)
    return Boolean(task && task.endedAt && task.endedAt !== beforeSecondEnd)
  }, { timeoutMs: 8_000 }))

  const taskRequests = (app.model.requests as Request[]).filter(request =>
    questionOf(request.messages) === sameText && !JSON.stringify(request.messages).includes('"tool_result"'))
  assert.equal(taskRequests.length, 2, 'expected two distinct first-step task requests for the two identical deliveries')
  const refs = taskRequests.map((request, idx) => {
    const raw = JSON.stringify(request.messages)
    const matches = [...raw.matchAll(/<memory-recall turn=\\"(\d+)\\" ref=\\"([A-Za-z0-9-]+)\\">/g)]
    assert.equal(matches.length, idx + 1, `request ${idx + 1} should retain prior turns and append its own L3 recall`)
    const currentRef = matches.at(-1)![2]!
    const currentRecallMsg = request.messages.find(msg => JSON.stringify(msg.content).includes(`ref=\\"${currentRef}\\"`) || JSON.stringify(msg.content).includes(`ref="${currentRef}"`))
    assert.ok(currentRecallMsg, `expected dedicated L3 message for ref ${currentRef}`)
    const currentRecallText = JSON.stringify(currentRecallMsg.content)
    assert.ok(currentRecallText.includes(uniqueMarker), `delivery ${idx + 1} L3 message itself (ref=${currentRef}) must contain unique memory marker`)
    return currentRef
  })
  assert.notEqual(refs[0], refs[1], 'consecutive identical task deliveries must carry distinct requestId refs')
  assert.ok(await eventually(() => contextUsedCount === 2, { timeoutMs: 5_000 }), `expected 2 context_used notices with ${uniqueMarker}, got ${contextUsedCount}`)
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

test('a generated task brief stays derived while the answer keeps its task scope and history identity', { timeout: 30_000 }, async t => {
  let answerRequest: string | undefined
  let withheldReceipt = false
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', function(this: ChildProcess, raw: unknown, ...rest: unknown[]) {
        const frame = objectOf(raw)
        if (frame?.type === 'memory_host_request' && frame.method === 'acceptQuestionAnswer' && typeof frame.requestId === 'string') {
          answerRequest = frame.requestId
        }
        return Reflect.apply(send, this, [raw, ...rest]) as boolean
      })
    }
    const frame = event === 'message' ? objectOf(args[0]) : null
    if (frame?.type === 'memory_host_result' && frame.requestId === answerRequest && frame.ok === true) {
      withheldReceipt = true
      return true
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
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
    assert.ok(await eventually(() => memory.prepare("SELECT 1 FROM owner_messages WHERE kind='derived' AND session=?").get(event.taskId)))
    assert.equal(memory.prepare("SELECT 1 FROM memory_sources WHERE author='user' AND session=? AND text=?").get(event.taskId, brief), undefined)
    const source = await eventually(() => memory.prepare("SELECT id,conversation,context FROM memory_sources WHERE author='answer' AND hash=?").get(memoryHash(answer)))
    assert.ok(source, 'The canonical answer identity survives automatic source compaction')
    assert.ok(withheldReceipt, 'the task completed and the answer was stored without a host receipt')
    assert.deepEqual(JSON.parse(String(source.context)), { kind: 'task', id: event.taskId })
    assert.equal(history.prepare('SELECT text FROM messages WHERE conversation_id=? AND source_id=?').get(source.conversation, source.id)?.text, answer)
  } finally { memory.close(); history.close() }
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
      if (modelToolResults(request, 'list_background_tasks').length === 0) return { tool: { name: 'list_background_tasks', input: {} } }
      if (modelToolResults(request, 'search_conversations').length === 0) return { tool: { name: 'search_conversations', input: { query: '盘点接口' } } }
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
    JSON.stringify({ taskBHistoryResults, requests: taskBRequests.map(request => request.messages.at(-1)) }))

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

test('custom ask_user_question answer while memory owner stays unavailable past budget omits unbacked sourceId without blocking Q&A (P1-3)', { timeout: 30_000 }, async t => {
  let dropReady = false
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'message') {
      const frame = objectOf(args[0])
      if (dropReady && frame?.type === 'memory_owner_state' && frame.state === 'ready') return true
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  const brief = '离线验证提问回答不发布空来源'
  const app = await setup(t, request => {
    if (JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    if (questionOf(request.messages) === brief) return { tool: { name: 'ask_user_question', input: { questions: [
      { id: 'offline-city', question: '这项任务在哪个城市？', header: '城市', options: [{ label: '上海', description: '使用上海' }], multiSelect: false },
    ] } } }
    return null
  })
  await app.ask(`后台做：${brief}`)
  const event = await eventually(() => app.events.find(item => item.type === 'task_question'))
  assert.ok(event && 'questionId' in event && typeof event.questionId === 'string' && 'taskId' in event && typeof event.taskId === 'string')

  // Force memory-worker unavailable and suppress its ready transition past onQuestionAnswer's 500ms budget.
  dropReady = true
  const workerPid = app.memoryOwnerPid()
  assert.ok(typeof workerPid === 'number' && workerPid > 0)
  process.kill(workerPid, 'SIGKILL')
  await delay(100)

  const answer = '这项任务在成都进行'
  assert.equal(await app.call('agent:answer', event.questionId, [{ id: 'offline-city', selected: [], custom: answer }], randomUUID()), true)
  assert.ok(await eventually(() => app.tasks().some(task => task.task.id === event.taskId && task.endedAt)))

  const history = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  try {
    const row = history.prepare('SELECT source_id FROM messages WHERE text = ?').get(answer) as { source_id: string | null } | undefined
    assert.ok(row, 'Q&A custom answer must still be recorded in conversation history')
    assert.equal(row.source_id, null, 'unbacked sourceId must NOT be published when memory owner stayed unavailable')
  } finally { history.close() }
})

test('pending sourceAlias replay caps in-flight concurrency below OWNER_RPC_MAX_ACTIVE and drains >64 queued aliases (P2-1)', { timeout: 30_000 }, async t => {
  let dropReady = false
  let inflight = 0
  let maxInflight = 0
  let succeeded = 0
  const aliasIds = new Set<string>()
  const capturedAliases = new Map<string, { session: string, wireText: string }>()
  const heldReadyFrames: Array<{ child: ChildProcess, frame: unknown }> = []
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', function(this: ChildProcess, raw: unknown, ...rest: unknown[]) {
        const frame = objectOf(raw)
        if (frame?.type === 'memory_host_request' && frame.method === 'sourceAlias' && typeof frame.requestId === 'string') {
          aliasIds.add(frame.requestId)
          const input = objectOf(frame.input)
          if (typeof input?.sourceId === 'string' && typeof input.session === 'string' && typeof input.wireText === 'string') {
            capturedAliases.set(input.sourceId, { session: input.session, wireText: input.wireText })
          }
          inflight++
          maxInflight = Math.max(maxInflight, inflight)
        }
        return Reflect.apply(send, this, [raw, ...rest]) as boolean
      })
    }
    if (event === 'message') {
      const frame = objectOf(args[0])
      if (dropReady && frame?.type === 'memory_owner_state' && frame.state === 'ready') {
        heldReadyFrames.push({ child: this, frame: args[0] })
        return true
      }
      if (frame?.type === 'memory_host_result' && typeof frame.requestId === 'string' && aliasIds.delete(frame.requestId)) {
        inflight = Math.max(0, inflight - 1)
        if (frame.ok === true) succeeded++
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  const app = await setup(t, () => null)

  // Drop ready while worker restarts, queue 70 prompts (each enqueues a pending sourceAlias while not ready), then release ready.
  dropReady = true
  const workerPid = app.memoryOwnerPid()
  assert.ok(typeof workerPid === 'number' && workerPid > 0)
  process.kill(workerPid, 'SIGKILL')
  assert.ok(await eventually(() => heldReadyFrames.length > 0, { timeoutMs: 10_000 }))

  const beforeSucceeded = succeeded
  const submittedIds: string[] = []
  const submittedTexts: string[] = []
  for (let i = 0; i < 70; i++) {
    const id = randomUUID()
    const text = `批量别名队列项 ${i}`
    submittedIds.push(id)
    submittedTexts.push(text)
    await app.call<Promise<unknown>>('agent:prompt', text, [], id).catch(() => {})
  }
  dropReady = false
  for (const held of heldReadyFrames.splice(0)) {
    Reflect.apply(emit, held.child, ['message', held.frame])
  }
  assert.ok(await eventually(() => succeeded - beforeSucceeded >= 70, { timeoutMs: 15_000 }),
    `expected all 70 queued aliases to drain cleanly, drained=${succeeded - beforeSucceeded}`)
  assert.ok(maxInflight <= 16, `pending alias replay must cap concurrency <= 16, saw ${maxInflight}`)
  assert.equal(submittedIds.every(id => capturedAliases.has(id)), true, 'all 70 submitted aliases must have been sent over IPC')
  const placeholders = submittedIds.map(() => '?').join(',')
  assert.ok(await eventually(() => {
    const memoryDb = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
    try {
      const secretRow = memoryDb.prepare("SELECT value FROM memory_meta WHERE key = 'secret'").get() as { value: string } | undefined
      if (!secretRow?.value) return false
      const leftover = memoryDb.prepare(`SELECT COUNT(*) AS n FROM owner_aliases WHERE source IN (${placeholders})`).get(...submittedIds) as { n: number }
      if (leftover.n !== 0) return false
      const checkRow = memoryDb.prepare("SELECT COUNT(*) AS n FROM owner_messages WHERE session = ? AND ((kind = 'original' AND source = ?) OR (kind = 'ignored' AND hash = ?))")
      for (const sourceId of submittedIds) {
        const sent = capturedAliases.get(sourceId)!
        const wireHash = createHmac('sha256', secretRow.value).update(JSON.stringify(sent.wireText)).digest('hex')
        const match = checkRow.get(sent.session, sourceId, wireHash) as { n: number }
        if (match.n !== 1) return false
      }
      return true
    } finally { memoryDb.close() }
  }, { timeoutMs: 10_000 }), 'every single one of the 70 submitted aliases must settle to exactly 1 terminal owner_messages row (original or ignored) with 0 leftover owner_aliases rows')
})

test('custom ask_user_question answer recovers across unavailable(A)->recovering(B)->ready(B) within budget and preserves sourceId on post-commit disconnect (R2 P1-3, P2-1)', { timeout: 30_000 }, async t => {
  let mode: 'recover-within-budget' | 'disconnect-after-commit' = 'recover-within-budget'
  let answerReqId: string | undefined
  let injectedDisconnect = false
  const heldRecoveryFrames: Array<{ child: ChildProcess, frame: unknown }> = []
  let holdRecovery = false
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', function(this: ChildProcess, raw: unknown, ...rest: unknown[]) {
        const frame = objectOf(raw)
        if (frame?.type === 'memory_host_request' && frame.method === 'acceptQuestionAnswer' && typeof frame.requestId === 'string') {
          answerReqId = frame.requestId
        }
        return Reflect.apply(send, this, [raw, ...rest]) as boolean
      })
    }
    if (event === 'message') {
      const frame = objectOf(args[0])
      if (mode === 'recover-within-budget' && holdRecovery && frame?.type === 'memory_owner_state' && (frame.state === 'recovering' || frame.state === 'ready')) {
        heldRecoveryFrames.push({ child: this, frame: args[0] })
        return true
      }
      if (mode === 'disconnect-after-commit' && frame?.type === 'memory_host_result' && frame.requestId === answerReqId && frame.ok === true && !injectedDisconnect) {
        injectedDisconnect = true
        // Worker already committed acceptQuestionAnswer; drop ACK and inject unavailable instead!
        Reflect.apply(emit, this, ['message', {
          type: 'memory_owner_state',
          protocol: frame.protocol,
          epoch: frame.epoch,
          state: 'unavailable',
          revision: 1,
          coreEpoch: 1,
          pid: 0,
        }])
        return true
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })

  const brief1 = '预算内换代恢复写入回答'
  const brief2 = '提交后断连保留确定性来源编号'
  const brief3 = '敏感问题被worker明确拒绝不落空链接'
  const app = await setup(t, request => {
    if (JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    const q = questionOf(request.messages)
    if (q === brief1) return { tool: { name: 'ask_user_question', input: { questions: [
      { id: 'rec-city', question: '恢复测试城市？', header: '城市', options: [{ label: '上海', description: '使用上海' }], multiSelect: false },
    ] } } }
    if (q === brief2) return { tool: { name: 'ask_user_question', input: { questions: [
      { id: 'disc-city', question: '断连测试城市？', header: '城市', options: [{ label: '北京', description: '使用北京' }], multiSelect: false },
    ] } } }
    if (q === brief3) return { tool: { name: 'ask_user_question', input: { questions: [
      { id: 'sec-key', question: '请确认密钥 sk-1234567890abcdefghijklmnop 的用途？', header: '敏感', options: [{ label: '测试', description: '测试' }], multiSelect: false },
    ] } } }
    return null
  })

  // Case 1 (R2 P1-3): kill worker -> unavailable(A) -> hold recovering(B)+ready(B) briefly -> submit answer -> release recovering(B) then ready(B) within 500ms budget!
  await app.ask(`后台做：${brief1}`)
  const ev1 = await eventually(() => app.events.find(item => item.type === 'task_question'))
  assert.ok(ev1 && 'questionId' in ev1 && typeof ev1.questionId === 'string' && 'taskId' in ev1 && typeof ev1.taskId === 'string')
  holdRecovery = true
  const pid1 = app.memoryOwnerPid()
  assert.ok(typeof pid1 === 'number' && pid1 > 0)
  process.kill(pid1, 'SIGKILL')
  assert.ok(await eventually(() => heldRecoveryFrames.some(item => objectOf(item.frame)?.state === 'ready'), { timeoutMs: 10_000 }))

  const answer1 = '预算内恢复在南京进行'
  const answerPromise1 = app.call<Promise<boolean>>('agent:answer', ev1.questionId, [{ id: 'rec-city', selected: [], custom: answer1 }], randomUUID())
  setTimeout(() => {
    holdRecovery = false
    for (const held of heldRecoveryFrames.splice(0)) Reflect.apply(emit, held.child, ['message', held.frame])
  }, 40)
  assert.equal(await answerPromise1, true)
  assert.ok(await eventually(() => app.tasks().some(task => task.task.id === ev1.taskId && task.endedAt)))

  // Case 3 (R3 P2-1): worker explicitly rejects secret-bearing question -> must NOT publish unbacked source_id in history!
  const evOffset3 = app.events.length
  await app.ask(`后台做：${brief3}`)
  const ev3 = await eventually(() => app.events.slice(evOffset3).find(item => item.type === 'task_question'))
  assert.ok(ev3 && 'questionId' in ev3 && typeof ev3.questionId === 'string' && 'taskId' in ev3 && typeof ev3.taskId === 'string')
  const answer3 = '这是敏感问题的回答文本'
  assert.equal(await app.call('agent:answer', ev3.questionId, [{ id: 'sec-key', selected: [], custom: answer3 }], randomUUID()), true)
  assert.ok(await eventually(() => app.tasks().some(task => task.task.id === ev3.taskId && task.endedAt)))

  // Case 2 (R2 P2-1): commit succeeds in worker, then unavailable arrives before ACK -> sourceId must still match memory_sources.id!
  mode = 'disconnect-after-commit'
  const evOffset = app.events.length
  await app.ask(`后台做：${brief2}`)
  const ev2 = await eventually(() => app.events.slice(evOffset).find(item => item.type === 'task_question'))
  assert.ok(ev2 && 'questionId' in ev2 && typeof ev2.questionId === 'string' && 'taskId' in ev2 && typeof ev2.taskId === 'string')
  const answer2 = '提交后断连在苏州进行'
  assert.equal(await app.call('agent:answer', ev2.questionId, [{ id: 'disc-city', selected: [], custom: answer2 }], randomUUID()), true)
  assert.ok(await eventually(() => app.tasks().some(task => task.task.id === ev2.taskId && task.endedAt)))
  assert.equal(injectedDisconnect, true, 'must have injected post-commit unavailable disconnect')

  const memory = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  const history = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  try {
    const src1 = await eventually(() => memory.prepare("SELECT id, conversation FROM memory_sources WHERE author='answer' AND hash=?").get(memoryHash(answer1)))
    assert.ok(src1, 'answer submitted during unavailable(A)->recovering(B)->ready(B) within budget must persist in memory_sources')
    assert.equal(history.prepare('SELECT source_id FROM messages WHERE text = ?').get(answer1)?.source_id, src1.id)

    assert.equal(memory.prepare("SELECT id FROM memory_sources WHERE author='answer' AND hash=?").get(memoryHash(answer3)), undefined,
      'secret-bearing question answer rejected by worker must not exist in memory_sources')
    const hist3 = history.prepare('SELECT source_id FROM messages WHERE text = ?').get(answer3) as { source_id: string | null } | undefined
    assert.ok(hist3, 'rejected answer text must still be recorded in conversation history')
    assert.equal(hist3.source_id, null, 'explicit worker rejection must NOT publish an unbacked source_id in history')

    const src2 = await eventually(() => memory.prepare("SELECT id, conversation FROM memory_sources WHERE author='answer' AND hash=?").get(memoryHash(answer2)))
    assert.ok(src2, 'post-commit disconnect answer must exist in memory_sources')
    assert.equal(history.prepare('SELECT source_id FROM messages WHERE text = ?').get(answer2)?.source_id, src2.id,
      'history message must keep deterministic source_id when disconnect occurs after send/commit')
  } finally { memory.close(); history.close() }
})
