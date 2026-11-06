import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProposalActions } from '../src/renderer/proposal-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

/** A schedule's card under the conversation (proposal-state.ts, proposal-actions.ts): 定时 keeps it, 不用 lets it go. */

const proposal = { proposalId: 'p1', title: '周报', prompt: '起草周报', rule: { kind: 'at' as const, at: '2026-11-07T08:00:00.000Z' }, firstAt: '2026-11-07T08:00:00.000Z' }

function setup(api: Record<string, (id: string) => Promise<unknown>>) {
  let state = reduce(initialState, { type: 'schedule_proposed', proposal }) as State
  const actions = createProposalActions({
    api: api as unknown as AgentApi, getState: () => state, dispatch: (action) => { state = reduce(state, action) },
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return { actions, state: () => state }
}

test('a proposal is one card, however often it is pushed; a push without an id is none', () => {
  const once = reduce(initialState, { type: 'schedule_proposed', proposal })
  assert.deepEqual(once.proposals, [{ id: 'p1', proposal, status: 'open' }])
  assert.equal(reduce(once, { type: 'schedule_proposed', proposal }), once)
  // @ts-expect-error Malformed storage/legacy input is also guarded at runtime.
  assert.equal(reduce(initialState, { type: 'schedule_proposed', proposal: { title: 'x' } }), initialState)
})

test('定时 keeps it and the card says when it runs; 不用 lets it go; a card is answered once', async () => {
  const calls: string[] = []
  const kept = { id: 's1', nextAt: '2026-11-07T08:00:00.000Z' }
  const accepting = setup({ acceptSchedule: async (id) => { calls.push(`accept ${id}`); return kept } })
  await accepting.actions.acceptProposal('p1')
  assert.deepEqual(accepting.state().proposals[0], { id: 'p1', proposal, status: 'accepted', accepted: kept, busy: false, error: null })
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
