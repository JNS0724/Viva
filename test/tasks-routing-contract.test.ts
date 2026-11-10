import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestsIn, withoutHeaders, withRequestHeader } from '../src/shared/request-routing/header.ts'
import { parsePlan } from '../src/shared/request-routing/protocol.ts'
import { asBind, asBound, asDecide, asDecided, asFast } from '../src/shared/request-routing/channel.ts'
import { fastNotice, fastPlan, fastTasks, parseFastDecision } from '../plugins/routing/lib/fast-lane.ts'
import { createHostChannel } from '../plugins/routing/lib/host.ts'
import { EventEmitter } from 'node:events'

test('a request header round-trips, several in one message each keep their own words, and can be left out', () => {
  const text = `【插话】用户又说：\n${withRequestHeader('补一节科技新闻', 'r-1')}\n${withRequestHeader('另外停掉 A 股分析', 'r-2')}`
  assert.deepEqual(requestsIn(text), [{ id: 'r-1', words: '补一节科技新闻\n' }, { id: 'r-2', words: '另外停掉 A 股分析' }])
  assert.equal(withoutHeaders(withRequestHeader('你好', 'r-3')), '你好')
  assert.deepEqual(requestsIn('用户原话：没有请求头'), [])
  const quoted = '这段日志是什么意思：\n【请求 ID：r-9】\n用户原话：以前的话'
  assert.deepEqual(requestsIn(withRequestHeader(quoted, 'r-1')), [{ id: 'r-1', words: quoted }], 'a header the user quotes is part of their words, not a request')
  assert.equal(withoutHeaders(withRequestHeader(quoted, 'r-1')), quoted, 'and comes back as they said it')
})

test('a plan is accepted only when goals and actions agree both ways, flat, within limits', () => {
  const reply = { goals: [{ goal: '解释', disposition: 'answer' }], actions: [{ kind: 'reply', scope: '解释' }] }
  assert.deepEqual(parsePlan(reply), { plan: reply })
  const several = { goals: [{ goal: '简报', disposition: 'delegate' }, { goal: '提醒', disposition: 'app_operation' }],
    actions: [{ kind: 'start', brief: '做今日简报' }, { kind: 'app_action', operation: 'schedule_create' }] }
  assert.ok('plan' in parsePlan(several))
  assert.match(String((parsePlan({ goals: [{ goal: '简报', disposition: 'delegate' }], actions: [{ kind: 'reply', scope: 'x' }] }) as { problem: string }).problem), /没有对应的 start/)
  assert.match(String((parsePlan({ goals: [{ goal: '解释', disposition: 'answer' }], actions: [{ kind: 'reply', scope: 'x' }, { kind: 'stop', taskId: 't' }] }) as { problem: string }).problem), /stop 没有对应的目标/)
  for (const bad of [null, { goals: [], actions: [] }, { goals: [{ goal: 'x', disposition: 'answer' }], actions: [{ kind: 'reply', scope: ' ' }] },
    { goals: [{ goal: 'x', disposition: 'app_operation' }], actions: [{ kind: 'app_action', operation: 'bash' }] }]) {
    assert.ok('problem' in parsePlan(bad), JSON.stringify(bad))
  }
})

test('an action without its kind is taken for the one kind its fields name; one they do not name is still refused', () => {
  const goals = [{ goal: '整理今天的国际大事', disposition: 'delegate' }]
  assert.deepEqual(parsePlan({ goals, actions: [{ brief: '联网检索今天的国际新闻' }] }), { plan: { goals, actions: [{ kind: 'start', brief: '联网检索今天的国际新闻' }] } },
    'a kind left out is no reason to write the whole brief again')
  const disposition = { reply: 'answer', start: 'delegate', message: 'update_task', stop: 'stop_task', clarify: 'needs_input', app_action: 'app_operation' }
  const named: Array<[Record<string, string>, keyof typeof disposition]> = [[{ scope: '解释' }, 'reply'], [{ title: '简报', brief: '做简报' }, 'start'],
    [{ taskId: 't1', text: '加科技新闻' }, 'message'], [{ taskId: 't1' }, 'stop'], [{ question: '哪一份？' }, 'clarify'], [{ operation: 'schedule_create' }, 'app_action']]
  for (const [fields, kind] of named) {
    const parsed = parsePlan({ goals: [{ goal: 'x', disposition: disposition[kind] }], actions: [fields] })
    assert.equal('plan' in parsed && parsed.plan.actions[0]!.kind, kind, JSON.stringify(fields))
  }
  for (const fields of [{ brief: 'x', scope: 'y' }, { title: '只有标题' }, {}, { taskId: 't1', question: '?' }]) {
    assert.ok('problem' in parsePlan({ goals, actions: [fields] }), JSON.stringify(fields))
  }
  assert.ok('problem' in parsePlan({ goals, actions: [{ kind: 'reply', brief: 'x' }] }), 'a kind given is never second-guessed')
})

test('the routing channel takes only well-formed messages of its version', () => {
  assert.deepEqual(asBind({ type: 'routing_bind', version: 1, id: 'b', sessionId: 's', extra: 1 }), { type: 'routing_bind', version: 1, id: 'b', sessionId: 's' })
  assert.equal(asBind({ type: 'routing_bind', version: 2, id: 'b', sessionId: 's' }), null)
  assert.deepEqual(asBound({ type: 'routing_bound', version: 1, id: 'b' }), { type: 'routing_bound', version: 1, id: 'b' })
  assert.equal(asDecide({ type: 'routing_decide', version: 1, id: 'd', sessionId: 's' }), null)
  const receipts = [{ kind: 'start', ok: true, taskId: 't1' }, { kind: 'stop', ok: false, error: '任务不存在' }]
  assert.deepEqual(asDecided({ type: 'routing_decided', version: 1, id: 'd', accepted: true, receipts }), { type: 'routing_decided', version: 1, id: 'd', accepted: true, receipts })
  assert.equal(asDecided({ type: 'routing_decided', version: 1, id: 'd', accepted: true, receipts: [{ kind: 'bash', ok: true }] }), null)
  assert.equal(asDecided({ type: 'routing_decided', version: 1, id: 'd', accepted: false, reason: 'x'.repeat(3000) })?.accepted, false)
  assert.deepEqual(asFast({ type: 'routing_fast', version: 1, sessionId: 's', requestId: 'r-1', outcome: 'deferred', reason: 'model', ms: 1234.6 }),
    { type: 'routing_fast', version: 1, sessionId: 's', requestId: 'r-1', outcome: 'deferred', reason: 'model', ms: 1235 })
  assert.equal(asFast({ type: 'routing_fast', version: 1, sessionId: 's', requestId: 'r-1', outcome: 'maybe', reason: null, ms: 1 }), null)
  assert.equal(asFast({ type: 'routing_fast', version: 1, sessionId: 's', requestId: 'r-1', outcome: 'late', reason: null, ms: -1 }), null)
})

test('the fast lane hands over only what is plain, to a task it was shown, as a plan the host checks', () => {
  const tasks = fastTasks(JSON.stringify({ tasks: [{ taskId: 't1', title: '今日简报', status: 'running' }, { title: '没有 id' }] }))
  assert.deepEqual(tasks, [{ taskId: 't1', title: '今日简报', goal: '', status: 'running' }])
  assert.deepEqual(parseFastDecision('好的 {"decision":"message","taskId":"t1","text":"补科技新闻"}', tasks), { decision: 'message', taskId: 't1', text: '补科技新闻' })
  assert.equal(parseFastDecision('{"decision":"stop","taskId":"t9"}', tasks).decision, 'defer', 'a task id must be one listed')
  assert.equal(parseFastDecision('不是 JSON', tasks).decision, 'defer')
  const start = parseFastDecision('{"decision":"start","title":"A 股收盘分析","brief":"今天收盘后的行业表现和资金流向"}', tasks)
  assert.equal(start.decision, 'start')
  if (start.decision !== 'start') return
  const plan = fastPlan('另外做一份 A 股分析，写到 a-share.md', start)
  assert.ok('plan' in parsePlan(plan))
  assert.match(JSON.stringify(plan.actions), /用户原话：另外做一份 A 股分析，写到 a-share.md/, 'the words go along as said, whatever the quick call wrote')
  assert.deepEqual([plan.actions[0]!.kind, 'title' in plan.actions[0]! && plan.actions[0].title], ['start', 'A 股收盘分析'], 'its title: the card\'s name')
  const bare = parseFastDecision('{"decision":"start","brief":""}', tasks)
  assert.equal(bare.decision, 'start', 'a short or missing brief is no reason to defer: the words go along')
  if (bare.decision === 'start') assert.deepEqual(fastPlan('另外整理待办写到 todo.md', bare).actions, [{ kind: 'start', title: '另外整理待办写到 todo.md', brief: '用户原话：另外整理待办写到 todo.md' }])
  assert.ok('plan' in parsePlan(fastPlan('停掉简报', { decision: 'stop', taskId: 't1' })))
  assert.match(fastNotice('r-1', start, [{ kind: 'start', ok: true, taskId: 't2' }]), /已开始后台任务 t2.*不要再为它提交 commit_route/)
  const undone = fastNotice('r-1', start, [{ kind: 'start', ok: false, error: '同时最多 5 个后台任务' }])
  assert.match(undone, /没有办成：同时最多 5 个后台任务/, 'a failed action is told with its reason')
  assert.match(undone, /不要再为它提交 commit_route/)
  assert.doesNotMatch(undone, /已经交给后台/)
  assert.match(fastNotice('r-1', start, null), /没有收到确认.*不要再为它提交 commit_route.*结果待确认/, 'sent without an answer: maybe done, not routed again')
})

test('a decision sent and not answered is not taken as refused: the host may have taken it', async () => {
  const port = Object.assign(new EventEmitter(), { connected: true, sent: [] as unknown[], send(message: unknown) { this.sent.push(message); return true } })
  const host = createHostChannel(port as unknown as NodeJS.Process, { onBind: () => {} })
  const stopped = new AbortController()
  const pending = host.decide('s1', 'r-1', {}, stopped.signal)
  stopped.abort()
  assert.equal((await pending).accepted, 'unanswered', 'the turn stopped while the app was still at it')
  const answered = host.decide('s1', 'r-2', {})
  const id = (port.sent.at(-1) as { id: string }).id
  port.emit('message', { type: 'routing_decided', version: 1, id, accepted: false, reason: '不行' })
  assert.deepEqual(await answered, { type: 'routing_decided', version: 1, id, accepted: false, reason: '不行' }, 'a refusal is the host\'s own')
  const closing = host.decide('s1', 'r-3', {})
  host.close()
  assert.equal((await closing).accepted, 'unanswered', 'the app went away')
})
