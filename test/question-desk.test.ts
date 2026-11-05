import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQuestionDesk } from '../src/backend/question-channel.ts'

/** What the conversation on screen still asks, apart from a background task's (question-channel.ts pendingOf). */

const asked = (id: string, sessionId: string) => ({ type: 'question', id, sessionId, questions: [{ id: 'c', question: '哪个城市？', header: '城市', options: [{ label: '上海' }, { label: '北京' }] }] })

test('the conversation on screen\'s questions still waiting are read apart from a task\'s; answered, they are gone', () => {
  const sent: object[] = []
  const desk = createQuestionDesk({ send: (message) => { sent.push(message) }, emit: () => {}, sessionId: () => 'main', taskOf: (session) => (session === 'task-s' ? 'task-1' : null) })
  desk.receive(asked('q-main', 'main'))
  desk.receive(asked('q-task', 'task-s'))
  assert.deepEqual([desk.pendingOf(null).map((wait) => wait.questionId), desk.pendingOf('task-1').map((wait) => wait.questionId)], [['q-main'], ['q-task']])
  assert.equal(desk.answer('q-main', [{ id: 'c', selected: ['北京'] }]), true)
  assert.deepEqual(desk.pendingOf(null), [], 'answered: no longer waiting')
  assert.deepEqual(sent.at(-1), { type: 'answer', id: 'q-main', answers: [{ id: 'c', selected: ['北京'] }] })
})
