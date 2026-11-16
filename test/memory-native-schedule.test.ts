import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
// dsh-schedule declares this runtime source in src/runtime.ts, not in its public type entry.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { schedule: { kind: 'schedule' } & ContextFormed }
}
import { createSessionIngestion } from '../plugins/memory/lib/ingestion.ts'

function fixture() {
  let registered = 0
  const ingestion = createSessionIngestion({
    initializeSession() {},
    async receiveSource() { registered++; return { sourceId: 'unexpected', text: '' } },
    async completeTurn() { registered++ },
    registerDerived() { registered++ },
    dispatch: { snapshot: () => ({ dependencies: [], sources: [], turnOnly: false, epoch: 0 }) },
  }, async () => true)
  return { ingestion, registered: () => registered }
}

test('unattributed native scheduled prompts cannot acquire an empty read set on first delivery, retry or cold replay', async () => {
  const session = Session.create(SessionId('native-schedule'))
  const message = createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: 'A stored prompt may contain a now-forgotten address' }] })
  const first = fixture()
  await assert.rejects(first.ingestion.receive(session, [message], 1, 1, false), /verified memory provenance/)
  await assert.rejects(first.ingestion.receive(session, [message], 1, 1, true), /verified memory provenance/)
  assert.equal(first.registered(), 0)
  session.append('user/message', message, { surfaceOp: 'append' })
  const restarted = fixture()
  await assert.rejects(restarted.ingestion.synchronize(Session.create(session.id, session.snapshotEvents(), session.header)), /verified memory provenance/)
  assert.equal(restarted.registered(), 0)
})

test('trusted host scheduled delivery retains its existing user-source intake path', async () => {
  const current = fixture()
  const session = Session.create(SessionId('host-schedule'))
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'A host-registered delivery' }] })
  await current.ingestion.receive(session, [message], 1, 1, false)
  assert.equal(current.registered(), 1)
})
