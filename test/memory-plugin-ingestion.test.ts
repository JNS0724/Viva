import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createSessionIngestion, extractHumanMessages } from '../plugins/memory/lib/ingestion.ts'
import type { SettleTurnInput, StageOpenTurnInput } from '../src/memory/node/owner.ts'

function fixture(flush = async () => true, persistedSessions = new Map<string, Session>()) {
  const settled: SettleTurnInput[] = []
  const staged: StageOpenTurnInput[] = []
  const cursors = new Map<string, number>()
  const owner: Parameters<typeof createSessionIngestion>[0] = {
    epoch: 'test',
    inEpoch: (_epoch, work) => work(),
    intakeCursor: async session => ({ createdAt: 0, nextSeq: cursors.get(session) ?? null, inheritedSeq: 0, sessionKind: 'main', conversation: null }),
    async advanceIntakeCursor(input) {
      const current = cursors.get(input.sessionId) ?? null
      if (current !== input.expectedNextSeq) return { status: 'cas_mismatch', nextSeq: current ?? 0 }
      cursors.set(input.sessionId, input.nextSeq)
      return { status: 'ok', nextSeq: input.nextSeq }
    },
    async beginTurn() {},
    async stageOpenTurnSources(input) { staged.push(input); return { staged: input.sources.map(s => s.sourceId) } },
    async settleTurn(input) {
      const current = cursors.get(input.sessionId) ?? null
      if (current !== input.expectedNextSeq || (current !== null && input.fromSeq !== current)) {
        return { status: 'cas_mismatch', nextSeq: current ?? 0 }
      }
      settled.push(input)
      cursors.set(input.sessionId, input.toSeq)
      return { status: 'ok', nextSeq: input.toSeq }
    },
  }
  const persistence = {
    async open(id: SessionId) {
      const session = persistedSessions.get(String(id))
      if (!session) throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' })
      return {
        inheritedEventCount: session.inheritedEventCount,
        async read(offset: number, limit: number) {
          const all = session.snapshotEvents()
          return { events: all.slice(offset, offset + limit) }
        },
        async close() {},
      }
    },
    async list() {
      return [...persistedSessions.values()].map(s => ({ header: s.header, revision: 1, inheritedEventCount: s.inheritedEventCount }))
    },
  } as unknown as Parameters<typeof createSessionIngestion>[2]
  const sessions = { flush }
  return { ingestion: createSessionIngestion(owner, sessions, persistence), settled, staged, owner, sessions, persistence }
}

const userWords = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

test('unified extractor keeps human originals and skips generated context', async () => {
  const message = userWords('补充：我现在负责结算')
  const context = createUserMessage({ content: [{ type: 'text', text: 'retrieved content' }], source: { kind: 'viva-memory' } })
  const extracted = extractHumanMessages([message, context])
  assert.equal(extracted.length, 1)
  assert.equal(extracted[0]!.id, message.id)
  assert.equal(extracted[0]!.text, '补充：我现在负责结算')
})

test('persisted intake advances once for both completed and cancelled turns and skips inherited events', async () => {
  const persisted = new Map<string, Session>()
  const { ingestion, settled, owner, sessions, persistence } = fixture(async () => true, persisted)
  const session = Session.create(SessionId('original'))
  session.append('turn/start', { turn: 1 })
  const message = userWords('原始输入')
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  persisted.set(String(session.id), session)

  await ingestion.synchronize(session)
  await createSessionIngestion(owner, sessions, persistence).synchronize(session)

  const events = session.snapshotEvents()
  const id = SessionId('child')
  const fork = Session.create(id, events, { ...session.header, id, isSeeded: true }, SessionLogOffset(events.length))
  persisted.set(String(fork.id), fork)
  await ingestion.synchronize(fork)

  assert.equal(settled.length, 2)
  assert.equal(settled[0]!.reasonKind, 'completed')
  assert.deepEqual(settled[0]!.sources.map(item => item.sourceId), [message.id])
  assert.equal(settled[1]!.reasonKind, 'aborted')
  assert.deepEqual(settled[1]!.sources, [])
})

test('replay waits for a durable acknowledgement and persisted read handle before using the native log', async () => {
  const persisted = new Map<string, Session>()
  const { ingestion, settled } = fixture(async () => false, persisted)
  const session = Session.create(SessionId('not-yet-persisted'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', userWords('Do not reread until durable'), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  persisted.set(String(session.id), session)
  await ingestion.synchronize(session)
  assert.deepEqual(settled, [])
})
