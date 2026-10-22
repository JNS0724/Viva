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

test('undone, the task is the main conversation again and its turn ends there', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()
  const running = agent.prompt('明天天气怎么样')
  const asked = await eventually(() => events.find((e) => e.type === 'question'))
  const spun = await agent.spinOff({ words: '明天天气怎么样' })
  assert.equal(spun.ok, true, JSON.stringify(spun))

  const back = await agent.mergeBack(spun.taskId)
  assert.equal(back.ok, true, JSON.stringify(back))
  assert.equal(back.info.sessionId, spun.taskId, 'the main conversation is the task’s session again')
  const shown = await eventually(() => events.filter((e) => e.type === 'question' && e.questionId === asked.questionId).length === 2)
  assert.ok(shown, 'its waiting question is the main conversation’s again')

  assert.equal(agent.answerQuestion(asked.questionId, [{ id: 'city', selected: ['上海'] }]), true)
  await running
  assert.equal(events.some((e) => e.type === 'task_end'), false, 'it ends as the main turn, not as a task')
  assert.equal(events.filter((e) => e.type === 'turn_end').length, 1)
})

test('after a relaunch, a task left unfinished is taken up again, remembering what it had', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t)
  const first = bridge()
  await first.start()
  const running = first.prompt('明天天气怎么样').catch(() => {})
  await eventually(() => events.find((e) => e.type === 'question'))
  const spun = await first.spinOff({ words: '明天天气怎么样' })
  assert.equal(spun.ok, true, JSON.stringify(spun))
  // Viva quits: dsh goes, and the task with it, unfinished.
  await first.dispose()
  await running
  assert.equal(events.some((e) => e.type === 'task_end' && e.taskId === spun.taskId), false, 'quitting does not end it: it is offered again')

  const second = bridge()
  await second.start()
  const resumed = await second.resumeTask({ taskId: spun.taskId })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  const before = events.length
  await second.promptTask(spun.taskId, '刚才 Viva 关掉了，接着做没做完的事')

  const ended = events.slice(before).find((e) => e.type === 'task_end' && e.taskId === spun.taskId)
  assert.ok(ended, 'the task ends as a task, not as the main conversation')
  assert.equal(events.slice(before).some((e) => e.type === 'turn_end'), false)
  const asked = JSON.stringify(llm.requests.filter((r) => JSON.stringify(r).includes('接着做没做完的事')).at(0))
  assert.ok(asked.includes('明天天气怎么样'), 'it still has what it was doing')
  assert.deepEqual(await second.resumeTask({ taskId: 'no-such-session' }).then((r) => r.ok), false)
})

test('后台做: a task of its own starts from the conversation so far, on the model the conversation is on', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t)
  const agent = bridge()
  const info = await agent.start()
  const other = info.models.find((model) => model.value !== info.modelValue)
  await agent.setConfig('model', other.value)
  await agent.prompt('记住这个暗号：蓝色鲸鱼')
  const mainModel = llm.requests.at(-1).model

  const started = await agent.startTask({})
  assert.equal(started.ok, true, JSON.stringify(started))
  assert.notEqual(started.taskId, info.sessionId, 'a session of its own')
  await agent.promptTask(started.taskId, '午饭吃什么')

  assert.ok(taskReplies(events, started.taskId).includes('午饭吃什么'), 'it answers as a task')
  const asked = llm.requests.find((request) => JSON.stringify(request).includes('午饭吃什么'))
  assert.ok(JSON.stringify(asked).includes('蓝色鲸鱼'), 'it knows what was said before it')
  assert.equal(asked.model, mainModel, 'on the model picked for the conversation, not the profile\'s first')
  assert.equal(events.filter((e) => e.type === 'turn_end').length, 1, 'the main conversation saw only its own turn')
})

test('后台做 with nothing said yet starts afresh, still on the model the conversation is on', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { llm, bridge } = await setup(t)
  const agent = bridge()
  const info = await agent.start()
  const other = info.models.find((model) => model.value !== info.modelValue)
  await agent.setConfig('model', other.value)

  const started = await agent.startTask({})
  assert.equal(started.ok, true, JSON.stringify(started))
  await agent.promptTask(started.taskId, '午饭吃什么')
  await agent.prompt('你好')

  const modelOf = (words) => llm.requests.find((request) => JSON.stringify(request).includes(words))?.model
  assert.equal(modelOf('午饭吃什么'), modelOf('你好'), 'the task is on the model picked for the conversation')
})

test('only a running turn can be spun off', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { bridge } = await setup(t)
  const agent = bridge()
  await agent.start()
  await agent.prompt('你好')
  assert.deepEqual(await agent.spinOff({ words: '你好' }), { ok: false, reason: 'idle' })
})
