import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DSH_TIMEOUT_MS, eventually, startHarness as setup } from './fixtures/dsh-harness.js'

/**
 * Background tasks inside the real dsh (phase 3): the turn that is running is spun off as a task and goes on
 * in its own session, while the main conversation goes on from before it, in a session forked there.
 */

const textOf = (events, pick) => events.filter(pick).map((e) => e.update.content.text).join('')
const mainReplies = (events) => textOf(events, (e) => e.type === 'update' && e.update?.sessionUpdate === 'agent_message_chunk')
const taskReplies = (events, taskId) => textOf(events, (e) => e.type === 'task_update' && e.taskId === taskId && e.update?.sessionUpdate === 'agent_message_chunk')

test('the running turn goes on as a task while the main conversation answers something else', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t)
  const agent = bridge()
  const first = await agent.start()
  await agent.prompt('记住这个暗号：蓝色鲸鱼')

  // The weather question makes the fake model ask which city: the turn waits on the user.
  const running = agent.prompt('明天天气怎么样')
  const asked = await eventually(() => events.find((e) => e.type === 'question'))
  assert.ok(asked, 'the turn is waiting on a question')

  const spun = await agent.spinOff({ words: '明天天气怎么样' })
  assert.equal(spun.ok, true, JSON.stringify(spun))
  assert.equal(spun.taskId, first.sessionId, 'the running session is the task')
  assert.notEqual(spun.info.sessionId, first.sessionId, 'the main conversation is in a new session')
  const moved = await eventually(() => events.find((e) => e.type === 'task_question' && e.taskId === spun.taskId))
  assert.equal(moved?.questionId, asked.questionId, 'the waiting question now belongs to the task')

  await agent.prompt('换个话题：午饭吃什么')
  assert.ok(mainReplies(events).includes('午饭吃什么'), 'the main conversation answers at once')
  const mainAsked = JSON.stringify(llm.requests.filter((r) => JSON.stringify(r).includes('午饭吃什么')).at(0))
  assert.ok(mainAsked.includes('蓝色鲸鱼') && !mainAsked.includes('明天天气怎么样'), 'it remembers what came before, not the turn spun off')

  assert.equal(agent.answerQuestion(asked.questionId, [{ id: 'city', selected: ['上海'] }]), true)
  const ended = await eventually(() => events.find((e) => e.type === 'task_end' && e.taskId === spun.taskId))
  assert.ok(ended, 'the task finished on its own')
  await running
  assert.ok(taskReplies(events, spun.taskId).includes('按上海来看'), 'its answer went to the task, not the main conversation')
  assert.equal(events.filter((e) => e.type === 'turn_end').length, 2, 'the main conversation saw only its own two turns end')
})

test('only a running turn can be spun off', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { bridge } = await setup(t)
  const agent = bridge()
  await agent.start()
  await agent.prompt('你好')
  assert.deepEqual(await agent.spinOff({ words: '你好' }), { ok: false, reason: 'idle' })
})
