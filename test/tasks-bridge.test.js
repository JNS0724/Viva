import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.js'

/**
 * Background tasks inside the real dsh: 后台做 starts a task in a session of its own, beside the main
 * conversation, and a task Viva quit on is taken up again at the next launch.
 */

const taskReplies = (events, taskId) => replies(events.filter(e => e.type === 'task_update' && e.taskId === taskId)).join('')

test('after a relaunch, a task left unfinished is taken up again, remembering what it had', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t)
  const first = bridge()
  await first.start()
  const task = await first.startTask({})
  assert.equal(task.ok, true, JSON.stringify(task))
  const running = first.promptTask(task.taskId, '明天天气怎么样').catch(() => {})
  await eventually(() => events.find((e) => e.type === 'task_question' && e.taskId === task.taskId))
  // Viva quits: dsh goes, and the task with it, unfinished.
  await first.dispose()
  await running
  assert.equal(events.some((e) => e.type === 'task_end' && e.taskId === task.taskId), false, 'quitting does not end it: it is offered again')

  const second = bridge()
  await second.start()
  const resumed = await second.resumeTask({ taskId: task.taskId })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  const before = events.length
  await second.promptTask(task.taskId, '刚才 Viva 关掉了，接着做没做完的事')

  const ended = events.slice(before).find((e) => e.type === 'task_end' && e.taskId === task.taskId)
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
