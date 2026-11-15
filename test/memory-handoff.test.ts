import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs, { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createBackend } from '../src/backend/compose.ts'
import type { FeedItem } from '../src/backend/feed-store.ts'
import type { HostCapabilities, HostEvent } from '../src/backend/host.ts'
import { MEMORY_EMBEDDING_DIMENSIONS, MEMORY_EMBEDDING_FINGERPRINT } from '../src/backend/memory-embedder.ts'
import { openMemorySemanticIndex } from '../src/backend/memory-semantic.ts'
import type { AgentInfo } from '../src/shared/agent-info.ts'
import type { IpcRegistry } from '../src/shared/ipc-contract.ts'
import type { IpcResults, MemorySummaryView } from '../src/shared/ipc-results.ts'
import { CODE_ROOT } from '../src/shared/node/app-roots.ts'
import { requestsIn } from '../src/shared/request-routing/header.ts'
import { eventually } from './fixtures/dsh-harness.js'
import { questionOf, routeFixtureTools, startFakeLlm } from './fixtures/fake-llm.js'
import { runToCrash } from './fixtures/memory-crash-process.ts'
import { scratch } from './fixtures/scratch.js'
import { modelToolResults } from './fixtures/model-tool-results.ts'

const oldValue = 'amber@example.com'
const newValue = 'cobalt@example.com'
const oldFact = `我的周报提交邮箱是 ${oldValue}`
const replacement = `从现在起，我的周报提交邮箱从 ${oldValue} 改为 ${newValue}`
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

async function setup(t: TestContext, decide: (request: Request) => object | null, { image = false, dailyNotes = false } = {}) {
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
  async function ask(text: string) {
    // A completed task may still be reporting in the foreground. The real composer waits for that turn too.
    assert.ok(await eventually(() => events.findLast(event =>
      event.type === 'turn_started' || event.type === 'turn_end' || event.type === 'error')?.type !== 'turn_started'),
    'the foreground is ready for the next prompt')
    await call<Promise<void>>('agent:prompt', text, [], randomUUID())
  }
  const newTopic = () => call<Promise<AgentInfo>>('agent:new-session')
  const tasks = () => call<Task[]>('task:finished')
  const feed = () => call<FeedItem[]>('feed:list')
  const memories = () => call<{ items: { text: string }[] }>('memory:list', '周报提交邮箱').items
  const restart = () => call<Promise<unknown>>('settings:set-permission', 'workspace-write')
  async function schedule(text: string) {
    await ask(text)
    const proposal = events.findLast(event => event.type === 'schedule_propose')?.proposal
    assert.equal(proposal?.title, text)
    await call('schedules:accept', proposal.proposalId)
  }
  async function recallOld() {
    await ask(oldFact)
    assert.ok(await eventually(() => memories().some(item => item.text.includes(oldValue))))
    await ask('查一下 周报提交邮箱')
  }
  async function replace() {
    await newTopic()
    await ask(replacement)
    assert.ok(await eventually(() => call<Change[]>('memory:list-changes').find(change => change.kind === 'supersede')))
    assert.ok(memories().some(item => item.text.includes(newValue)))
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
  assert.equal(app.memories().length, 0)
  const db = new DatabaseSync(join(app.directory, 'memory.db'), { readOnly: true })
  try {
    const card = await eventually(() => db.prepare('SELECT workspace,path,day FROM memory_daily_notes').get()) as
      { workspace: string, path: string, day: string } | undefined
    assert.ok(card)
    const root = join(app.directory, 'memory-files', card.workspace)
    assert.match(fs.readFileSync(join(root, card.path), 'utf8'), /沿用上周模板，周五提交周报/u)
    assert.ok(fs.readFileSync(join(root, `daily/${card.day}.md`), 'utf8').includes(card.path))
    const sessions = fs.readdirSync(join(root, 'session/dialog'))
    assert.equal(sessions.length, 1)
    assert.equal(fs.readFileSync(join(root, 'session/dialog', sessions[0]!), 'utf8').trim().split('\n').length, 5)
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_note_turns WHERE written=0').get()?.n, 0)
  } finally { db.close() }
})

test('startup completes a history withdrawal interrupted by process death before model reads', { timeout: 45_000 }, async t => {
  const app = await setup(t, () => null)
  const sourceId = randomUUID()
  const initial = app.call<AgentInfo>('agent:info')
  const conversationId = initial.conversationId
  assert.ok(conversationId)
  await app.call('agent:prompt', oldFact, [], sourceId)
  const entry = await eventually(() => app.call<{ items: { id: number, revision: number, text: string }[] }>('memory:list', '周报提交邮箱')
    .items.find(item => item.text.includes(oldValue)))
  assert.ok(entry)
  const memoryFile = join(app.directory, 'memory.db')
  const hasProfileRef = (db: DatabaseSync) => Boolean(db.prepare(`SELECT 1 FROM memory_projections p, json_each(p.refs) refs
    WHERE json_extract(refs.value,'$.kind')='memory' AND json_extract(refs.value,'$.id')=?`).get(entry.id))
  const profileDb = new DatabaseSync(memoryFile, { readOnly: true })
  try { assert.ok(await eventually(() => hasProfileRef(profileDb))) } finally { profileDb.close() }
  await app.call('history:save', [{ role: 'user', text: oldFact, receipt: null, sourceId }])
  const profileProbe = '随手核对背景资料'
  await app.ask(profileProbe)
  assert.ok(app.model.requests.some(raw => {
    const request = raw as Request
    const content = request.messages.at(-1)?.content
    const context = Array.isArray(content) ? content.find(part => part.text?.startsWith('<about-user>'))?.text : null
    return questionOf(request.messages) === profileProbe && context?.includes('助手整理的画像') && context.includes(oldValue)
  }))
  await app.ask('查一下 周报提交邮箱')
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
    assert.equal(memoryDb.prepare('SELECT text FROM memory_sources WHERE id=?').get(sourceId)?.text, oldFact)
    assert.ok(hasProfileRef(memoryDb))
    assert.ok(memoryDb.prepare('SELECT memory FROM memory_semantic_vectors WHERE memory=?').get(entry.id))
  } finally {
    memoryDb.close()
    appDb.close()
  }

  const offset = app.model.requests.length
  assert.ok(await app.startBackend())
  assert.equal(app.memories().length, 0)
  assert.notEqual(app.call<AgentInfo>('agent:info').sessionId, initial.sessionId)
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
    assert.equal(hasProfileRef(recoveredMemory), false)
    assert.equal(recoveredMemory.prepare('SELECT rowid FROM memory_lexical_fts WHERE rowid=?').get(entry.id), undefined)
    assert.equal(recoveredMemory.prepare('SELECT memory FROM memory_semantic_vectors WHERE memory=?').get(entry.id), undefined)
  } finally {
    recoveredMemory.close()
    recoveredApp.close()
  }
})

test('generated project summaries, exact recall and chat history remain in their Git workspace', { timeout: 45_000 }, async t => {
  const firstFact = '当前项目的构建标记是 alpha-orchid-71'
  const secondFact = '当前项目的构建标记是 beta-copper-23'
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
      const { user } = JSON.parse(text) as { user: string }
      return { text: JSON.stringify({ proposals: [firstFact, secondFact].includes(user) ? [{
        spans: [{ start: 0, end: user.length }], kind: 'project', scope: 'project',
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
    const summary = await eventually(() => {
      const { summaries } = app.call<{ summaries: { project: MemorySummaryView | null } }>('memory:get')
      return summaries.project?.generated && summaries.project.items.find(item => item.text === text)
    })
    assert.ok(summary?.source?.link)
    return switched.info
  }
  const check = async (present: string, excluded: string) => {
    const count = app.model.requests.length
    await app.ask('查看本项目的基本资料')
    await app.ask(recall)
    await app.ask(history)
    const messages = app.model.requests.slice(count).map(raw => (raw as Request).messages)
    assert.ok(messages.some(rows => {
      const last = JSON.stringify(rows.at(-1))
      return last.includes('<about-user>') && last.includes('项目摘要') && last.includes(present)
    }))
    for (const name of ['memory_recall', 'search_conversations']) assert.ok(messages.some(rows => {
      const last = JSON.stringify(rows.at(-1))
      return JSON.stringify(rows).includes(`"name":"${name}"`) && last.includes('tool_result') && last.includes(present)
    }), name)
    assert.ok(messages.every(rows => !JSON.stringify(rows).includes(excluded)))
  }
  const sessionA = await enter(projectA, firstFact)
  await check(firstMarker, secondMarker)
  const taskOffset = app.model.requests.length
  await app.ask(`后台做：${backgroundBrief}`)
  assert.ok(await eventually(() => app.tasks().some(task => task.endedAt && task.task.title === backgroundBrief)))
  assert.ok(app.model.requests.slice(taskOffset).some(raw => {
    const request = raw as Request
    return questionOf(request.messages) === backgroundBrief && JSON.stringify(request.messages).includes(firstMarker)
  }))
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
  const db = new DatabaseSync(join(app.directory, 'memory.db'), { readOnly: true })
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
  const page = () => app.call<{ summaries: { user: MemorySummaryView } }>('memory:get').summaries.user
  assert.ok(await eventually(() => page().generated && page().items.some(item => item.text.includes(oldValue))))
  await app.newTopic()
  const offset = app.model.requests.length
  await app.ask('核对下背景资料')
  assert.ok((app.model.requests.slice(offset) as Request[]).some(request =>
    JSON.stringify(request.messages.at(-1)).includes('助手整理的画像')))
  const preference = '我以后使用紫罗兰色图标'
  const count = app.model.requests.length
  await app.ask(`记住：${preference}`)
  assert.ok(await eventually(() => app.call<{ items: { text: string }[] }>('memory:list', preference).items.some(item => item.text === preference)))
  const foreground = (app.model.requests.slice(count) as Request[]).filter(request => JSON.stringify(request.system).includes('个人工作助手'))
  assert.ok(foreground.some(request => questionOf(request.messages) === `记住：${preference}`))
  assert.ok(foreground.some(request => JSON.stringify(request.messages.at(-1)).includes('tool_result')))
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
  assert.ok(switched.ok && switched.info.sessionId !== host.sessionId)
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
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try { await app.call('history:delete', info.conversationId) }
  finally { t.mock.timers.reset() }

  const offset = app.model.requests.length
  await app.ask(instruction)
  const requests = app.model.requests.slice(offset)
  assert.ok(requests.some(request => JSON.stringify(request).includes(instruction)))
  assert.ok(!requests.some(request => questionOf((request as Request).messages) === next))
  const db = new DatabaseSync(join(app.directory, 'memory.db'))
  try {
    assert.ok(db.prepare('SELECT id FROM memory_delivered_sources WHERE id=?').get(sourceId))
    assert.equal(db.prepare('SELECT id FROM memory_sources WHERE id=?').get(sourceId), undefined)
    assert.ok(db.prepare('SELECT id FROM memory_excluded_sources WHERE id=?').get(sourceId))
  } finally { db.close() }
})

test('a persisted schedule waits for the dispatch adapter while degraded chat still works', { timeout: 45_000 }, async t => {
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
  const words = '降级期间对话仍应可用'
  const offset = app.model.requests.length
  await app.ask(words)
  assert.ok(app.model.requests.slice(offset).some(raw => questionOf((raw as Request).messages) === words))
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
  assert.equal(app.memories().length, 0)
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
  assert.ok(await eventually(() => app.memories().some(item => item.text.includes(oldValue))))
  const db = new DatabaseSync(join(app.directory, 'memory.db'), { readOnly: true })
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
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const validUntil = new Date(Date.now() + 60_000)
  const localTime = validUntil.toLocaleTimeString('en-GB', { hourCycle: 'h23' })
  const localDate = validUntil.toLocaleDateString('sv-SE')
  const timePhrase = `在 ${localDate} ${localTime} 前`
  const fact = `${timePhrase}，${oldFact}`
  const title = '为这次周报设一个归档任务'
  const prompt = `定时归档这次周报到 ${oldValue}`
  const scheduledAt = new Date(validUntil.valueOf() + 5000).toISOString()
  const app = await setup(t, request => {
    if (JSON.stringify(request.system).includes('记忆整理员') && JSON.stringify(request.messages).includes(fact)) {
      const span = (part: string) => ({ start: fact.indexOf(part), end: fact.indexOf(part) + part.length })
      return { text: JSON.stringify({ proposals: [{
        spans: [span(fact)], kind: 'fact', scope: 'user', modality: 'asserted', attribution: 'self', keywords: ['周报提交邮箱'],
        fact: { predicate: 'report_email', polarity: 'positive', subject: { kind: 'user', span: span('我') },
          relation: span('周报提交邮箱'), object: span(oldValue) },
        temporal: { kind: 'interval', from: null, to: { date: localDate, time: localTime }, evidence: [span(timePhrase)] },
      }] }) }
    }
    if (questionOf(request.messages) !== title || JSON.stringify(request.messages.at(-1)).includes('tool_result')) return null
    return { tool: { name: 'schedule_create', input: { title, prompt, kind: 'at', at: scheduledAt } } }
  })
  await app.ask(fact)
  assert.ok(await eventually(() => app.memories().some(item => item.text.includes(oldValue))))
  await app.ask('查一下 周报提交邮箱')
  await app.schedule(title)
  t.mock.timers.setTime(new Date(scheduledAt).valueOf() + 1000)
  try {
    const offset = app.model.requests.length
    app.wake()
    await setImmediate()
    assert.ok(app.feed().find(item => item.title === '定时任务需要重新确认'))
    assert.ok(!app.memories().some(item => item.text.includes(oldValue)))
    assert.ok(!app.model.requests.slice(offset).some(request => JSON.stringify(request).includes(prompt)))
  } finally { t.mock.timers.reset() }
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
  const text = app.call<string>('feed:continue', item.id)
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
  const memoryDb = new DatabaseSync(join(app.directory, 'memory.db'))
  try { assert.equal(memoryDb.prepare('SELECT id FROM memory_sources WHERE id=?').get(operation), undefined) }
  finally { memoryDb.close() }
  await app.replace()
  const before = app.model.requests.length
  assert.throws(() => app.call('feed:continue', item.id), /已变更/)
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
