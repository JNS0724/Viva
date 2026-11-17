import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ChildProcess } from 'node:child_process'
import * as handoff from './fixtures/memory-handoff.ts'
import type { CompactionId, SessionEvent, SessionSeq, FeedItem, HostCapabilities, HostEvent, MemoryFileDetail, MemoryFileListResult, MemoryFileProfile, AgentInfo, IpcRegistry, IpcResults, ModelMessage, Request, Task } from './fixtures/memory-handoff.ts'

const { createHash, randomUUID, fs, mkdirSync, rmSync, writeFileSync, join, Worker, once, Context, compactCheckpointSource, imageOffloadProjection, AttachmentId, createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, appendPluginRecord, pluginRecordOf, Session, SessionId, SessionLogOffset, jsonl, SessionTitleProviderId, openMemoryOwner, openNativeOriginalMaintenance, createNativeOutputAttempts, createNativeToolReads, eraseColdNativeCopies, NATIVE_OUTPUT_MARKER, nativeEventDigest, recordCompactionInputs, memoryOriginalContentDigest, openTraceDb, traceStepDigest, setImmediate, delay, createBackend, MEMORY_EMBEDDING_DIMENSIONS, memoryHash, openMemoryStore, SQLITE_BUSY_TIMEOUT_MS, openMemoryDocuments, memorySourceToken, memorySourceWorkspace, openMemoryFileIndex, CODE_ROOT, requestsIn, eventually, openMemoryControlDb, lastWords, questionOf, routeFixtureTools, startFakeLlm, runToCrash, scratch, modelToolResults, MEMORY_EMBEDDING_FINGERPRINT, oldValue, newValue, oldFact, withdrawalCrashFixture, makeScheduleDue, contextGeneration, setup, STOP_AFTER_PTC_READ, rewriteRejectedSource } = handoff

test('a human prompt racing report busy delivery is sent once before its later steer', { timeout: 45_000 }, async t => {
  const question = '报告刚启动时到达的新用户请求', later = '紧随新请求到达的补充'
  const operation = randomUUID(), laterOperation = randomUUID()
  let release = () => {}, firstModel = false
  const paused = new Promise<void>(resolve => { release = resolve })
  let app: Awaited<ReturnType<typeof setup>> | undefined
  let incoming: Promise<unknown> | undefined, retry: Promise<unknown> | undefined, steered: Promise<unknown> | undefined
  app = await setup(t, request => {
    if (firstModel || questionOf(request.messages) !== question) return null
    const id = request.messages.flatMap(message => typeof message.content === 'string' ? requestsIn(message.content)
      : (message.content ?? []).flatMap(part => requestsIn(part.text ?? ''))).find(entry => entry.words.startsWith(question))?.id
    if (!id) return null
    firstModel = true
    return { tool: { name: 'commit_route', input: { requestId: id, goals: [{ goal: question, disposition: 'answer' }],
      actions: [{ kind: 'reply', scope: question }] } }, waitFor: paused }
  }, { onEvent(event) {
    if (!app || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    // The backend reserved the report, but the renderer has not received its
    // busy notification yet. Send through the actual IPC handler at this seam.
    try { incoming = Promise.resolve(app.call('agent:prompt', question, [], operation)) }
    catch (error) { incoming = Promise.reject(error) }
    void incoming.catch(() => {})
    try { retry = Promise.resolve(app.call('agent:prompt', question, [], operation)) }
    catch (error) { retry = Promise.reject(error) }
    void retry.catch(() => {})
    try { steered = Promise.resolve(app.call('agent:steer', later, laterOperation)) }
    catch (error) { steered = Promise.reject(error) }
    void steered.catch(() => {})
  } })
  app.defer(release)
  await app.ask('后台做：生成一份独立的报告')
  assert.ok(await eventually(() => Boolean(incoming)))
  assert.ok(await eventually(() => firstModel))
  const duringDispatch = app.call<Promise<unknown>>('agent:prompt', question, [], operation)
  await assert.rejects(async () => app!.call('agent:prompt', '同一操作不能改成其他原文', [], operation))
  release()
  await incoming
  await retry
  await duringDispatch
  assert.deepEqual(await steered, { ok: true, delivery: 'sent' })
  const prompts = app.model.requests.map(request => questionOf((request as Request).messages))
  const first = prompts.findIndex(text => text === question), second = prompts.findIndex(text => text === later)
  assert.ok(first >= 0 && second > first, JSON.stringify(prompts))
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try {
    for (const id of [operation, laterOperation]) assert.equal(db.prepare('SELECT count(*) n FROM memory_sources WHERE id=?').get(id)?.n, 1)
  } finally { db.close() }
  const history = new DatabaseSync(join(app.directory, 'app.db'), { readOnly: true })
  try {
    for (const id of [operation, laterOperation]) assert.equal(history.prepare('SELECT count(*) n FROM routing_request_sources WHERE source=?').get(id)?.n, 1)
  } finally { history.close() }
})

test('cancelling a report rejects its queued human before any native source is delivered', { timeout: 45_000 }, async t => {
  const question = '取消报告时仍待发送的独立用户原文', operation = randomUUID()
  let app: Awaited<ReturnType<typeof setup>> | undefined
  let incoming: Promise<IpcResults['agent:prompt']> | undefined
  app = await setup(t, () => null, { onEvent(event) {
    if (!app || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    incoming = app.call<Promise<IpcResults['agent:prompt']>>('agent:prompt', question, [], operation)
    void app.call<Promise<unknown>>('agent:cancel').catch(() => {})
  } })
  await app.ask('后台做：生成可以取消的报告')
  assert.ok(await eventually(() => Boolean(incoming)))
  assert.equal((await incoming)?.accepted, false)
  assert.ok(app.model.requests.every(request => !JSON.stringify(request).includes(question)))
  const db = new DatabaseSync(join(app.directory, 'memory', 'memory.db'), { readOnly: true })
  try { assert.equal(db.prepare('SELECT id FROM memory_sources WHERE id=?').get(operation), undefined) }
  finally { db.close() }
  const selected = app.call<AgentInfo>('agent:info')
  await app.call('history:save', [{ role: 'user', text: question, sourceId: operation, receipt: null, failed: false }])
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

test('a lost host start receipt remains unknown after cancellation rather than becoming not-sent', { timeout: 45_000 }, async t => {
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
  let app: Awaited<ReturnType<typeof setup>> | undefined, incoming: Promise<unknown> | undefined
  let release = () => {}, held = false
  const gate = new Promise<void>(resolve => { release = resolve })
  app = await setup(t, request => {
    if (!held && questionOf(request.messages) === question) { held = true; return { text: '等待这次请求结束', waitFor: gate } }
    return null
  }, { onEvent(event) {
    if (!app || incoming || event.type !== 'turn_started' || event.by !== 'task') return
    incoming = app.call<Promise<unknown>>('agent:prompt', question, [], operation)
    void incoming.catch(() => {})
  } })
  app.defer(release)
  await app.ask('后台做：启动回执故障验证')
  assert.ok(await eventually(() => held))
  const rejected = assert.rejects(incoming!, /Synthetic delivery receipt failure/)
  await app.call('agent:cancel'); release(); await rejected
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
    incoming = app.call<Promise<unknown>>('agent:prompt', question, [], operation)
    void incoming.catch(() => {})
  } })
  app.defer(release)
  await app.ask('后台做：验证取消仍然发生')
  assert.ok(await eventually(() => nativeHeld))
  const rejected = assert.rejects(incoming!, /Synthetic retirement receipt failure/)
  const offset = app.events.length
  const cancelling = app.call<Promise<void>>('agent:cancel')
  assert.throws(() => app!.call('agent:prompt', question, [], [operation]), /finish|等待|结束/i,
    'retired scheduling ownership cannot let a replay start over a still-cancelling native turn')
  await cancelling; release(); await rejected
  assert.ok(await eventually(() => app!.events.slice(offset).some(event => event.type === 'turn_end' && event.stopReason === 'cancelled')))
  assert.ok(app.model.requests.every(request => !JSON.stringify(request).includes(question)))
})

for (const outcome of ['replacement', 'ended', 'next-turn', 'alias-error', 'withdrawn'] as const) test(`an ordinary steer held in source alias admission respects its original turn (${outcome})`, { timeout: 45_000 }, async t => {
  const before = '保持旧话题运行', after = '保持新话题运行', words = '只能送给旧话题的插话', operation = randomUUID()
  let releaseOld = () => {}, releaseNew = () => {}, releaseAlias = () => {}, aliasHeld = false
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve }), newGate = new Promise<void>(resolve => { releaseNew = resolve })
  let oldModel = false, newModel = false
  const emit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function(this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === 'spawn' && this.send) {
      const send = this.send
      t.mock.method(this, 'send', function(this: ChildProcess, message: unknown, ...rest: unknown[]) {
        const request = message as { type?: string, method?: string, requestId?: string, epoch?: string, input?: { operationId?: string } }
        if (!aliasHeld && request?.type === 'memory_host_request' && request.method === 'sourceAlias' && request.input?.operationId === operation) {
          aliasHeld = true
          releaseAlias = () => {
            if (outcome === 'alias-error') this.emit('message', { type: 'memory_host_result', requestId: request.requestId, epoch: request.epoch,
              ok: false, error: { reason: 'The original source alias was rejected.' } })
            else Reflect.apply(send, this, [message, ...rest])
          }
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
  if (outcome === 'replacement') await app.call('agent:cancel')
  if (outcome !== 'alias-error') { releaseOld(); await original }
  if (outcome === 'replacement') await app.newTopic()
  const fresh = outcome === 'replacement' || outcome === 'next-turn' ? app.ask(after) : null
  void fresh?.catch(() => {})
  if (fresh) assert.ok(await eventually(() => newModel))
  const count = app.model.requests.length
  releaseAlias()
  const result = await steered
  assert.equal(result.ok, false)
  assert.equal(result.delivery, 'not-sent')
  assert.equal(result.reason, outcome === 'replacement' || outcome === 'alias-error' ? 'unavailable' : 'idle')
  if (outcome === 'alias-error') assert.match(result.message ?? '', /The original source alias was rejected/)
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
  } else if (outcome === 'withdrawn') {
    await app.call('history:save', [{ role: 'user', text: words, receipt: null, sourceId: operation }])
    const edited = await app.call<Promise<{ ok: boolean }>>('timeline:rewind', { words, keep: 0, text: '替换这条尚未送达的原文' })
    assert.equal(edited.ok, true)
    const afterEdit = app.model.requests.length
    await assert.rejects(app.call<Promise<void>>('agent:prompt', words, [], operation), /withdrawn|unavailable/i)
    await assert.rejects(app.call<Promise<void>>('agent:prompt', words, [], [operation]))
    assert.equal(app.model.requests.length, afterEdit, 'neither first-delivery nor canonical replay can revive a withdrawn alias')
  }
})

test('first idle deliveries and canonical replay retain FIFO ahead of a later steer', { timeout: 45_000 }, async t => {
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
        const request = message as { type?: string, method?: string, input?: { operationId?: string } }
        const id = request.input?.operationId
        if (request.type === 'memory_host_request' && request.method === 'sourceAlias' && id && (id === firstId || id === secondId) && !aliases.has(id)) {
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
  assert.ok(incoming[0]?.assistant.includes(turns[0]!))
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
