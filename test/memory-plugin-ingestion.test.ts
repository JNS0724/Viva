import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createSessionIngestion, humanMessages } from '../plugins/memory/lib/ingestion.ts'
import type { ReceivedSource, CompletedTurn } from '../plugins/memory/lib/owner-port.ts'

function fixture(flush = async () => true) {
  const received: ReceivedSource[] = [], completed: CompletedTurn[] = []
  const cursors = new Map<string, number>()
  const owner: Parameters<typeof createSessionIngestion>[0] = {
    epoch: 'test',
    inEpoch: (_epoch, work) => work(),
    bindIntakeSession: async () => {},
    intakeWatermark: async session => ({ createdAt: 0, nextSeq: cursors.get(session) ?? null }),
    async advanceIntake(session, seq) { cursors.set(session, seq) },
    async receiveSource(input) { received.push(input); return { sourceId: input.messageId, text: input.text } },
    async completeTurn(input) { completed.push(input); cursors.set(input.sessionId, input.eventSeq + 1) },
  }
  return { ingestion: createSessionIngestion(owner, flush, true), received, completed, owner }
}

const userWords = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

test('live intake uses human originals and skips generated context', async () => {
  const { ingestion, received } = fixture()
  const session = Session.create(SessionId('step-three'))
  const message = userWords('补充：我现在负责结算')
  const context = createUserMessage({ content: [{ type: 'text', text: 'retrieved content' }], source: { kind: 'viva-memory' } })
  assert.deepEqual(humanMessages([message, context]), [{ id: message.id, text: '补充：我现在负责结算' }])
  await ingestion.receive(session, [message, context], 1, 3)
  assert.deepEqual(received.map(item => [item.messageId, item.admitted, item.live, item.step, item.requiresAlias]),
    [[message.id, true, true, 3, true]])
})

test('persisted intake advances once for both completed and cancelled turns and skips inherited events', async () => {
  const { ingestion, received, completed, owner } = fixture()
  const session = Session.create(SessionId('original'))
  session.append('turn/start', { turn: 1 })
  const message = userWords('原始输入')
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await ingestion.synchronize(session)
  await createSessionIngestion(owner, async () => true, true).synchronize(session)
  const events = session.snapshotEvents()
  const id = SessionId('child')
  const fork = Session.create(id, events, { ...session.header, id, isSeeded: true }, SessionLogOffset(events.length))
  await ingestion.synchronize(fork)
  assert.deepEqual(received.map(item => item.messageId), [message.id])
  assert.deepEqual(completed.map(item => [item.completed, item.sourceIds]), [[true, [message.id]], [false, []]])
})

test('replay waits for a durable acknowledgement before using the native log', async () => {
  const { ingestion, received, completed } = fixture(async () => false)
  const session = Session.create(SessionId('not-yet-persisted'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', userWords('Do not reread until durable'), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ingestion.synchronize(session)
  assert.deepEqual(received, [])
  assert.deepEqual(completed, [])
})
