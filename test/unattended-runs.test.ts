import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUnattendedRuns, type TaskEvent, type UnattendedAgent } from '../src/backend/unattended-runs.ts'

/** A prompt run where nobody watches (unattended-runs.ts): its own read-only session, its last answer the result. */

const chunk = (taskId: string, text: string): TaskEvent => ({ type: 'task_update', taskId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
const toolCall = (taskId: string): TaskEvent => ({ type: 'task_update', taskId, update: { sessionUpdate: 'tool_call', toolCallId: 'c1' } })

function setup({ started = { ok: true, taskId: 't1' } as { ok: boolean, taskId?: string } } = {}) {
  const calls: string[] = []
  let onPrompt: (taskId: string) => void = () => {}
  const agent: UnattendedAgent = {
    startUnattendedTask: async ({ cwd }) => { calls.push(`start ${cwd}`); return started },
    promptTask: (taskId, text) => { calls.push(`prompt ${taskId} ${text}`); onPrompt(taskId) },
    closeTask: (taskId) => { calls.push(`close ${taskId}`) },
  }
  let timers: Array<() => void> = []
  const runs = createUnattendedRuns({ agent: () => agent, later: (run) => { timers = [...timers, run]; return run }, cancel: (timer) => { timers = timers.filter((run) => run !== (timer as unknown)) } })
  return { runs, calls, timers: () => timers, prompted: (handler: (taskId: string) => void) => { onPrompt = handler } }
}

test('its events are its own; the answer after its last step is the result; the session closes', async () => {
  const { runs, calls, prompted } = setup()
  prompted((taskId) => {
    assert.ok(runs.owns(taskId), 'its events go to it, not to 后台')
    runs.receive(chunk(taskId, '我先看看文件。'))
    runs.receive(toolCall(taskId))
    runs.receive(chunk(taskId, '周报草稿：'))
    runs.receive(chunk(taskId, '本周完成三件事。'))
    runs.receive({ type: 'task_end', taskId, stopReason: 'end_turn' })
  })
  assert.deepEqual(await runs.run('起草周报', '/work'), { ok: true, text: '周报草稿：本周完成三件事。' })
  assert.deepEqual(calls, ['start /work', 'prompt t1 起草周报', 'close t1'], 'in the folder it was given')
  assert.equal(runs.owns('t1'), false)
})

test('a turn that errs, says nothing or runs too long fails; no session, or dsh gone, is unavailable', async () => {
  const erring = setup()
  erring.prompted((taskId) => erring.runs.receive({ type: 'task_end', taskId, stopReason: 'error', message: '模型出错' }))
  assert.deepEqual(await erring.runs.run('x', '/work'), { ok: false, problem: '模型出错' })

  const silent = setup()
  silent.prompted((taskId) => silent.runs.receive({ type: 'task_end', taskId, stopReason: 'end_turn' }))
  assert.equal((await silent.runs.run('x', '/work')).ok, false)

  const slow = setup()
  slow.prompted(() => slow.timers()[0]())
  assert.equal((await slow.runs.run('x', '/work')).ok, false)
  assert.ok(slow.calls.includes('close t1'), 'stopped and closed')

  assert.deepEqual(await setup({ started: { ok: false } }).runs.run('x', '/work'), { ok: false, problem: 'unavailable', unavailable: true })
  const none = createUnattendedRuns({ agent: () => null })
  assert.equal((await none.run('x', '/work') as { unavailable?: boolean }).unavailable, true)

  const going = setup()
  going.prompted(() => going.runs.gone())
  assert.equal((await going.runs.run('x', '/work') as { unavailable?: boolean }).unavailable, true)
})
