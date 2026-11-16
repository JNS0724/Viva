import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createQuestionDesk } from '../src/backend/question-channel.ts'

const session = 'main'

test('an accepted foreground card only attributes a source supplied by backend intake', async () => {
  const events: Array<{ type: string, sourceId?: unknown }> = []
  const context = { conversationId: 'topic', sessionId: session }
  const operation = randomUUID()
  const sourceId = randomUUID()
  const desk = createQuestionDesk({
    emit: event => events.push(event), send: () => {}, sessionId: () => session, conversationContext: () => context,
    onAnswer: (_entry, answers) => answers.some(answer => answer.custom) ? sourceId : undefined,
  })
  for (const [id, answer] of [['pick', { selected: ['One'] }], ['typed', { selected: [], custom: 'Second' }]] as const) {
    await desk.receive({ type: 'question', id, sessionId: session, questions: [{ id: 'value', question: 'Which?', options: [{ label: 'One' }] }] })
    assert.equal(await desk.answer(id, [{ id: 'value', ...answer }], operation), true)
  }
  assert.deepEqual(events.filter(event => event.type === 'question_answered').map(event => event.sourceId), [undefined, sourceId])
})
