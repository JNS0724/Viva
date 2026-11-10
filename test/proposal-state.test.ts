import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProposalActions } from '../src/renderer/proposal-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { proposalHost } from '../src/renderer/proposal-state.ts'
import { draftOf } from '../src/renderer/proposal-draft.ts'

/** A schedule's card under the conversation (proposal-state.ts, proposal-actions.ts): 定时 keeps it, 不用 lets it go. */

const proposal = { proposalId: 'p1', title: '周报', prompt: '起草周报', rule: { kind: 'at' as const, at: '2026-11-07T08:00:00.000Z' }, firstAt: '2026-11-07T08:00:00.000Z' }

function setup(api: Record<string, (id: string, edits?: unknown) => Promise<unknown>>) {
  let state = reduce(initialState, { type: 'schedule_proposed', proposal }) as State
  const actions = createProposalActions({
    api: api as unknown as AgentApi, getState: () => state, dispatch: (action) => { state = reduce(state, action) },
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return { actions, state: () => state }
}

test('a proposal is one card, however often it is pushed; a push without an id is none', () => {
  const once = reduce(initialState, { type: 'schedule_proposed', proposal })
  assert.deepEqual(once.proposals, [{ id: 'p1', proposal, status: 'open', after: 0 }])
  assert.equal(reduce(once, { type: 'schedule_proposed', proposal }), once)
  // @ts-expect-error Malformed storage/legacy input is also guarded at runtime.
  assert.equal(reduce(initialState, { type: 'schedule_proposed', proposal: { title: 'x' } }), initialState)
})

test('定时 keeps it and the card says when it runs; 不用 lets it go; a card is answered once', async () => {
  const calls: string[] = []
  const kept = { id: 's1', nextAt: '2026-11-07T08:00:00.000Z' }
  const accepting = setup({ acceptSchedule: async (id) => { calls.push(`accept ${id}`); return kept } })
  await accepting.actions.acceptProposal('p1')
  assert.deepEqual(accepting.state().proposals[0], { id: 'p1', proposal, status: 'accepted', after: 0, accepted: kept, busy: false, error: null, editing: false })
  await accepting.actions.acceptProposal('p1')
  assert.deepEqual(calls, ['accept p1'], 'decided: nothing more')

  const declining = setup({ declineSchedule: async (id) => { calls.push(`decline ${id}`) } })
  await declining.actions.declineProposal('p1')
  assert.equal(declining.state().proposals[0].status, 'declined')
})

test('a failure is said on the card, which stays open to be answered again', async () => {
  const { actions, state } = setup({ acceptSchedule: async () => { throw new Error('这个提议已经失效') } })
  await actions.acceptProposal('p1')
  assert.deepEqual([state().proposals[0].status, state().proposals[0].error, state().proposals[0].busy], ['open', '这个提议已经失效', false])
})

test('a card stays at the end of the turn it came in, under that turn\'s answer, as the conversation goes on', () => {
  const said = (...roles: string[]) => roles.map((role) => ({ role }))
  // Proposed while the user's question was the last message: it goes under the answer that came after it.
  assert.equal(proposalHost(said('user', 'assistant', 'user', 'assistant'), 1), 1)
  assert.equal(proposalHost(said('user', 'assistant'), 2), 1, 'proposed after the answer began: still under it')
  assert.equal(proposalHost(said('user', 'assistant', 'assistant', 'user'), 1), 2, 'a turn of several messages: under its last')
  assert.equal(proposalHost(said('user'), 5), 0, 'more than there are (a turn redone): at the end')
  assert.equal(proposalHost([], 0), -1)
  const asked = reduce({ ...initialState, messages: [{ id: 'm0', role: 'user', text: '每周五提醒我写周报' }] } as State, { type: 'schedule_proposed', proposal })
  assert.equal(asked.proposals[0].after, 1)
})

test('修改 then 定时: what the form says is checked here, then kept as changed; the card shows it so', async () => {
  const sent: unknown[] = []
  const kept = { title: '月报', nextAt: '2026-12-01T00:00:00.000Z' }
  const { actions, state } = setup({ acceptSchedule: async (id, edits) => { sent.push([id, edits]); return kept } })
  actions.editProposal('p1', true)
  assert.equal(state().proposals[0].editing, true)
  const draft = { ...draftOf(proposal, Date.parse('2026-11-06T00:00:00Z')), zone: 'Asia/Shanghai' }

  await actions.acceptProposal('p1', { ...draft, title: ' ' })
  assert.deepEqual(sent, [], 'a slip is said without asking the app')
  assert.deepEqual([state().proposals[0].error, state().proposals[0].draft?.title, state().proposals[0].status], ['请填写名称', ' ', 'open'], 'and what was typed stays')

  await actions.acceptProposal('p1', { ...draft, title: '月报', repeat: 'monthly', day: 1, time: '08:00' })
  const rule = { kind: 'cron', cron: { expression: '0 8 1 * *', time_zone: 'Asia/Shanghai' } }
  assert.deepEqual(sent, [['p1', { title: '月报', prompt: '起草周报', rule }]])
  const card = state().proposals[0]
  assert.deepEqual([card.status, card.editing, card.proposal.title, card.proposal.rule, card.accepted], ['accepted', false, '月报', rule, kept])
})

test('a refused save keeps the form and what was typed in it; 取消 lets it go', async () => {
  const { actions, state } = setup({ acceptSchedule: async () => { throw new Error('这个时间已经过了，换一个以后的时间。') } })
  actions.editProposal('p1', true)
  const draft = { ...draftOf(proposal, Date.parse('2026-11-06T00:00:00Z')), title: '改过的名字' }
  await actions.acceptProposal('p1', draft)
  const card = state().proposals[0]
  assert.deepEqual([card.status, card.editing, card.busy, card.error, card.draft?.title], ['open', true, false, '这个时间已经过了，换一个以后的时间。', '改过的名字'])
  actions.editProposal('p1', false)
  assert.deepEqual([state().proposals[0].editing, state().proposals[0].draft, state().proposals[0].error], [false, null, null])
})
