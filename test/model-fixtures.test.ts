import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { memoryRequest } from '../src/memory/contracts/memory-contract.ts'
import { withRequestHeader } from '../src/shared/request-routing/header.ts'
import { CITY_QUESTION, decide, routeFixtureTools, startFakeLlm } from './fixtures/fake-llm.ts'
import { eventually } from './fixtures/eventually.ts'

const human = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const result = (name: string, input: object, value: unknown) => ({ messages: [human('处理这项请求'),
  { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify(value) }] }] },
] })

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

test('file clarification follows its opaque ref and free text without a hardcoded relation', () => {
  const ref = randomUUID(), answer = '图书馆此次采用北门入口。'
  assert.deepEqual(decide(result('memory_recall', { query: '入口' }, { clarification: { ref } })).tool,
    { name: 'memory_clarify', input: { ref } })
  assert.equal(decide(result('memory_clarify', { ref }, { status: 'answered', answer: { answers: [{ id: randomUUID(), custom: answer, selected: [] }] } })).text,
    `这次采用：${answer}`)
  assert.equal(decide(result('memory_recall', { query: '入口' }, { conflicts: [{ id: 1, ref }] })).tool, undefined)
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
