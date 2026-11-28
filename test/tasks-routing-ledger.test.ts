import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atStep, claimFast, decide, decisionProblem, EMPTY_LEDGER, hasOpenWork, hasPendingRequest, mayShow, register, repairs, settleFast, statusOfPlan } from '../plugins/routing/lib/ledger.ts'
import { admit, grantPlan, INITIAL_TURN_GRANTS, layerOf, MAIN_SCOPE } from '../plugins/routing/lib/policy.ts'

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
  assert.equal(hasPendingRequest(claimed), true, 'fast-lane undecided request blocks peek consumption')
  assert.equal(claimFast(claimed, 'r-1'), null)
  assert.equal(register(claimed, 'r-1'), claimed, 'seen in the conversation later, it stays the fast lane\'s')
  assert.match(String(decisionProblem(claimed, 'r-1')), /调度处理/)
  assert.equal(settleFast(claimed, 'r-1', null).requests['r-1']!.status, 'pending')
  assert.equal(settleFast(claimed, 'r-1', 'handed').requests['r-1']!.status, 'handed')
  const undone = settleFast(atStep(claimed, 3), 'r-1', statusOfPlan(['start'], true)).requests['r-1']!
  assert.deepEqual([undone.status, undone.decidedAt], ['answering', 3], 'decided by the host but not done: the agent says so, it does not route it again')
  assert.equal(decisionProblem(settleFast(claimed, 'r-1', 'answering'), 'r-1'), null, 'the host refuses a second commit; nothing here pretends otherwise')
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

test('the main agent\'s tools: route, context and app queries free; dir-peek once pre-route; peek gated on reply; app changes need a grant each; execution never', () => {
  assert.equal(layerOf('commit_route'), 'route')
  for (const tool of ['memory_recall', 'memory_read', 'memory_node_search']) {
    assert.equal(layerOf(tool), 'context')
    assert.ok(MAIN_SCOPE.includes(tool))
  }
  assert.equal(layerOf('glob'), 'dir-peek')
  assert.ok(MAIN_SCOPE.includes('glob'))
  for (const tool of ['read', 'grep', 'read_image']) {
    assert.equal(layerOf(tool), 'peek', tool)
    assert.ok(MAIN_SCOPE.includes(tool), tool)
  }
  assert.equal(layerOf('schedule_list'), 'app-query')
  assert.equal(layerOf('schedule_create'), 'app-change')
  assert.equal(layerOf('answer_background_task'), 'app-change')
  assert.ok(MAIN_SCOPE.includes('answer_background_task'))
  for (const tool of ['bash', 'pwsh', 'write', 'web_fetch', 'subagent', 'ask_user_question', 'mcp__demo__send_email']) {
    assert.equal(layerOf(tool), 'execution', tool)
    assert.equal(MAIN_SCOPE.includes(tool), false, tool)
  }
  assert.equal(admit(INITIAL_TURN_GRANTS, 'bash').allowed, false)

  // Pre-route (a request is pending): glob allowed once, read/grep/read_image denied.
  const pendingLedger = register(EMPTY_LEDGER, 'r-1')
  assert.equal(hasPendingRequest(pendingLedger), true)
  assert.equal(admit(INITIAL_TURN_GRANTS, 'read', { hasPending: true }).allowed, false)
  const firstGlob = admit(INITIAL_TURN_GRANTS, 'glob', { hasPending: true })
  assert.equal(firstGlob.allowed, true)
  assert.equal(admit(firstGlob.state, 'glob', { hasPending: true }).allowed, false)

  // Non-reply plans grant zero peeks.
  const startPlan = { goals: [{ goal: '做简报', disposition: 'delegate' }], actions: [{ kind: 'start', brief: '做简报' }] }
  const afterStart = grantPlan(firstGlob.state, startPlan)
  assert.equal(afterStart.peek, 0)
  assert.equal(admit(afterStart, 'read', { hasPending: false }).allowed, false)

  // Reply grants 2 peeks; a new pending interjection pauses peek consumption; turn cap is 3 across multiple replies.
  const replyPlan = { goals: [{ goal: '查配置', disposition: 'answer' }], actions: [{ kind: 'reply', scope: '查配置' }] }
  const afterReply = grantPlan(INITIAL_TURN_GRANTS, replyPlan)
  assert.equal(afterReply.peek, 2)
  assert.equal(afterReply.dirPeek, 2)
  assert.equal(admit(afterReply, 'read', { hasPending: true }).allowed, false, 'paused while an interjection awaits routing')
  const glob1 = admit(afterReply, 'glob', { hasPending: false })
  const glob2 = admit(glob1.state, 'glob', { hasPending: false })
  assert.equal(glob1.allowed && glob2.allowed, true)
  assert.equal(admit(glob2.state, 'glob', { hasPending: false }).allowed, false, 'post-reply glob capped at 2')
  assert.equal(glob2.state.peek, 2, 'listing filenames via glob does not drain content peek grants')
  const peek1 = admit(glob2.state, 'read', { hasPending: false })
  const peek2 = admit(peek1.state, 'grep', { hasPending: false })
  assert.equal(peek1.allowed && peek2.allowed, true)
  assert.equal(admit(peek2.state, 'read_image', { hasPending: false }).allowed, false, 'used up its 2 peeks')
  const secondReply = grantPlan(peek2.state, replyPlan)
  assert.equal(secondReply.peek, 1, 'turn cap of 3 limits second reply to 1 more peek')
  assert.equal(secondReply.dirPeek, 1, 'turn cap of 3 limits second reply to 1 more glob')
  const glob3 = admit(secondReply, 'glob', { hasPending: false })
  assert.equal(glob3.allowed, true)
  assert.equal(admit(glob3.state, 'glob', { hasPending: true }).allowed, false, '4th glob denied even for a later pending interjection once 3 globs were granted')
  const afterPreGlobReply1 = grantPlan(firstGlob.state, replyPlan)
  assert.equal(afterPreGlobReply1.dirPeek, 2)
  const afterPreGlobReply2 = grantPlan(afterPreGlobReply1, replyPlan)
  assert.equal(afterPreGlobReply2.dirPeek, 2, 'pre-route glob counts toward the 3-per-turn glob cap')

  // App-change grants remain one-for-one.
  assert.match(String(admit(INITIAL_TURN_GRANTS, 'schedule_create').reason), /app_operation/)
  assert.match(String(admit(INITIAL_TURN_GRANTS, 'answer_background_task').reason), /app_operation/)
  const answerGranted = grantPlan(INITIAL_TURN_GRANTS, {
    goals: [{ goal: '回答任务', disposition: 'app_operation' }],
    actions: [{ kind: 'app_action', operation: 'answer_background_task' }],
  })
  const answerUsed = admit(answerGranted, 'answer_background_task')
  assert.deepEqual([answerUsed.allowed, answerUsed.state.app], [true, []])
  assert.equal(admit(answerUsed.state, 'answer_background_task').allowed, false)

  const twoAppGrants = grantPlan(INITIAL_TURN_GRANTS, {
    goals: [{ goal: '定时', disposition: 'app_operation' }, { goal: '记忆', disposition: 'app_operation' }],
    actions: [{ kind: 'app_action', operation: 'schedule_create' }, { kind: 'app_action', operation: 'memory_remember' }],
  })
  const once = admit(twoAppGrants, 'schedule_create')
  assert.deepEqual([once.allowed, once.state.app], [true, ['memory_remember']])
  assert.equal(admit(once.state, 'schedule_create').allowed, false, 'one grant allows one call')
})
