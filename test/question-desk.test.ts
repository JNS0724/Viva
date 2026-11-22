import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQuestionDesk } from '../src/backend/question-channel.ts'

/** What the conversation on screen still asks, apart from a background task's (question-channel.ts pendingOf). */

const asked = (id: string, sessionId: string) => ({ type: 'question', id, sessionId, questions: [{ id: 'c', question: '哪个城市？', header: '城市', options: [{ label: '上海' }, { label: '北京' }] }] })

test('the conversation on screen\'s questions still waiting are read apart from a task\'s; answered, they are gone', async () => {
  const sent: object[] = []
  const desk = createQuestionDesk({ send: (message) => { sent.push(message) }, emit: () => {}, sessionId: () => 'main', taskOf: (session) => (session === 'task-s' ? 'task-1' : null) })
  await desk.receive(asked('q-main', 'main'))
  await desk.receive(asked('q-task', 'task-s'))
  assert.deepEqual([desk.pendingOf(null).map((wait) => wait.questionId), desk.pendingOf('task-1').map((wait) => wait.questionId)], [['q-main'], ['q-task']])
  assert.equal(await desk.answer('q-main', [{ id: 'c', selected: ['北京'] }]), true)
  assert.deepEqual(desk.pendingOf(null), [], 'answered: no longer waiting')
  assert.deepEqual(sent.at(-1), { type: 'answer', id: 'q-main', answers: [{ id: 'c', selected: ['北京'] }] })
})

test('a card closed during remote authorization cannot reappear, and concurrent answers intake once', async () => {
  let release!: (value: boolean) => void
  const events: object[] = []
  const authorization = new Promise<boolean>(resolve => { release = resolve })
  const desk = createQuestionDesk({ send() {}, emit: event => { events.push(event) }, sessionId: () => 'main',
    allowGeneralQuestion: () => authorization })
  const receiving = desk.receive(asked('late', 'main'))
  await desk.receive({ type: 'question_closed', id: 'late' })
  release(true); await receiving
  assert.deepEqual(events, [])

  let delivered = 0, finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const active = createQuestionDesk({ send() {}, emit() {}, sessionId: () => 'main',
    onAnswer: async () => { delivered++; await pending; return 'source' } })
  await active.receive(asked('once', 'main'))
  const first = active.answer('once', [{ id: 'c', selected: ['北京'] }])
  await Promise.resolve()
  assert.equal(await active.answer('once', [{ id: 'c', selected: ['北京'] }]), false)
  finish(); assert.equal(await first, true); assert.equal(delivered, 1)
})

test('retired Dream questions are declined in both venues while a live question remains answerable', async () => {
  const sent: object[] = []
  const desk = createQuestionDesk({ send: message => { sent.push(message) }, emit() {}, sessionId: () => 'main',
    taskOf: session => session === 'task-session' ? 'task' : null,
    allowGeneralQuestion: (_session, _questions, waiting) => waiting,
  })
  for (const session of ['main', 'task-session']) {
    const legacy = asked('old-' + session, session)
    legacy.questions[0].id = 'memory-clarify:file:old-ticket'
    await desk.receive(legacy)
    assert.deepEqual(sent.at(-1), { type: 'decline', id: legacy.id })
    assert.equal(await desk.answer(legacy.id, []), false)
  }
  await desk.receive(asked('live', 'main'))
  assert.equal(await desk.answer('live', [{ id: 'c', selected: ['上海'] }]), true)
})

test('answer with recordMemory: false validates and delivers the answer without calling onAnswer', async () => {
  const sent: object[] = []
  let onAnswerCalls = 0
  const desk = createQuestionDesk({
    send: message => { sent.push(message) },
    emit: () => {},
    sessionId: () => 'main',
    taskOf: session => session === 'task-s' ? 'task-1' : null,
    onAnswer: async () => { onAnswerCalls++; return 'human-src' },
  })
  await desk.receive(asked('q-agent', 'task-s'))
  const accepted = await desk.answer('q-agent', [{ id: 'c', selected: ['上海'], custom: '代理转述' }], undefined, { recordMemory: false })
  assert.equal(accepted, true)
  assert.equal(onAnswerCalls, 0, 'agent-relayed custom text must not invoke human acceptQuestionAnswer')
  assert.deepEqual(sent.at(-1), { type: 'answer', id: 'q-agent', answers: [{ id: 'c', selected: ['上海'], custom: '代理转述' }] })
  assert.deepEqual(desk.pendingOf('task-1'), [])
})
