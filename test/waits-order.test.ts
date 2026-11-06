import { decodeAgentEvent } from '../src/renderer/agent-event-decoder.ts'
import { createEventActions } from '../src/renderer/agent-event-actions.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createPermissionBroker } from '../src/backend/permission-broker.ts'

/**
 * What the conversation waits on the user for, said on the live channel when a window opens on a dsh at work
 * (waits-state.ts, system-design §12.1): it comes in its place among the pushes, so what was asked or closed before
 * it is in it, and what comes after it follows. Approvals, questions and keys alike.
 */

type Event = { type: string, [field: string]: unknown }
const p1 = { requestId: 'perm-a-1', toolCall: { toolCallId: 't1', title: '写入 notes.md' }, options: [{ optionId: 'ok', kind: 'allow_once', name: '允许' }] }
const p2 = { ...p1, requestId: 'perm-a-2', toolCall: { toolCallId: 't2', title: '删除 old.md' } }
const q1 = { questionId: 'q1-x', questions: [{ id: 'c', question: '哪个城市？', header: '', options: [{ label: '上海' }], multiSelect: false }] }
const q2 = { ...q1, questionId: 'q2-x' }
const s1 = { requestId: 'c1-x', server: 'github', names: ['GITHUB_TOKEN'] }
const s2 = { ...s1, requestId: 'c2-x', server: 'sentry' }
const waits = (fields: Record<string, unknown>): Event => ({ type: 'waits', permissions: [], questions: [], secrets: [], ...fields })

/** The pushes as app.ts takes them, in the order they come. */
const map = createEventActions()
const pushes = (events: Event[], from: State = initialState): State => events.reduce((state, value) => {
  const event = decodeAgentEvent({ ...value, context: { conversationId: 'c', sessionId: 's' } })
  assert.ok(event)
  const action = map(event, event.type === 'waits' ? 1 : event.type === 'turn_end' ? 3 : 2)
  assert.ok(action)
  return reduce(state, action)
}, from)


test('a turn ends and a new approval, question or key is asked, then what waits is said: the new one is there, once', () => {
  const approval = pushes([{ type: 'turn_end', stopReason: 'end_turn' }, { type: 'permission', ...p2 }, waits({ permissions: [p2] })])
  assert.deepEqual([approval.permission?.requestId, approval.timeline.map((entry) => entry.kind)], ['perm-a-2', ['permission']])
  const question = pushes([{ type: 'turn_end', stopReason: 'end_turn' }, { type: 'question', ...q2 }, waits({ questions: [q2] })])
  assert.deepEqual([question.question?.questionId, question.timeline.length], ['q2-x', 1])
  const key = pushes([{ type: 'turn_end', stopReason: 'end_turn' }, { type: 'secret_request', ...s2 }, waits({ secrets: [s2] })])
  assert.deepEqual([key.secret?.requestId, key.timeline.length], ['c2-x', 1])
})

test('what waits is said, then one closes or its turn ends: closed, not shown again', () => {
  assert.equal(pushes([waits({ permissions: [p1] }), { type: 'turn_end', stopReason: 'cancelled' }]).permission, null)
  assert.equal(pushes([waits({ questions: [q1] }), { type: 'question_closed', questionId: 'q1-x' }]).question, null)
  assert.equal(pushes([waits({ secrets: [s1] }), { type: 'secret_closed', requestId: 'c1-x' }]).secret, null)
})

test('closed before what waits is said: not in it, so not shown again', () => {
  const state = pushes([{ type: 'question', ...q1 }, { type: 'question_closed', questionId: 'q1-x' }, { type: 'secret_request', ...s1 },
    { type: 'secret_closed', requestId: 'c1-x' }, waits({})])
  assert.deepEqual([state.question, state.secret, state.phase === 'asking'], [null, null, false])
})

test('what waits is said, then a newer one is asked: the newer one waits', () => {
  assert.equal(pushes([waits({ permissions: [p1] }), { type: 'permission', ...p2 }]).permission?.requestId, 'perm-a-2')
  assert.equal(pushes([waits({ questions: [q1] }), { type: 'question', ...q2 }]).question?.questionId, 'q2-x')
  assert.equal(pushes([waits({ secrets: [s1] }), { type: 'secret_request', ...s2 }]).secret?.requestId, 'c2-x')
})

test('answered on this page before dsh had the answer: what waits still lists it, and it is not asked again', () => {
  const allowed = reduce(pushes([{ type: 'permission', ...p1 }]), { type: 'permission_resolved', requestId: 'perm-a-1', optionId: 'ok', at: 4 })
  assert.equal(pushes([waits({ permissions: [p1] })], allowed).permission, null)
  const answered = reduce(pushes([{ type: 'question', ...q1 }]), { type: 'question_answered', questionId: 'q1-x', answers: [{ id: 'c', selected: ['上海'] }], at: 4 })
  assert.equal(pushes([waits({ questions: [q1] })], answered).question, null)
  const filled = reduce(pushes([{ type: 'secret_request', ...s1 }]), { type: 'secret_resolved', requestId: 'c1-x', provided: true, at: 4 })
  assert.equal(pushes([waits({ secrets: [s1] })], filled).secret, null)
})

test('a dsh started again asks with ids of its own: one answered of the dsh before does not hide the new one', () => {
  const [before, after] = [createPermissionBroker(), createPermissionBroker()]
  const old = before.create({ sessionId: 's', options: [] }).requestId
  const fresh = after.create({ sessionId: 's', options: [] }).requestId
  assert.notEqual(old, fresh, 'the first request of each is its own')
  const answered = reduce(pushes([{ type: 'permission', ...p1, requestId: old }]), { type: 'permission_resolved', requestId: old, optionId: 'ok', at: 4 })
  assert.equal(pushes([waits({ permissions: [{ ...p1, requestId: fresh }] })], answered).permission?.requestId, fresh)
})
