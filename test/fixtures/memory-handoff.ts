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
import { openMemoryOwner } from '../../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../../src/memory/node/native-original-maintenance.ts'
import { createNativeOutputAttempts } from '../../src/memory/node/native-output-attempts.ts'
import { createNativeToolReads } from '../../src/memory/node/native-tool-reads.ts'
import { eraseColdNativeCopies } from '../../plugins/memory/lib/native/maintenance.ts'
import { NATIVE_OUTPUT_MARKER } from '../../plugins/memory/lib/native/output-attempts.ts'
import { nativeEventDigest } from '../../plugins/memory/lib/native/event-digest.ts'
import { recordCompactionInputs } from '../../plugins/memory/lib/native/compaction-inputs.ts'
import { memoryOriginalContentDigest } from '../../plugins/memory/lib/context-recovery.ts'
import { openTraceDb, traceStepDigest } from '../../plugins/trace/lib/store.ts'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { createBackend } from '../../src/backend/compose.ts'
import type { FeedItem } from '../../src/backend/feed-store.ts'
import type { HostCapabilities, HostEvent } from '../../src/backend/host.ts'
import { MEMORY_EMBEDDING_DIMENSIONS } from '../../src/memory/node/memory-embedder.ts'
const MEMORY_EMBEDDING_FINGERPRINT = 'handoff-test-vector-space'
import { memoryHash, openMemoryStore } from '../../src/memory/node/memory-store.ts'
import { SQLITE_BUSY_TIMEOUT_MS } from '../../src/memory/node/sqlite.ts'
import { openMemoryDocuments } from '../../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../../src/memory/node/source-identity.ts'
import type { MemoryFileDetail, MemoryFileListResult, MemoryFileProfile } from '../../src/memory/contracts/file-management.ts'
import { openMemoryFileIndex } from '../../src/memory/node/memory-file-index.ts'
import type { AgentInfo } from '../../src/shared/agent-info.ts'
import type { IpcRegistry } from '../../src/shared/ipc-contract.ts'
import type { IpcResults } from '../../src/shared/ipc-results.ts'
import { CODE_ROOT } from '../../src/shared/node/app-roots.ts'
import { requestsIn } from '../../src/shared/request-routing/header.ts'
import { eventually } from './eventually.ts'
import { openMemoryControlDb } from './memory-control-db.ts'
import { lastWords, questionOf, routeFixtureTools, startFakeLlm } from './fake-llm.ts'
import { runToCrash } from './memory-crash-process.ts'
import { scratch } from './scratch.js'
import { modelToolResults } from './model-tool-results.ts'

const oldValue = 'amber@example.com'
const newValue = 'cobalt@example.com'
const oldFact = `记住：我的周报提交邮箱是 ${oldValue}`
const withdrawalCrashFixture = new URL('./memory-withdrawal-crash.ts', import.meta.url)
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
    writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: memory-ptc-task-fixture\n      name: ${JSON.stringify(new URL('./memory-ptc-tasks.ts', import.meta.url).href)}\n      config: ${JSON.stringify(ptcFailure === 'crash' ? { crashBeforeSearch: join(directory, 'ptc-prepared') } : { rejectSearch: ptcFailure === 'reject', ...(ptcDrainSpill ? { drainReadLog: join(directory, 'ptc-drained-read-log') } : {}) })}\n- id: spill-policy\n  name: '@deepseek-ai/dsh-spill-policy'\n  config:\n    maxInlineTokens: 512\n- id: spill-local\n  name: '@deepseek-ai/dsh-spill-local'\n  config:\n    root: ${JSON.stringify(join(directory, 'spills'))}\n    cleanupPeriodDays: 0\n`)
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
        if (!item.enabled || item.applicability !== 'current' || item.hasProjection === false) continue
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
    wake: () => backend?.signal({ kind: 'system.woke' }) }
}


const STOP_AFTER_PTC_READ = `CREATE TRIGGER stop_after_ptc_read BEFORE INSERT ON owner_native_output_reads
  WHEN EXISTS(SELECT 1 FROM owner_native_tool_reads) BEGIN SELECT RAISE(ABORT, 'no later PTC model send'); END`

async function rewriteRejectedSource(app: Awaited<ReturnType<typeof setup>>, sourceId: string, original: string) {
  await app.call('history:save', [{ role: 'user', text: original, receipt: null, sourceId }])
  const text = '已经替换前面的临时说明'
  const edit = await app.call<Promise<{ ok: boolean, sourceId: string }>>('timeline:rewind', { words: original, keep: 0, text })
  assert.ok(edit.ok)
  await app.call('agent:prompt', text, [], edit.sourceId)
}

export {
  assert, createHash, randomUUID, ChildProcess, fs, mkdirSync, rmSync, writeFileSync, join, DatabaseSync, Worker, once, Context, compactCheckpointSource, imageOffloadProjection, AttachmentId, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, appendPluginRecord, pluginRecordOf, Session, SessionId, SessionLogOffset, jsonl, SessionTitleProviderId, openMemoryOwner, openNativeOriginalMaintenance, createNativeOutputAttempts, createNativeToolReads, eraseColdNativeCopies, NATIVE_OUTPUT_MARKER, nativeEventDigest, recordCompactionInputs, memoryOriginalContentDigest, openTraceDb, traceStepDigest, setImmediate, delay, createBackend, MEMORY_EMBEDDING_DIMENSIONS, memoryHash, openMemoryStore, SQLITE_BUSY_TIMEOUT_MS, openMemoryDocuments, memorySourceToken, memorySourceWorkspace, openMemoryFileIndex, CODE_ROOT, requestsIn, eventually, openMemoryControlDb, lastWords, questionOf, routeFixtureTools, startFakeLlm, runToCrash, scratch, modelToolResults, MEMORY_EMBEDDING_FINGERPRINT, oldValue, newValue, oldFact, withdrawalCrashFixture, makeScheduleDue, contextGeneration, setup, STOP_AFTER_PTC_READ, rewriteRejectedSource,
}

export type { CompactionId, SessionEvent, SessionSeq, FeedItem, HostCapabilities, HostEvent, MemoryFileDetail, MemoryFileListResult, MemoryFileProfile, AgentInfo, IpcRegistry, IpcResults, ModelMessage, Request, Task }
