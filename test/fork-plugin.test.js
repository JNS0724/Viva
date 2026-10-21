import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.js'

/**
 * The fork plugin (prototype) inside the real dsh: going back to an earlier point of the conversation, and on
 * in another working directory, with the questions plugin still working in the new session.
 */

/**
 * The model's request answering `prompt`: its last message is the user's, with those words. (The memory plugin's
 * background pass also calls the model after a turn, with the whole log; that is not what the agent sees.)
 */
function requestFor(llm, prompt) {
  const answering = llm.requests.filter((request) => {
    const last = request.messages?.at(-1)
    return last?.role === 'user' && JSON.stringify(last.content).includes(prompt)
  })
  assert.ok(answering.length > 0, `the model was asked about ${prompt}`)
  return JSON.stringify(answering.at(-1))
}

test('going back before a message leaves it and what followed out of what the model sees next', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { llm, bridge } = await setup(t)
  const agent = bridge()
  const first = await agent.start()
  await agent.prompt('第一句：我在做季度报表')
  await agent.prompt('第二句：顺便聊聊午饭吃什么')

  const forked = await agent.fork({ before: 1 })
  assert.equal(forked.ok, true, JSON.stringify(forked))
  assert.equal(forked.info.resumed, true, 'the new session was resumed over ACP, not opened empty')
  assert.notEqual(forked.info.sessionId, first.sessionId)

  await agent.prompt('第三句：回到报表')
  const seen = requestFor(llm, '第三句：回到报表')
  assert.ok(seen.includes('第一句：我在做季度报表'), 'what came before the point comes along')
  assert.ok(!seen.includes('第二句：顺便聊聊午饭吃什么'), 'the message gone back over is left out')
  assert.ok(seen.includes('第三句：回到报表'))
})

test('forked into another directory, the session works there and keeps the conversation', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { dir, llm, bridge } = await setup(t)
  const other = path.join(dir, 'other-project')
  fs.mkdirSync(other)
  const agent = bridge()
  await agent.start()
  await agent.prompt('记住这个暗号：蓝色鲸鱼')

  const forked = await agent.fork({ cwd: other })
  assert.equal(forked.ok, true, JSON.stringify(forked))
  assert.deepEqual([forked.info.resumed, forked.info.cwd], [true, other])

  await agent.prompt('换了个项目，继续')
  const seen = requestFor(llm, '换了个项目，继续')
  assert.ok(seen.includes('蓝色鲸鱼'), 'the whole conversation comes along to the new directory')
  assert.ok(seen.includes(JSON.stringify(other).slice(1, -1)), 'the model is told it works in the new directory now')
})

test('in the forked session the agent can still ask and be answered', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()
  await agent.prompt('你好')
  const forked = await agent.fork({ before: 1 })
  assert.equal(forked.ok, true, JSON.stringify(forked))
  assert.equal(forked.info.resumed, true, 'asked in the resumed fork, not in a fresh session opened instead')

  const turn = agent.prompt('明天天气怎么样')
  const question = await eventually(() => events.find((event) => event.type === 'question'))
  assert.ok(question, 'the question reaches the app from the forked session')
  agent.answerQuestion(question.questionId, [{ id: 'city', selected: ['上海'] }])
  await turn
  assert.ok(replies(events).join('').includes('按上海来看'))
})
