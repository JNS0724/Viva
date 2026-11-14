import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs, { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createBackend } from '../src/backend/compose.ts'
import type { FeedItem } from '../src/backend/feed-store.ts'
import type { HostCapabilities, HostEvent } from '../src/backend/host.ts'
import type { AgentInfo } from '../src/shared/agent-info.ts'
import type { IpcRegistry } from '../src/shared/ipc-contract.ts'
import type { IpcResults } from '../src/shared/ipc-results.ts'
import { CODE_ROOT } from '../src/shared/node/app-roots.ts'
import { eventually } from './fixtures/dsh-harness.js'
import { questionOf, startFakeLlm } from './fixtures/fake-llm.js'

const oldValue = 'amber@example.com'
const newValue = 'cobalt@example.com'
const oldFact = `我的周报提交邮箱是 ${oldValue}`
const replacement = `从现在起，我的周报提交邮箱从 ${oldValue} 改为 ${newValue}`
type Request = { system?: unknown, messages: Parameters<typeof questionOf>[0] }
type Task = IpcResults['task:finished'][number]
type Change = IpcResults['memory:list-changes'][number]

function makeScheduleDue(directory: string) {
  const db = new DatabaseSync(join(directory, 'app.db'))
  try {
    db.prepare("UPDATE schedules SET record=json_set(record, '$.scheduledAt', ?) WHERE status='active'")
      .run(new Date(Date.now() - 1000).toISOString())
  } finally { db.close() }
}

async function setup(t: TestContext, decide: (request: Request) => object | null, { image = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'viva-memory-handoff-'))
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  const original = { AGENT_CWD: process.env.AGENT_CWD, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DSH_NODE: process.env.DSH_NODE, NO_PROXY: process.env.NO_PROXY }
  delete process.env.DEEPSEEK_API_KEY
  Object.assign(process.env, { AGENT_CWD: workspace, DSH_NODE: process.execPath, NO_PROXY: '127.0.0.1,localhost' })
  const model = await startFakeLlm({ decideFirst: raw => decide(raw as Request) })
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
  const backend = createBackend({ host, ipc: { handle: register, on: register } })
  t.after(async () => {
    backend.markQuitting()
    await backend.stop()
    backend.close()
    await model.close()
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  backend.open()
  await call('models:add', { name: 'Local fixture', api: 'anthropic-messages', baseURL: model.url, models: [{ id: 'deepseek-chat', image }], key: 'test-gateway-key' })
  assert.ok(await eventually(() => call<AgentInfo>('agent:info').sessionId))
  const ask = (text: string) => call<Promise<void>>('agent:prompt', text, [], randomUUID())
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
  return { ask, call, directory, events, feed, memories, model, newTopic, recallOld, replace, restart, schedule, tasks,
    wake: () => backend.signal({ kind: 'system.woke' }) }
}

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

test('an ordinary city choice still lets the same foreground operation start a background task', { timeout: 45_000 }, async t => {
  const marker = 'Set up a background check with a confirmed city'
  const brief = 'Use Shanghai for this task only'
  const app = await setup(t, request => {
    if (JSON.stringify(request.system).includes('记忆整理员')) return null
    const wire = JSON.stringify(request.messages)
    if (!wire.includes(marker)) return null
    if (!wire.includes('tool_result')) return { tool: { name: 'ask_user_question', input: { questions: [{
      id: 'city', question: '在哪个城市？', options: [{ label: 'Shanghai' }, { label: 'Beijing' }],
    }] } } }
    if (!wire.includes('start_background_task')) return { tool: { name: 'start_background_task', input: { brief } } }
    return { text: '任务已交给后台。' }
  })
  const reply = app.ask(marker)
  const question = await eventually(() => app.events.find(event => event.type === 'question'))
  assert.ok(question)
  assert.equal(app.call('agent:answer', question.questionId, [{ id: 'city', selected: ['Shanghai'] }], randomUUID()), true)
  await reply
  assert.ok(await eventually(() => app.tasks().some(task => task.endedAt && task.task.title === brief)))
  assert.ok(app.model.requests.some(request => questionOf((request as Request).messages) === brief))
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
  await app.recallOld()
  await app.schedule(scheduleOld)
  await app.newTopic()
  await app.schedule(scheduleIndependent)
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
  t.after(() => db.close())
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
