import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createMemoryHostEffects } from '../src/backend/memory-host-effects.ts'
import type { HostMemoryApi, HostMemoryCaller } from '../src/memory/contracts/host.ts'
import type { MemoryProvenance } from '../src/memory/contracts/provenance.ts'
import type { MemoryHostEffect } from '../src/memory/contracts/service.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { createRequestStore } from '../src/backend/request-store.ts'
import { createRequestRuntime, type RequestTasks } from '../src/backend/request-runtime.ts'
import { createRoutingDesk } from '../src/backend/routing-channel.ts'
import { testRequests } from './fixtures/request-routing.ts'

const reply = { goals: [{ goal: '解释', disposition: 'answer' }], actions: [{ kind: 'reply', scope: '解释' }] }
const where = { sessionId: 's1', conversationId: 'c1', cwd: '/work' }

function tasksDoing(log: string[]): RequestTasks {
  return {
    start: async ({ title, brief }, place) => { log.push(`start:${title}|${brief}:${place.conversationId}`); return { taskId: 't-new' } },
    message: async (taskId, text, place) => { log.push(`message:${taskId}:${text}:${place.cwd}`); return {} },
    stop: async (taskId) => { log.push(`stop:${taskId}`); throw new Error('任务不存在') },
  }
}

test('a request is decided once, by its own session, through the protocol; task actions run after with a receipt each', async () => {
  const log: string[] = []
  const requests = testRequests({ tasks: tasksDoing(log) })
  const id = requests.receive({ ...where, kind: 'prompt' })
  assert.match(id, /^r-[0-9a-f-]{36}$/)
  assert.deepEqual(await requests.decide({ requestId: id, sessionId: 'other', plan: reply }), { accepted: false, reason: `没有待处理的请求 ${id}；只能处理系统给出的【请求 ID】` })
  assert.equal((await requests.decide({ requestId: id, sessionId: 's1', plan: { goals: [] } })).accepted, false)
  const plan = { goals: [{ goal: '简报', disposition: 'delegate' }, { goal: '补充', disposition: 'update_task' }, { goal: '停下', disposition: 'stop_task' }],
    actions: [{ kind: 'start', brief: '做今日简报' }, { kind: 'message', taskId: 't1', text: '加科技新闻' }, { kind: 'stop', taskId: 't2' }] }
  assert.deepEqual(await requests.decide({ requestId: id, sessionId: 's1', plan }), { accepted: true, receipts: [
    { kind: 'start', ok: true, taskId: 't-new' }, { kind: 'message', ok: true, taskId: 't1' }, { kind: 'stop', ok: false, error: '任务不存在' },
  ] })
  assert.deepEqual(log, ['start:简报|做今日简报:c1', 'message:t1:加科技新闻:/work', 'stop:t2'], 'in order, in the request\'s conversation and folder; a start without a title is named by its goal')
  const titled = requests.receive({ ...where, kind: 'prompt' })
  await requests.decide({ requestId: titled, sessionId: 's1', plan: { goals: [{ goal: '整理今天的国际大事', disposition: 'delegate' }, { goal: '天气', disposition: 'delegate' }],
    actions: [{ kind: 'start', title: '国际大事', brief: '检索国际新闻' }, { kind: 'start', brief: '查深圳天气' }] } })
  assert.deepEqual(log.slice(3), ['start:国际大事|检索国际新闻:c1', 'start:天气|查深圳天气:c1'], 'its own title when it has one; else the goal it serves, in order')
  assert.deepEqual(requests.store.actions(id).map(action => [action.kind, action.status, action.taskId]), [['start', 'done', 't-new'], ['message', 'done', 't1'], ['stop', 'failed', null]])
  assert.match(String((await requests.decide({ requestId: id, sessionId: 's1', plan: reply }) as { reason: string }).reason), /已经提交过/)
})

test('a turn\'s end fails what it left undecided, for the reason it ended; a decided request stays decided', async () => {
  const requests = testRequests()
  const decided = requests.receive({ ...where, kind: 'prompt' })
  await requests.decide({ requestId: decided, sessionId: 's1', plan: reply })
  const left = requests.receive({ ...where, kind: 'interjection' })
  const elsewhere = requests.receive({ ...where, sessionId: 's2', kind: 'prompt' })
  assert.deepEqual(requests.endTurn({ sessionId: 's1', reason: 'unrouted' }), [left])
  assert.deepEqual([requests.store.get(decided)?.status, requests.store.get(left)?.status, requests.store.get(left)?.failure], ['decided', 'failed', 'unrouted'])
  assert.equal(requests.store.get(elsewhere)?.status, 'received', 'another session\'s turn is its own')
  assert.equal((await requests.decide({ requestId: left, sessionId: 's1', plan: reply })).accepted, false, 'nothing is decided after its turn')
  assert.equal(requests.fail({ requestId: elsewhere, sessionId: 's1', reason: 'undelivered' }), false)
  assert.equal(requests.fail({ requestId: elsewhere, sessionId: 's2', reason: 'undelivered' }), true)
})

test('a turn that ends while its decision is carried out stops what was not sent yet; each such action fails with why', async () => {
  const log: string[] = []
  let release!: () => void
  const requests = testRequests({ tasks: { ...tasksDoing(log), start: ({ brief }) => new Promise(resolve => { log.push(`start:${brief}`); release = () => resolve({ taskId: 't-new' }) }) } })
  const id = requests.receive({ ...where, kind: 'prompt' })
  const plan = { goals: [{ goal: '简报', disposition: 'delegate' }, { goal: '补充', disposition: 'update_task' }],
    actions: [{ kind: 'start', brief: '做今日简报' }, { kind: 'message', taskId: 't1', text: '加科技新闻' }] }
  const decided = requests.decide({ requestId: id, sessionId: 's1', plan })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.endTurn({ sessionId: 's2', reason: 'cancelled' }), [], 'another session\'s turn stops nothing here')
  requests.endTurn({ sessionId: 's1', reason: 'cancelled' })
  release()
  const result = await decided
  assert.ok(result.accepted)
  assert.deepEqual(result.receipts.map(receipt => [receipt.kind, receipt.ok]), [['start', true], ['message', false]], 'the start already under way finishes')
  assert.deepEqual(log, ['start:做今日简报'], 'the message is never sent')
  assert.match(String((result.receipts[1] as { error: string }).error), /本轮已结束/)
  assert.deepEqual(requests.store.actions(id).map(action => action.status), ['done', 'failed'])
  const next = requests.receive({ ...where, kind: 'prompt' })
  const again = requests.decide({ requestId: next, sessionId: 's1', plan })
  await new Promise(resolve => setImmediate(resolve))
  release()
  const later = await again
  assert.deepEqual(later.accepted ? later.receipts.map(receipt => receipt.ok) : later.reason, [true, true])
  assert.deepEqual(log.slice(1), ['start:做今日简报', 'message:t1:加科技新闻:/work'], 'a later turn\'s decision is carried out in full')
})

test('in the app database each change has its event, ids and kinds only; a relaunch fails the undecided and never redoes an action', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requests-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'app.db')
  const open = (tasks: RequestTasks) => {
    const app = openAppDb({ file })
    const core = createEventCore({ app, publish: () => {} })
    return { app, core, requests: createRequestRuntime({ store: createRequestStore({ db: app.db }), apply: core.apply, tasks }) }
  }
  let release!: () => void
  const first = open({ ...tasksDoing([]), start: () => new Promise(resolve => { release = () => resolve({ taskId: 't-late' }) }) })
  const asked = first.requests.receive({ ...where, kind: 'prompt' })
  const left = first.requests.receive({ ...where, kind: 'interjection' })
  void first.requests.decide({ requestId: asked, sessionId: 's1', plan: { goals: [{ goal: '机密的简报内容', disposition: 'delegate' }], actions: [{ kind: 'start', brief: '机密的简报内容' }] } })
  await new Promise(resolve => setImmediate(resolve))
  const events = first.core.since(0)
  assert.deepEqual(events.map(event => event.kind), ['request.received', 'request.received', 'request.decided'])
  assert.doesNotMatch(JSON.stringify(events), /机密/)
  assert.equal(first.requests.noteFast({ requestId: left, sessionId: 's1', outcome: 'deferred', reason: 'model', ms: 1400 }), true)
  assert.equal(first.requests.noteFast({ requestId: left, sessionId: 'other', outcome: 'handed', reason: null, ms: 1 }), false, 'another session\'s request: nothing kept')
  assert.deepEqual(first.core.since(events.at(-1)!.seq).map(event => [event.kind, event.data]), [['request.fast', { requestId: left, outcome: 'deferred', reason: 'model', ms: 1400 }]])
  first.app.close()
  release()

  const log: string[] = []
  const second = open(tasksDoing(log))
  assert.deepEqual(second.requests.recover(), { failed: 1, uncertain: 1 })
  const store = createRequestStore({ db: second.app.db })
  assert.deepEqual([store.get(left)?.status, store.get(left)?.failure], ['failed', 'interrupted'])
  assert.deepEqual(store.actions(asked).map(action => action.status), ['uncertain'])
  assert.deepEqual(log, [], 'an action whose receipt was lost is not sent again')
  assert.deepEqual(second.requests.recover(), { failed: 0, uncertain: 0 })
  second.app.close()
})

test('the app binds a main session and waits for the plugin; decisions go to the runtime and are answered', async () => {
  const sent: Array<Record<string, unknown>> = []
  const requests = testRequests()
  const desk = createRoutingDesk({ send: message => sent.push(message as Record<string, unknown>), handlers: requests, timeoutMs: 20 })
  const bound = desk.bind('s1')
  desk.receive({ type: 'routing_bound', version: 1, id: sent[0]!.id })
  await bound
  await assert.rejects(desk.bind('s1'), /准备好|ready/, 'no plugin answering: the prompt does not go unnarrowed')
  const id = requests.receive({ ...where, kind: 'prompt' })
  desk.receive({ type: 'routing_decide', version: 1, id: 'd1', sessionId: 's1', requestId: id, plan: reply })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent.at(-1), { type: 'routing_decided', version: 1, id: 'd1', accepted: true, receipts: [{ kind: 'reply', ok: true }] })
  const pending = desk.bind('s1')
  desk.close()
  await assert.rejects(pending)
})


test('a range erasure removes only dependent routing plans and prevents late receipts or remaining actions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requests-erasure-')), file = path.join(dir, 'app.db')
  const app = openAppDb({ file })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const { db } = app
  const history = openHistoryDb({ db }), store = createRequestStore({ db })
  const core = createEventCore({ app, publish() {} })
  const sourceId = randomUUID(), erasedText = 'ERASEDROUTEBRIEF27', independentText = 'Retained adjacent detail'
  const original = erasedText + independentText, after = ' '.repeat(erasedText.length) + independentText
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const effect: MemoryHostEffect = { effectId: randomUUID(), causeOperationId: randomUUID(), revision: 1,
    kind: 'erase-file-copies', hostNamespace: 'viva', sources: [{ namespace: 'canonical', sourceId, revision: 1 }],
    ranges: [{ sourceId, revision: 1, length: original.length, hash: hash(original), afterHash: hash(after),
      spans: [{ start: 0, end: erasedText.length }] }] }
  const evidence = (start: number, end: number): MemoryProvenance => ({
    epoch: 0, turnOnly: false, sources: [sourceId], fileSources: [sourceId],
    files: [{ workspace: 'a'.repeat(64), id: 'digest', path: 'digest/wiki/example.md', revision: 'r1',
      usageVersion: 1, policyToken: 'current', sourceRanges: [{ sourceId, spans: [{ start, end }] }] }],
  })
  let complete!: (value: { taskId: string }) => void
  let began!: () => void
  const running = new Promise<void>(resolve => { began = resolve })
  let messages = 0
  const requests = createRequestRuntime({ store, apply: core.apply, evidenceErased: history.evidenceErased, tasks: {
    start: (_task, place) => new Promise(resolve => {
      assert.deepEqual(place.memory, evidence(0, erasedText.length))
      complete = resolve
      began()
    }),
    message: async () => { messages++; return {} },
    stop: async () => { throw new Error(erasedText) },
  } })
  const affectedId = requests.receive({ ...where, kind: 'prompt' })
  const unaffectedId = requests.receive({ ...where, kind: 'prompt' })
  const unaffected = { goals: [{ goal: independentText, disposition: 'answer' }], actions: [{ kind: 'reply', scope: independentText }] }
  assert.equal((await requests.decide({ requestId: unaffectedId, sessionId: 's1', plan: unaffected },
    evidence(erasedText.length, original.length))).accepted, true)
  const affected = { goals: [
    { goal: erasedText, disposition: 'stop_task' }, { goal: erasedText, disposition: 'delegate' }, { goal: erasedText, disposition: 'update_task' },
  ], actions: [
    { kind: 'stop', taskId: 't-old' }, { kind: 'start', brief: erasedText }, { kind: 'message', taskId: 't-old', text: erasedText },
  ] }
  const proof = evidence(0, erasedText.length)
  const decision = requests.decide({ requestId: affectedId, sessionId: 's1', plan: affected }, proof)
  await running
  assert.equal(store.actions(affectedId)[0]?.error, erasedText, 'a previously returned action error is also a stored replica')
  const call: HostMemoryCaller = async method => {
    assert.equal(method, 'pendingHostEffects')
    return [effect] as HostMemoryApi[typeof method]['output']
  }
  const host = createMemoryHostEffects({ db, call, apply: core.apply, invalidate() {},
    eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges, eraseRoutedMemory: requests.eraseMemory })
  t.after(() => host.close())
  await host.recover()
  complete({ taskId: 't-late' })
  assert.equal((await decision).accepted, false)
  assert.equal(messages, 0)
  assert.deepEqual(store.actions(affectedId).map(({ status, error, taskId }) => [status, error, taskId]),
    [['failed', null, null], ['uncertain', null, null], ['uncertain', null, null]])
  const plans = db.prepare('SELECT plan FROM routing_decisions').all()
  assert.deepEqual(plans.map(row => JSON.parse(String(row.plan))), [unaffected])
  const lateId = requests.receive({ ...where, kind: 'prompt' })
  assert.equal((await requests.decide({ requestId: lateId, sessionId: 's1', plan: affected }, proof)).accepted, false)
  await host.recover()
  for (const replica of [file, file + '-wal']) {
    assert.equal(fs.readFileSync(replica).includes(Buffer.from(erasedText)), false)
  }
})
