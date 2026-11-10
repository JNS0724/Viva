import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atStep, claimFast, decide, decisionProblem, EMPTY_LEDGER, hasOpenWork, mayShow, register, repairs, settleFast, statusOfPlan } from '../plugins/routing/lib/ledger.ts'
import { admit, layerOf, MAIN_SCOPE } from '../plugins/routing/lib/policy.ts'

test('a turn with no request (a task result coming back) speaks; with one, only after leave to speak and none undecided', () => {
  assert.equal(mayShow(EMPTY_LEDGER, 1), true)
  let ledger = register(atStep(EMPTY_LEDGER, 1), 'r-1')
  assert.equal(mayShow(ledger, 1), false, 'the routing step shows nothing')
  ledger = decide(ledger, 'r-1', statusOfPlan(['reply'], false))
  assert.equal(mayShow(ledger, 1), false, 'not the step that committed')
  assert.equal(mayShow(atStep(ledger, 2), 2), true)
  ledger = register(atStep(ledger, 3), 'r-2')
  assert.equal(mayShow(ledger, 3), false, 'an interjection waiting for its decision holds text back')
  assert.equal(Object.isFrozen(ledger) && Object.isFrozen(ledger.requests), true)
})

test('a plan sets what follows: answer, ask, act on an app tool, or hand over; a failed handover is said', () => {
  assert.equal(statusOfPlan(['start'], false), 'handed')
  assert.equal(statusOfPlan(['start'], true), 'answering')
  assert.equal(statusOfPlan(['app_action', 'start'], false), 'acting')
  assert.equal(statusOfPlan(['clarify'], false), 'asking')
  const handed = decide(register(EMPTY_LEDGER, 'r-1'), 'r-1', 'handed')
  assert.equal(hasOpenWork(handed), false, 'nothing left: the turn may end')
  assert.equal(hasOpenWork(decide(handed, 'r-2', 'answering')), true)
})

test('the fast lane claims an interjection first; the agent may not commit it meanwhile; deferring gives it back', () => {
  const claimed = claimFast(EMPTY_LEDGER, 'r-1')!
  assert.equal(claimFast(claimed, 'r-1'), null)
  assert.equal(register(claimed, 'r-1'), claimed, 'seen in the conversation later, it stays the fast lane\'s')
  assert.match(String(decisionProblem(claimed, 'r-1')), /调度处理/)
  assert.equal(settleFast(claimed, 'r-1', false).requests['r-1']!.status, 'pending')
  assert.equal(settleFast(claimed, 'r-1', true).requests['r-1']!.status, 'handed')
})

test('undecided requests are reminded at most twice, then left for the host to fail', () => {
  let ledger = register(EMPTY_LEDGER, 'r-1')
  for (const round of [1, 2]) {
    const plan = repairs(ledger, 2)
    assert.deepEqual([plan.retry, plan.left], [['r-1'], []], `round ${round}`)
    ledger = plan.ledger
  }
  const last = repairs(ledger, 2)
  assert.deepEqual([last.retry, last.left], [[], ['r-1']])
  assert.equal(hasOpenWork(last.ledger), false)
})

test('the main agent\'s tools: route, context and app queries free; app changes need a grant each; the rest never', () => {
  assert.equal(layerOf('commit_route'), 'route')
  assert.equal(layerOf('memory_recall'), 'context')
  assert.equal(layerOf('schedule_list'), 'app-query')
  assert.equal(layerOf('schedule_create'), 'app-change')
  for (const tool of ['bash', 'pwsh', 'write', 'web_fetch', 'subagent', 'ask_user_question', 'mcp__demo__send_email']) {
    assert.equal(layerOf(tool), 'execution', tool)
    assert.equal(MAIN_SCOPE.includes(tool), false, tool)
  }
  assert.equal(admit([], 'read').allowed, true)
  assert.equal(admit([], 'bash').allowed, false)
  assert.match(String(admit([], 'schedule_create').reason), /app_operation/)
  const once = admit(['schedule_create', 'memory_remember'], 'schedule_create')
  assert.deepEqual([once.allowed, once.grants], [true, ['memory_remember']])
  assert.equal(admit(once.grants, 'schedule_create').allowed, false, 'one grant allows one call')
})
