import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ChildProcess } from 'node:child_process'
import * as handoff from './fixtures/memory-handoff.ts'
import type { CompactionId, SessionEvent, SessionSeq, FeedItem, HostCapabilities, HostEvent, MemoryFileDetail, MemoryFileListResult, MemoryFileProfile, AgentInfo, IpcRegistry, IpcResults, ModelMessage, Request, Task } from './fixtures/memory-handoff.ts'

const { createHash, randomUUID, fs, mkdirSync, rmSync, writeFileSync, join, Worker, once, Context, compactCheckpointSource, imageOffloadProjection, AttachmentId, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, appendPluginRecord, pluginRecordOf, Session, SessionId, SessionLogOffset, jsonl, SessionTitleProviderId, openMemoryOwner, openNativeOriginalMaintenance, createNativeOutputAttempts, createNativeToolReads, eraseColdNativeCopies, NATIVE_OUTPUT_MARKER, nativeEventDigest, recordCompactionInputs, memoryOriginalContentDigest, openTraceDb, traceStepDigest, setImmediate, delay, createBackend, MEMORY_EMBEDDING_DIMENSIONS, memoryHash, openMemoryStore, SQLITE_BUSY_TIMEOUT_MS, openMemoryDocuments, memorySourceToken, memorySourceWorkspace, openMemoryFileIndex, CODE_ROOT, requestsIn, eventually, openMemoryControlDb, lastWords, questionOf, routeFixtureTools, startFakeLlm, runToCrash, scratch, modelToolResults, MEMORY_EMBEDDING_FINGERPRINT, oldValue, newValue, oldFact, withdrawalCrashFixture, makeScheduleDue, contextGeneration, setup, STOP_AFTER_PTC_READ, rewriteRejectedSource } = handoff

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
    }, { dailyNotes: true })
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
