import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { memoryRequest } from '../src/memory/contracts/memory-contract.ts'
import { withRequestHeader } from '../src/shared/request-routing/header.ts'
import { CITY_QUESTION, decide, questionOf, routeFixtureTools, startFakeLlm } from './fixtures/fake-llm.ts'
import { currentTurnTextParts } from './fixtures/model-user-text.ts'
import { eventually } from './fixtures/eventually.ts'

const human = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const result = (name: string, input: object, value: unknown) => ({ messages: [human('处理这项请求'),
  { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify(value) }] }] },
] })

test('a recovered task selects its real brief after provider-converted system messages', () => {
  // Windows native trace: recovery user #6, persona system #8, real user #9,
  // runtime/skill user #10–11, profile #12. The provider converts the late system
  // message to a user-role system-reminder because recovery already began history.
  const history = 'The previous generated context has been retired.\n[Earlier user message 1]\nretired text\n[End of earlier user messages]\n'
  const persona = '<system-reminder>\nYou are an AI agent powered by DeepSeek Harness.\n</system-reminder>'
  const runtime = '<system-reminder>\nCurrent working directory: synthetic-workspace.\n</system-reminder>'
  const skills = '<system-reminder>\n<available_skills>synthetic catalog</available_skills>\n</system-reminder>'
  const brief = '核对任意任务的原文，不依赖任务名称。'
  const delivered = brief
  const blocks = [history, persona, delivered, runtime, skills, '<about-user>profile']
  const layouts = [blocks.map(human), [{ role: 'user', content: blocks.map(text => ({ type: 'text', text })) }],
    [human(`${history}${persona}\n${delivered}`), human(runtime), human(skills)]]
  for (const messages of layouts) {
    assert.equal(questionOf(messages), brief)
    assert.ok(decide({ messages }).text?.endsWith(`收到：「${brief}」`))
  }
})

test('a recovered foreground request still routes the exact pending task message', () => {
  const words = '向已存在的任务补充新资料', taskId = randomUUID(), text = '保留这次转告的任意原文'
  const respond = routeFixtureTools((request: { messages: Parameters<typeof questionOf>[0] }) => questionOf(request.messages) === words
    ? { tool: { name: 'message_background_task', input: { taskId, text } } } : null)
  const messages = [human('The previous generated context has been retired.\n[End of earlier user messages]\n'),
    human('<system-reminder>\nSynthetic mid-history persona.\n</system-reminder>'), human(withRequestHeader(words, 'pending-forward')),
    human('<system-reminder>\nSynthetic runtime notice.\n</system-reminder>')]
  const reply = respond({ messages, tools: [{ name: 'commit_route' }] })
  assert.equal(reply?.tool?.name, 'commit_route')
  const route = reply?.tool?.input
  assert.ok(route && 'actions' in route && 'requestId' in route)
  assert.deepEqual(route.actions, [{ kind: 'message', taskId, text }])
  assert.equal(route.requestId, 'pending-forward')
})

test('fixture reminder filtering preserves ordinary text, quoted markers and incomplete frames', () => {
  for (const text of ['Ordinary task text', 'Please quote <system-reminder> literally.',
    '<system-reminder>\nIncomplete text', 'A user quotation:\n<system-reminder>\nquoted text\n</system-reminder>',
    '<system-reminder>\nAn incomplete user example.\n<system-reminder>\nHost runtime context.\n</system-reminder>']) {
    assert.deepEqual(currentTurnTextParts([text]), [text])
  }
  assert.deepEqual(currentTurnTextParts(['<system-reminder>\nRuntime notice.\n</system-reminder>']), [])
})

test('the fake model continues a requested clarification past a refreshed context after the tool result', () => {
  const reply = decide({
    tools: [{ name: 'ask_user_question' }],
    messages: [
      human('接入演示服务，再问我城市'),
      { role: 'assistant', content: [{ type: 'tool_use', name: 'viva_mcp_add', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'denied' }] },
      human('<system-reminder>\nThe following information replaces the earlier memory context.\n</system-reminder>'),
    ],
  })
  assert.deepEqual(reply.tool, { name: 'ask_user_question', input: { questions: [CITY_QUESTION] } })
})

test('the common fake emits exact text-only file remember and arbitrary recall inputs', () => {
  for (const text of ['我加入读书会，同时仍在支付组。', 'The new marker is moonstone-47.', '今週は木曜日に資料を送ります。']) {
    const answer = decide({ messages: [human(`记住：${text}`)] })
    assert.deepEqual(answer.tool, { name: 'memory_remember', input: { text } })
    assert.deepEqual(memoryRequest.parse({ op: 'remember', session: 'fixture', ...answer.tool!.input }), { op: 'remember', session: 'fixture', text })
    assert.deepEqual(decide({ messages: [human(`查一下 ${text}`)] }).tool, { name: 'memory_recall', input: { query: text } })
  }
})

test('current accepted file receipts finish the tool turn without the removed fact result vocabulary', () => {
  const text = '保留图书馆的无障碍入口安排。', receipt = { status: 'accepted', id: randomUUID(), revision: 'exact-file-revision' }
  for (const value of [receipt, { text: JSON.stringify(receipt) }]) {
    assert.equal(decide(result('memory_remember', { text }, value)).text, `好的，我记住了：${text}`)
  }
  assert.match(decide(result('memory_remember', { text }, { status: 'unavailable' })).text ?? '', /^没能记住/u)
  assert.match(decide(result('memory_remember', { text }, { id: 1, result: '已记住' })).text ?? '', /^没能记住/u)
  assert.match(decide(result('memory_recall', { query: '图书馆' }, { notes: [{ id: randomUUID(), text }] })).text ?? '', /图书馆的无障碍/u)
})

test('the shared fake no longer simulates removed extraction, review or predicate classification', () => {
  for (const system of ['记忆整理员', '记忆变更复核员', '从已核验的记忆和用户手填资料中，选择最多六条']) {
    const answer = decide({ system, messages: [human('{"user":"任意原文","proposals":[],"items":[]}')] })
    assert.match(answer.text ?? '', /^收到/u)
  }
  const source = readFileSync(new URL('./fixtures/fake-llm.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /report_email|KNOWN_NAMES|keywords|predicate|MEMORY_REVIEWER|MEMORY_PROFILER|function extract\(/u)
  assert.equal(existsSync(new URL('./fixtures/fake-llm.js', import.meta.url)), false)
})

test('the common routing wrapper still grants the chosen app action and preserves unrelated fixture behaviors', () => {
  const words = '记住：保留任意字段和原始条件', request = { tools: [{ name: 'commit_route' }], messages: [human(withRequestHeader(words, 'fixture-request'))] }
  const respond = routeFixtureTools(decide), route = respond(request)
  assert.equal(route?.tool?.name, 'commit_route')
  const messages = [...request.messages, { role: 'assistant', content: [{ type: 'tool_use', name: 'commit_route', input: route!.tool!.input }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'accepted' }] }]
  assert.deepEqual(respond({ ...request, messages })?.tool, { name: 'memory_remember', input: { text: words.slice(3) } })
  assert.equal(decide({ tools: [{ name: 'mail__send_email' }], messages: [human('发邮件说明活动安排')] }).tool?.name, 'mail__send_email')
  assert.match(decide(result('ask_user_question', {}, { answers: [{ id: CITY_QUESTION.id, custom: '广州', selected: [] }] })).text ?? '', /广州/u)
  assert.equal(decide({ system: 'REVIEW_POLICY', messages: [human('rm -rf old')] }).text,
    JSON.stringify({ risk: 'medium', decision: 'deny', reason: '要删除原有的文件' }))
})

test('a late native report after a route result does not drop the chosen fixture app action', () => {
  const words = '任意标题的定时汇总', action = { tool: { name: 'schedule_create', input: { title: words, prompt: '合成汇总', kind: 'at', at: '2030-01-01T00:00:00.000Z' } } }
  const request = { tools: [{ name: 'commit_route' }], messages: [human(withRequestHeader(words, 'late-report-action'))] }
  const respond = routeFixtureTools((value: { messages: Parameters<typeof questionOf>[0] }) => questionOf(value.messages) === words ? action : null)
  const route = respond(request)
  assert.equal(route?.tool?.name, 'commit_route')
  const messages = [...request.messages, { role: 'assistant', content: [{ type: 'tool_use', name: 'commit_route', input: route!.tool!.input }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'accepted' }] },
    human('【后台任务结束】这不是用户说的话。\n任务：「独立任务」'), human('<about-user>synthetic profile')]
  assert.deepEqual(respond({ ...request, messages }), action)
  assert.equal(respond({ ...request, messages: [...messages, { role: 'assistant', content: [{ type: 'tool_use', name: 'schedule_create', input: action.tool.input }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'proposed' }] }] }), null, 'the cached action is consumed once')
})

test('a late native report after routing does not replace the generic remember operation', () => {
  const text = '此次持续安排保留原始条件', request = { tools: [{ name: 'commit_route' }], messages: [human(withRequestHeader(`记住：${text}`, 'late-report-remember'))] }
  const route = decide(request)
  assert.equal(route.tool?.name, 'commit_route')
  const messages = [...request.messages, { role: 'assistant', content: [{ type: 'tool_use', name: 'commit_route', input: route.tool!.input }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'accepted' }] }]
  const report = human('【后台任务结束】这不是用户说的话。\n任务：「独立任务」')
  assert.deepEqual(decide({ ...request, messages: [...messages, report, human('<about-user>synthetic profile')] }).tool,
    { name: 'memory_remember', input: { text } })
  assert.equal(decide({ ...request, messages: [...messages, { role: 'assistant', content: [{ type: 'text', text: '已经完成' }] }, report] }).tool,
    undefined, 'an earlier turn\'s result cannot resume an already completed action')
})

test('a new marked user request cannot consume an older cached app operation', () => {
  const first = '先前的合成定时任务', second = '后来的独立定时任务'
  const action = (title: string) => ({ tool: { name: 'schedule_create', input: { title } } })
  const respond = routeFixtureTools((value: { messages: Parameters<typeof questionOf>[0] }) => {
    const question = questionOf(value.messages)
    return [first, second].includes(question) ? action(question) : null
  })
  const request = { tools: [{ name: 'commit_route' }], messages: [human(withRequestHeader(first, 'previous-operation'))] }
  const route = respond(request)
  const messages = [...request.messages, { role: 'assistant', content: [{ type: 'tool_use', name: 'commit_route', input: route!.tool!.input }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'accepted' }] }, human(withRequestHeader(second, 'next-operation'))]
  const next = respond({ ...request, messages })
  assert.equal(next?.tool?.name, 'commit_route')
  const input = next?.tool?.input
  assert.ok(input && 'requestId' in input && 'actions' in input)
  assert.equal(input.requestId, 'next-operation')
  assert.deepEqual(input.actions, [{ kind: 'app_action', operation: 'schedule_create' }])
  assert.deepEqual(respond({ ...request, messages: [...messages, { role: 'assistant', content: [{ type: 'tool_use', name: 'commit_route', input: next!.tool!.input }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'accepted' }] }] }), action(second))
})

test('ordinary unmarked user input does not resume an older routed fixture operation', () => {
  for (const next of ['这是另一个未标记的新请求', '引用：<about-user>这是用户的正文', '请解释【后台任务结束】这个标记']) {
    const words = '记住：旧安排仍须准确引用', action = { tool: { name: 'schedule_create', input: { title: '旧定时任务' } } }
    const request = { tools: [{ name: 'commit_route' }], messages: [human(withRequestHeader(words, 'old-operation'))] }
    const respond = routeFixtureTools((value: { messages: Parameters<typeof questionOf>[0] }) => questionOf(value.messages) === words ? action : null)
    const route = respond(request)
    const messages = [...request.messages, { role: 'assistant', content: [{ type: 'tool_use', name: 'commit_route', input: route!.tool!.input }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'accepted' }] }, human(next)]
    assert.equal(respond({ ...request, messages }), null)
    assert.equal(decide({ ...request, messages }).tool, undefined)
  }
})

test('the native TypeScript fixture serves models, tool SSE, HTTP failures and held-response cancellation', async () => {
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const fake = await startFakeLlm({ decideFirst: raw => {
    const request = raw as { system?: string }
    return request.system === 'http-failure' ? { httpError: 429 } : request.system === 'hold' ? { text: 'late response', waitFor: held } : null
  } })
  try {
    const listed = await fetch(`${fake.url}/v1/models`).then(response => response.json()) as { data: Array<{ id: string }> }
    assert.equal(listed.data[0]?.id, 'deepseek-chat')
    const request = { messages: [human('记住：原始文件工具输入')], model: 'deepseek-chat' }
    const response = await fetch(`${fake.url}/v1/messages`, { method: 'POST', body: JSON.stringify(request) })
    const events = await response.text()
    assert.ok(events.includes('memory_remember'))
    assert.ok(events.includes(JSON.stringify({ text: '原始文件工具输入' }).replaceAll('"', '\\"')))
    assert.doesNotMatch(events, /keywords/u)
    const failed = await fetch(`${fake.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [], system: 'http-failure' }) })
    assert.equal(failed.status, 429)
    const controller = new AbortController(), pending = fetch(`${fake.url}/v1/messages`, { method: 'POST', signal: controller.signal,
      body: JSON.stringify({ messages: [], system: 'hold' }) })
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    assert.ok(await eventually(() => fake.requests.length === 3), 'the held HTTP request reaches the fixture before cancellation')
    controller.abort(); release(); await rejected
  } finally { release(); await fake.close() }
})
