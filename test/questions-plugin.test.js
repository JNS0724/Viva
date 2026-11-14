import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerFor, DECLINED } from '../plugins/questions/lib/channel.ts'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.js'
import { CITY_QUESTION } from './fixtures/fake-llm.js'

/**
 * The questions plugin inside the real dsh: a background task asks with ask_user_question, the app answers over IPC.
 * (The main conversation asks in text, through commit_route's clarify.)
 */

const questionOf = (events) => events.find((event) => event.type === 'task_question')
const taskReplies = (events, taskId) => replies(events.filter((event) => event.type === 'task_update' && event.taskId === taskId)).join('')

/** A task of the harness's agent, asked `words`; the turn, still going. */
async function ask(agent, words) {
  const task = await agent.startTask()
  assert.ok(task.ok && task.taskId, JSON.stringify(task))
  return { taskId: task.taskId, turn: agent.promptTask(task.taskId, words) }
}

test('a question reaches the app with its options, and the answer reaches the model', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()

  const { taskId, turn } = await ask(agent, '明天天气怎么样')
  const asked = await eventually(() => questionOf(events))
  assert.deepEqual(asked.questions, [{ ...CITY_QUESTION, multiSelect: false }])
  assert.equal(agent.answerQuestion(asked.questionId, [{ id: 'city', selected: [], custom: '杭州' }]), true)
  await turn

  assert.ok(taskReplies(events, taskId).includes('好的，按杭州来看：明天多云转晴。'))
  assert.equal(events.some((event) => event.type === 'permission'), false, 'asking needs no approval')
  const answered = llm.requests.findLast((request) => JSON.stringify(request.messages.at(-1)).includes('tool_result'))
  assert.match(JSON.stringify(answered.messages.at(-1)), /杭州/, 'the model got the answer as the tool result')
  assert.equal(agent.answerQuestion(asked.questionId, [{ id: 'city', selected: ['上海'] }]), false, 'an answered question is closed')
})

test('stopping the task\'s turn closes the question in the window', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()

  const { taskId, turn } = await ask(agent, '明天天气怎么样')
  const asked = await eventually(() => questionOf(events))
  await agent.cancelTask(taskId)
  await turn

  const closed = await eventually(() => events.find((event) => event.type === 'task_question_closed'))
  assert.equal(closed?.questionId, asked.questionId)
  assert.equal(events.find((event) => event.type === 'task_end' && event.taskId === taskId)?.stopReason, 'cancelled')
})

test('a question left behind by closing its task is closed, and no city is made up', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()

  const { taskId, turn } = await ask(agent, '明天天气怎么样')
  await eventually(() => questionOf(events))
  await agent.closeTask(taskId)
  await turn.catch(() => {})

  assert.ok(await eventually(() => events.some((event) => event.type === 'task_question_closed')))
  assert.doesNotMatch(JSON.stringify(llm.requests.at(-1) ?? {}), /按.+来看/)
})

test('an answer has to answer exactly the questions asked', () => {
  const questions = [{ id: 'city', question: '哪个城市？', options: [{ label: '上海' }, { label: '北京' }] }, { id: 'days', question: '几天？' }]

  assert.deepEqual(answerFor(questions, { answers: [{ id: 'city', selected: ['上海'] }, { id: 'days', selected: [], custom: '3' }] }), {
    answers: [{ id: 'city', selected: ['上海'] }, { id: 'days', selected: [], custom: '3' }],
  })
  assert.equal(answerFor(questions, { answers: [{ id: 'city', selected: ['上海'] }] }), null, 'one question left out')
  assert.equal(answerFor(questions, { answers: [{ id: 'city', selected: ['广州'] }, { id: 'days', selected: [] }] }), null, 'not an option')
  assert.equal(answerFor(questions, { answers: [{ id: 'city', selected: ['上海', '北京'] }, { id: 'days', selected: [] }] }), null, 'two picks for a single choice')
  assert.equal(answerFor(questions, { answers: [{ id: 'city', selected: [] }, { id: 'city', selected: [] }] }), null, 'the same question twice')
  assert.match(DECLINED, /不要再问/)
})
