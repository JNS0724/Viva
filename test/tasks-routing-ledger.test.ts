import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atStep, claimFast, decide, decisionProblem, EMPTY_LEDGER, failUndecided, hasOpenWork, mayShow, register, repairs, settleFast, statusOfPlan, type Ledger } from '../src/shared/request-routing/ledger.ts'

const at = (turn: number, step: number, ledger: Ledger = EMPTY_LEDGER) => atStep(ledger, turn, step)

test('a request is registered once, and only an undecided one may be decided', () => {
  const ledger = register(at(1, 1), 'r-1', false)
  assert.equal(register(ledger, 'r-1', true), ledger, 'registering again changes nothing')
  assert.equal(decisionProblem(ledger, 'r-1'), null)
  assert.match(decisionProblem(ledger, 'r-9') ?? '', /没有待处理的请求/)
  const decided = decide(ledger, 'r-1', 'handed')
  assert.match(decisionProblem(decided, 'r-1') ?? '', /已经提交过决策/)
  assert.equal(ledger.requests['r-1'].status, 'pending', 'the earlier ledger is left as it was')
})

test('what a plan makes of its request: a failed handover keeps the agent answering', () => {
  assert.equal(statusOfPlan(['start'], false), 'handed')
  assert.equal(statusOfPlan(['start'], true), 'answering')
  assert.equal(statusOfPlan(['message', 'reply'], false), 'answering')
  assert.equal(statusOfPlan(['app_action'], false), 'acting')
  assert.equal(statusOfPlan(['clarify'], false), 'asking')
})

test('text shows only after leave to speak was given in an earlier step, and never while a request waits', () => {
  let ledger = register(at(1, 1), 'r-1', false)
  assert.equal(mayShow(ledger, 1), false)
  ledger = decide(ledger, 'r-1', 'answering')
  assert.equal(mayShow(ledger, 1), false, 'not in the step that committed')
  assert.equal(mayShow(at(1, 2, ledger), 2), true)
  ledger = register(at(1, 2, ledger), 'r-2', true)
  assert.equal(mayShow(ledger, 3), false, 'an interjected request waits for its decision')
  ledger = decide(ledger, 'r-2', 'handed')
  assert.equal(mayShow(ledger, 3), true)
})

test('leave to speak ends with its turn: a later handover concludes and shows nothing', () => {
  let ledger = decide(register(at(1, 1), 'r-1', false), 'r-1', 'answering')
  assert.equal(hasOpenWork(ledger), true)
  ledger = at(2, 1, ledger)
  assert.equal(ledger.requests['r-1'].status, 'done')
  ledger = decide(register(ledger, 'r-2', false), 'r-2', 'handed')
  assert.equal(hasOpenWork(ledger), false, 'the handover can end the turn')
  assert.equal(mayShow(at(2, 2, ledger), 2), false, 'an answer of an earlier turn gives no leave now')
  const asked = at(3, 1, decide(register(at(2, 3, ledger), 'r-3', false), 'r-3', 'asking'))
  assert.equal(asked.requests['r-3'].status, 'awaiting', 'a question waits for its answer, which comes as a new request')
})

test('the fast lane claims a request first, and the main agent leaves it alone until it is settled', () => {
  const claimed = claimFast(at(1, 2), 'r-2')
  assert.ok(claimed)
  assert.equal(claimFast(claimed, 'r-2'), null)
  assert.equal(register(claimed, 'r-2', true), claimed, 'the steered message arriving later does not reopen it')
  assert.match(decisionProblem(claimed, 'r-2') ?? '', /正由调度处理/)
  assert.equal(hasOpenWork(claimed), true)
  assert.equal(settleFast(claimed, 'r-2', true).requests['r-2'].status, 'handed')
  assert.equal(settleFast(claimed, 'r-2', false).requests['r-2'].status, 'pending', 'deferred: the main agent decides it')
})

test('undecided requests are reminded a bounded number of times, then fail; an error ending fails them at once', () => {
  const first = repairs(register(at(1, 1), 'r-1', false), 2)
  assert.deepEqual([first.retry, first.failed], [['r-1'], []])
  const second = repairs(first.ledger, 2)
  const third = repairs(second.ledger, 2)
  assert.deepEqual([third.retry, third.failed], [[], ['r-1']])
  assert.equal(third.ledger.requests['r-1'].status, 'failed')
  const busy = claimFast(register(at(1, 1), 'r-1', false), 'r-2')
  assert.ok(busy)
  const errored = failUndecided(busy)
  assert.deepEqual([...errored.failed].sort(), ['r-1', 'r-2'])
  assert.equal(hasOpenWork(errored.ledger), false)
})
