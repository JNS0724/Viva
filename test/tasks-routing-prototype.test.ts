import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { APP_PLUGINS, PERSONA } from '../src/backend/app-plugins.ts'
import { createRoutingDesk, fastLaneEnabled, routingEnabled, routingPersona, routingPlugins, withRequestHeader } from '../src/backend/routing-prototype.ts'
import { parsePlan, planProblem } from '../src/shared/request-routing/protocol.ts'
import { fastInput, fastNotice, parseFastDecision } from '../plugins/routing/lib/fast-lane.ts'
import { requestsIn, withoutHeaders } from '../src/shared/request-routing/header.ts'

test('routing is off unless VIVA_ROUTING=1, and the fast lane needs routing on', () => {
  assert.equal(routingEnabled({}), false)
  assert.equal(routingEnabled({ VIVA_ROUTING: 'true' }), false)
  assert.equal(routingEnabled({ VIVA_ROUTING: '1' }), true)
  assert.equal(fastLaneEnabled({ VIVA_ROUTING_FAST: '1' }), false)
  assert.equal(fastLaneEnabled({ VIVA_ROUTING: '1', VIVA_ROUTING_FAST: '1' }), true)
})

test('the request header carries the id and keeps the words as they were, and the plugin reads it back', () => {
  assert.deepEqual(requestsIn(withRequestHeader('把纪要整理成简报\n第二行', 'r-abc123')), [{ id: 'r-abc123', words: '把纪要整理成简报\n第二行' }])
})

test('one message can carry two requests, their words kept apart', () => {
  assert.deepEqual(requestsIn(withRequestHeader('做简报', 'r-1')), [{ id: 'r-1', words: '做简报' }])
  const two = `【插话】你还在处理用户之前交代的事时，用户又说了下面这句（原话）：\n${withRequestHeader('另外整理待办', 'r-2')}\n${withRequestHeader('再加风险', 'r-3')}`
  assert.deepEqual(requestsIn(two).map((r) => [r.id, r.words.trim()]), [['r-2', '另外整理待办'], ['r-3', '再加风险']])
  assert.equal(withoutHeaders(withRequestHeader('做简报', 'r-1')), '做简报')
})

test('routing swaps viva-stream for viva-routing and leaves the other plugins and the persona suffix alone', () => {
  const swapped = routingPlugins(APP_PLUGINS, true)
  assert.equal(swapped.length, APP_PLUGINS.length)
  assert.ok(!swapped.some((plugin) => plugin.name === 'viva-stream'))
  const routing = swapped.find((plugin) => plugin.name === 'viva-routing')
  assert.equal(routing?.contract, 'stream')
  assert.deepEqual(routing?.config({ userData: '/u', permission: 'workspace-write' }), { evidence: path.join('/u', 'routing-evidence.jsonl'), fast: true })
  assert.deepEqual(swapped.filter((plugin) => plugin.name !== 'viva-routing'), APP_PLUGINS.filter((plugin) => plugin.name !== 'viva-stream'))
  const persona = routingPersona(PERSONA)
  assert.ok(persona.prefix.startsWith(PERSONA.prefix) && persona.prefix.includes('commit_route'))
  assert.equal(persona.suffix, PERSONA.suffix)
})

test('the role binding resolves on the plugin\'s confirmation, and gives up after its wait', async () => {
  const sent: Array<{ id: string }> = []
  const desk = createRoutingDesk({ send: (message) => sent.push(message as { id: string }), timeoutMs: 50 })
  const bound = desk.bind('s-1')
  desk.receive({ type: 'routing_bound', version: 1, id: sent[0].id, ok: true })
  assert.equal(await bound, true)
  assert.equal(await desk.bind('s-2'), false)
})

test('a plan is accepted only when goals and actions agree both ways', () => {
  const start = { kind: 'start' as const, brief: '把三份会议纪要整理成今天的工作简报，写到 brief.md。' }
  assert.ok('plan' in parsePlan({ goals: [{ goal: '做简报', disposition: 'delegate' }], actions: [start] }))
  const asReply = parsePlan({ goals: [{ goal: '做简报', disposition: 'delegate' }], actions: [{ kind: 'reply', scope: '简报' }] })
  assert.ok('problem' in asReply && /delegate/.test(asReply.problem))
  const questionInReply = parsePlan({ goals: [{ goal: '选哪份报告', disposition: 'needs_input' }], actions: [{ kind: 'reply', scope: '问用户' }] })
  assert.ok('problem' in questionInReply && /clarify/.test(questionInReply.problem))
  assert.match(planProblem({ goals: [{ goal: '解释', disposition: 'answer' }], actions: [{ kind: 'reply', scope: '解释' }, start] }) ?? '', /start 没有对应的目标/)
  assert.ok('problem' in parsePlan({ goals: [], actions: [start] }))
  assert.ok('problem' in parsePlan({ goals: [{ goal: 'x', disposition: 'delegate' }], actions: [{ kind: 'start', brief: '太短' }] }))
  // An app operation names only its tool; its arguments go to the tool's own call, so the plan stays flat.
  assert.ok('plan' in parsePlan({ goals: [{ goal: '每周五提醒', disposition: 'app_operation' }], actions: [{ kind: 'app_action', operation: 'schedule_create' }] }))
  assert.ok('problem' in parsePlan({ goals: [{ goal: '跑命令', disposition: 'app_operation' }], actions: [{ kind: 'app_action', operation: 'bash' }] }))
  const withArgs = parsePlan({ goals: [{ goal: '每周五提醒', disposition: 'app_operation' }], actions: [{ kind: 'app_action', operation: 'schedule_create', args: { title: 'x' } }] })
  assert.ok('plan' in withArgs)
  assert.deepEqual(withArgs.plan.actions, [{ kind: 'app_action', operation: 'schedule_create' }], 'arguments passed in the plan are dropped, never carried')
})

test('the fast lane acts only on a clear decision, and only on a task it was shown', () => {
  const tasks = [{ taskId: 't-1', title: '简报' }]
  assert.equal(parseFastDecision('好的：{"decision":"start","brief":"把 notes 里的待办整理成表格写到 todo.md，列出负责人和截止时间。"}', tasks).decision, 'start')
  assert.equal(parseFastDecision('{"decision":"message","taskId":"t-1","text":"加一节风险"}', tasks).decision, 'message')
  assert.deepEqual(parseFastDecision('{"decision":"stop","taskId":"t-9"}', tasks), { decision: 'defer', reason: 'unknown task' })
  assert.equal(parseFastDecision('我觉得应该开个任务', tasks).decision, 'defer')
  assert.equal(parseFastDecision('{"decision":"start","brief":"短"}', tasks).decision, 'defer')
  assert.equal(parseFastDecision('{not json}', tasks).decision, 'defer')
})

test('the fast lane reads the recent turns, the tasks and the words, and its notice says not to route again', () => {
  const input = fastInput({ recent: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: `第${i}句` })), tasks: [], words: '另外整理待办' })
  assert.ok(input.includes('第19句') && !input.includes('第7句') && input.includes('（无）') && input.endsWith('另外整理待办'))
  const notice = fastNotice('r-1', { decision: 'start', brief: 'x'.repeat(30) }, { ok: true, taskId: 't-2' })
  assert.ok(notice.startsWith('【调度已处理】请求 r-1') && notice.includes('不要再为它提交 commit_route'))
})
