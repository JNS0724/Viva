import assert from 'node:assert/strict'
import test from 'node:test'
import { taskRunOf, waitForReportedTaskRun } from './smoke/smoke-task-report.ts'
import type { SmokeWindow } from './smoke/smoke-kit.ts'

const taskId = 'restored-task', oldRun = 'old-run', newRun = 'new-run', title = 'same task title'
const oldReply = { role: 'assistant', text: `已看过后台结果：${title}` }

function harness() {
  const state = { runId: oldRun, status: 'done', records: [{ reportId: `${taskId}:${oldRun}`, after: 0 }],
    messages: [oldReply], busy: false, typing: false }
  const reads = { task: 0, history: 0 }
  const observers: Array<{ kind: keyof typeof reads, count: number, resolve(): void }> = []
  const agent = {
    finishedTasks: async () => [{ task: { id: taskId, title }, mark: { runId: state.runId }, status: state.status }],
    loadHistory: async () => ({ records: state.records, messages: state.messages }),
  }
  const documentMock = {
    getElementById: (id: string) => { assert.equal(id, 'send-btn'); return { dataset: { busy: String(state.busy) }, disabled: false } },
    querySelector: (selector: string) => { assert.equal(selector, '.caret'); return state.typing ? {} : null },
  }
  const win = { webContents: { executeJavaScript: async (code: string): Promise<unknown> => {
    const evaluate = new Function('window', 'document', `return ${code}`) as (window: { agent: typeof agent }, document: typeof documentMock) => unknown
    const value = await evaluate({ agent }, documentMock)
    const kind = code.includes('loadHistory') ? 'history' : 'task'
    reads[kind]++
    for (const observer of observers) if (reads[observer.kind] >= observer.count) observer.resolve()
    return value
  } } } as SmokeWindow
  const observed = (kind: keyof typeof reads, count: number) => reads[kind] >= count ? Promise.resolve()
    : new Promise<void>(resolve => { observers.push({ kind, count, resolve }) })
  const complete = () => {
    state.runId = newRun; state.status = 'done'; state.busy = false; state.typing = false
    state.records = [{ reportId: `${taskId}:${newRun}`, after: 1 }]
    state.messages = [oldReply, { ...oldReply }]
  }
  return { state, reads, win, agent, observed, complete }
}

test('resume waits for the exact late task report, its new reply and the foreground end before switching topics', async t => {
  const h = harness()
  const previousRun = await taskRunOf(h.win, taskId)
  assert.equal(previousRun, oldRun)
  let switched = false
  const following = waitForReportedTaskRun(h.win, taskId, previousRun, title).then(() => {
    assert.equal(h.state.busy, false)
    switched = true
  })
  t.after(async () => { h.complete(); await following })
  await h.observed('task', 2)
  assert.equal(switched, false, 'the older completed run and its same-title reply do not complete the phase')
  h.state.runId = newRun
  await h.observed('history', 1)
  assert.equal(switched, false, 'the initial idle gap before the report is not a terminal state')
  h.state.records = [{ reportId: `another-task:${newRun}`, after: 1 }]
  await h.observed('history', 2)
  assert.equal(switched, false, 'a different task report cannot satisfy this run')
  h.state.records = [{ reportId: `${taskId}:${newRun}`, after: 1 }]
  await h.observed('history', 3)
  assert.equal(switched, false, 'the durable receipt alone cannot mistake stale idle UI for the completed new report')
  h.state.messages = [oldReply, { ...oldReply }]
  h.state.busy = true
  await h.observed('history', 4)
  assert.equal(switched, false, 'the task answer is done while its late foreground report is still active')
  h.state.busy = false; h.state.typing = true
  await h.observed('history', 5)
  assert.equal(switched, false, 'the new report must finish typing too')
  h.state.typing = false
  await following
  assert.equal(switched, true)
})

test('report boundary reads preserve application errors instead of retrying them into a timeout', async () => {
  const h = harness()
  h.agent.finishedTasks = async () => { throw new Error('native task lookup failed') }
  await assert.rejects(taskRunOf(h.win, taskId), /native task lookup failed/)
  const live = harness()
  live.state.runId = newRun
  live.agent.loadHistory = async () => { throw new Error('history unavailable') }
  await assert.rejects(waitForReportedTaskRun(live.win, taskId, oldRun, title), /history unavailable/)
})
