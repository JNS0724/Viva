import { test } from 'node:test'
import assert from 'node:assert/strict'
import { admit, APP_CHANGE_TOOLS, layerOf, MAIN_SCOPE, type Grant } from '../plugins/routing/lib/policy.ts'

test('the main scope holds routing, context and the app tools, and nothing that executes work', () => {
  assert.ok(MAIN_SCOPE.includes('commit_route') && MAIN_SCOPE.includes('search_conversations') && MAIN_SCOPE.includes('schedule_create'))
  for (const tool of ['bash', 'write', 'edit', 'web_search', 'subagent', 'start_background_task', 'ask_user_question', 'mcp__mail__create_draft']) {
    assert.equal(layerOf(tool), 'execution', tool)
    assert.ok(!MAIN_SCOPE.includes(tool), tool)
  }
})

test('context and app queries need no grant; execution is always refused', () => {
  assert.equal(admit([], 'read_conversation').allowed, true)
  assert.equal(admit([], 'schedule_list').allowed, true)
  const refused = admit([], 'bash')
  assert.equal(refused.allowed, false)
  assert.match(refused.reason ?? '', /交给任务/)
})

test('an app change needs a grant from a committed app_action, and one grant allows exactly one call', () => {
  assert.match(admit([], 'memory_remember').reason ?? '', /先用 commit_route 提交 app_operation/)
  const grants: Grant[] = [{ requestId: 'r-1', operation: 'schedule_create' }, { requestId: 'r-1', operation: 'memory_remember' }]
  const first = admit(grants, 'memory_remember')
  assert.equal(first.allowed, true)
  assert.deepEqual(first.grants, [{ requestId: 'r-1', operation: 'schedule_create' }])
  assert.equal(admit(first.grants, 'memory_remember').allowed, false, 'the grant was used up')
  assert.equal(grants.length, 2, 'the grants passed in are left as they were')
})

test('every app change tool is in the main scope', () => {
  for (const tool of APP_CHANGE_TOOLS) assert.equal(layerOf(tool), 'app-change', tool)
})
