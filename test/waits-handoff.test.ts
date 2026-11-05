import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createReadHandoff } from '../src/renderer/read-handoff.ts'

/**
 * A window opened on a dsh at work reads what the conversation waits on the user for (app.ts, read-handoff.ts): what
 * the live channel says while the read is under way is taken after it, so nothing closed meanwhile comes back, and
 * nothing asked meanwhile is lost or shown twice. Approvals, questions and keys alike.
 */

type Event = { type: string, [field: string]: unknown }
/** A wait as the read gives it (ipc-results.ts SessionWaits): no event type of its own. */
type Wait = Record<string, unknown>
type Waits = { permissions: Wait[], questions: Wait[], secrets: Wait[] }
const p1 = { requestId: 'p1', toolCall: { toolCallId: 't1', title: '写入 notes.md' }, options: [{ optionId: 'ok', kind: 'allow_once', name: '允许' }] }
const p2 = { ...p1, requestId: 'p2', toolCall: { toolCallId: 't2', title: '删除 old.md' } }
const q1 = { questionId: 'q1', questions: [{ id: 'c', question: '哪个城市？', header: '', options: [{ label: '上海' }], multiSelect: false }] }
const q2 = { ...q1, questionId: 'q2' }
const s1 = { requestId: 's1', server: 'github', names: ['GITHUB_TOKEN'] }
const s2 = { ...s1, requestId: 's2', server: 'sentry' }
const none: Waits = { permissions: [], questions: [], secrets: [] }

/** The window as app.ts takes events and the read: the live channel held during the read, then taken after it. */
function opening(waits: Waits, during: Event[]) {
  let state = initialState as ReturnType<typeof reduce>
  const toAction: Record<string, (event: Event) => Event> = {
    permission: (event) => ({ ...event, type: 'permission_request', at: 2 }),
    question: (event) => ({ ...event, type: 'question_request', at: 2 }),
    question_closed: (event) => ({ ...event, type: 'question_closed' }),
    secret_request: (event) => ({ ...event, type: 'secret_request', at: 2 }),
    secret_closed: (event) => ({ ...event, type: 'secret_closed' }),
    turn_end: (event) => ({ ...event, type: 'turn_end', at: 3 }),
  }
  const handoff = createReadHandoff<Event>((event) => { state = reduce(state, toAction[event.type](event)) })
  const arrive = (event: Event) => { if (!handoff.hold(event)) state = reduce(state, toAction[event.type](event)) }
  const read = handoff.read(async () => { for (const event of during) arrive(event); return waits }, (value) => {
    state = reduce(state, { type: 'waits_restored', permissions: value.permissions, questions: value.questions, at: 1 })
    state = reduce(state, { type: 'secrets_restored', secrets: value.secrets, at: 1 })
  }, () => {})
  return read.then(() => state)
}

test('closed while the read was under way: the approval, question or key the read has does not come back', async () => {
  const ended = await opening({ permissions: [p1], questions: [], secrets: [] }, [{ type: 'turn_end', stopReason: 'cancelled' }])
  assert.deepEqual([ended.permission, ended.phase], [null, 'idle'], 'an approval: its turn ended')
  const closed = await opening({ permissions: [], questions: [q1], secrets: [] }, [{ type: 'question_closed', questionId: 'q1' }])
  assert.deepEqual([closed.question, closed.phase === 'asking'], [null, false], 'a question closed')
  const questionEnded = await opening({ permissions: [], questions: [q1], secrets: [] }, [{ type: 'turn_end', stopReason: 'end_turn' }])
  assert.equal(questionEnded.question, null, 'a question: its turn ended')
  const keyClosed = await opening({ permissions: [], questions: [], secrets: [s1] }, [{ type: 'secret_closed', requestId: 's1' }])
  assert.deepEqual([keyClosed.secret, keyClosed.phase === 'asking'], [null, false], 'a key no longer asked for')
  const keyEnded = await opening({ permissions: [], questions: [], secrets: [s1] }, [{ type: 'turn_end', stopReason: 'end_turn' }])
  assert.equal(keyEnded.secret, null, 'a key: its turn ended')
})

test('asked while the read was under way and not in it: shown after the read, not overwritten by it', async () => {
  const approval = await opening({ permissions: [p1], questions: [], secrets: [] }, [{ type: 'permission', ...p2 }])
  assert.equal(approval.permission?.requestId, 'p2', 'the newer approval is the one waiting')
  const question = await opening({ permissions: [], questions: [q1], secrets: [] }, [{ type: 'question', ...q2 }])
  assert.equal(question.question?.questionId, 'q2')
  const key = await opening({ permissions: [], questions: [], secrets: [s1] }, [{ type: 'secret_request', ...s2 }])
  assert.equal(key.secret?.requestId, 's2')
  const fresh = await opening(none, [{ type: 'permission', ...p2 }, { type: 'question', ...q2 }])
  assert.deepEqual([fresh.permission?.requestId, fresh.question?.questionId], ['p2', 'q2'], 'with nothing in the read, all that came')
})

test('asked before the read, come live during it and in it too: shown once', async () => {
  const state = await opening({ permissions: [p1], questions: [q1], secrets: [s1] },
    [{ type: 'permission', ...p1 }, { type: 'question', ...q1 }, { type: 'secret_request', ...s1 }])
  assert.deepEqual(state.timeline.map((entry) => `${entry.kind}:${entry.ref}`), ['permission:p1', 'question:q1', 'secret:s1'])
})

test('answered on this page before the read came back: the read does not ask it again', () => {
  const shown = reduce(initialState, { type: 'permission_request', ...p1, at: 1 })
  const allowed = reduce(shown, { type: 'permission_resolved', requestId: 'p1', optionId: 'ok', at: 2 })
  const read = reduce(allowed, { type: 'waits_restored', permissions: [p1], questions: [], at: 3 })
  assert.deepEqual([read.permission, read.timeline.map((entry) => entry.kind)], [null, ['permission', 'decision']])
})

test('a read that fails takes nothing, and what came meanwhile is taken all the same', async () => {
  let state = initialState as ReturnType<typeof reduce>
  const handoff = createReadHandoff<Event>((event) => { state = reduce(state, { ...event, type: 'permission_request', at: 2 }) })
  const failures: unknown[] = []
  await handoff.read(async () => { handoff.hold({ type: 'permission', ...p2 }); throw new Error('gone') }, () => assert.fail('nothing to take'), (err) => { failures.push(err) })
  assert.deepEqual([state.permission?.requestId, failures.length, handoff.hold({ type: 'permission' })], ['p2', 1, false])
})
