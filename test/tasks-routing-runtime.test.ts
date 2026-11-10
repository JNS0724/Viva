import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { createRequestStore } from '../src/backend/request-store.ts'
import { createRequestRuntime, type RequestTasks } from '../src/backend/request-runtime.ts'
import { createRoutingDesk } from '../src/backend/routing-channel.ts'
import { testRequests } from './fixtures/request-routing.ts'

const reply = { goals: [{ goal: '解释', disposition: 'answer' }], actions: [{ kind: 'reply', scope: '解释' }] }
const where = { sessionId: 's1', conversationId: 'c1', cwd: '/work' }

function tasksDoing(log: string[]): RequestTasks {
  return {
    start: async (brief, place) => { log.push(`start:${brief}:${place.conversationId}`); return { taskId: 't-new' } },
    message: async (taskId, text, cwd) => { log.push(`message:${taskId}:${text}:${cwd}`); return {} },
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
  assert.deepEqual(log, ['start:做今日简报:c1', 'message:t1:加科技新闻:/work', 'stop:t2'], 'in order, in the request\'s conversation and folder')
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
