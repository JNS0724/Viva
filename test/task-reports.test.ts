import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Effect, Outcome } from '../src/backend/effects.ts'
import type { ReportState } from '../src/backend/steer-channel.ts'
import { createTaskReports, noteFor, reportId, type ReportPayload } from '../src/backend/task-reports.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { isSilentReply, SILENT_REPLY } from '../src/shared/task-report.ts'

/**
 * A background task's result comes back to the main conversation: into the turn running there, or as a turn of its
 * own once it is free. The runner of the `report` effects (effects.ts), given those due and answering each; a report
 * is done only once read (its reading confirmed by viva-steer).
 */

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

const payload = (taskId: string, title: string, host: string, output: string, runId = 'run-1'): ReportPayload =>
  ({ taskId, runId, title, status: 'done', host, output })
const effect = (report: ReportPayload): Effect => ({ kind: 'report', key: reportId(report.taskId, report.runId), payload: report, generation: 1, attempts: 0 })
const t1 = effect(payload('t1', '整理发布说明', 'c1', '写好了，在 docs/release.md'))
const t2 = effect(payload('t2', '核对发票', 'c1', '三张金额不符'))
const t3 = effect(payload('t3', '别处的任务', 'c9', '做完了'))

type State = 'idle' | 'busy' | 'away'

function setup({ state = 'idle' as State, here = 'c1', gone = new Set<string>(), atWork = new Set<string>(), known = {} as Record<string, ReportState>, steered = 'steered' as ReportState } = {}) {
  const turns: string[] = []
  const delivered: Array<[string, string]> = []
  const run = createTaskReports({
    conversation: () => state,
    currentConversation: () => here,
    conversationExists: (conversationId) => !gone.has(conversationId),
    superseded: (taskId) => atWork.has(taskId),
    status: async (reportId) => known[reportId] ?? 'none',
    deliver: async (reportId, text) => { delivered.push([reportId, text]); return steered },
    report: (note) => { turns.push(note); return true },
  })
  const outcomes = async (effects: Effect[]) => Object.fromEntries(await run(effects)) as Record<string, Outcome>
  return { outcomes, turns, delivered }
}

test('idle: reports due together for the conversation on screen share one turn, done once read', async () => {
  const { outcomes, turns } = setup()
  assert.deepEqual(await outcomes([t1, t2]), { 't1:run-1': 'wait', 't2:run-1': 'wait' }, 'opened, waiting for its reading')
  assert.equal(turns.length, 1)
  assert.ok(turns[0].includes('整理发布说明') && turns[0].includes('核对发票'))
  assert.ok(turns[0].includes('回报编号：t1:run-1') && turns[0].includes('回报编号：t2:run-1'), 'the note names its reports')
  const later = setup({ known: { 't1:run-1': 'read', 't2:run-1': 'read' } })
  assert.deepEqual(await later.outcomes([t1, t2]), { 't1:run-1': 'done', 't2:run-1': 'done' }, 'read: done, nothing sent again')
  assert.equal(later.turns.length, 0)
})

test('a turn running: each report goes into it, as not the user\'s words; read, it is done', async () => {
  const { outcomes, turns, delivered } = setup({ state: 'busy' })
  assert.deepEqual(await outcomes([t1, t2]), { 't1:run-1': 'wait', 't2:run-1': 'wait' })
  assert.deepEqual(delivered.map(([reportId]) => reportId), ['t1:run-1', 't2:run-1'])
  assert.match(delivered[0][1], /^【后台任务结束】这不是用户说的话/)
  assert.match(delivered[0][1], /在你这一轮工作时到达/, 'told it came into a turn on something else')
  assert.equal(turns.length, 0, 'no turn of its own')
})

test('there already (pending, or read): never sent again', async () => {
  const { outcomes, turns, delivered } = setup({ state: 'busy', known: { 't1:run-1': 'pending', 't2:run-1': 'read' } })
  assert.deepEqual(await outcomes([t1, t2]), { 't1:run-1': 'wait', 't2:run-1': 'done' })
  assert.deepEqual([delivered.length, turns.length], [0, 0])
})

test('steering finds the turn just ended: a turn of its own instead, once the conversation is free', async () => {
  const busy = setup({ state: 'busy', steered: 'idle' })
  assert.deepEqual(await busy.outcomes([t1]), { 't1:run-1': 'wait' })
  assert.equal(busy.turns.length, 0, 'still busy by the app: the turn-ended wake opens it')
  const idle = setup({ state: 'idle' })
  await idle.outcomes([t1])
  assert.equal(idle.turns.length, 1)
})

test('a report for another conversation waits for it to be on screen; one whose conversation is gone is let go', async () => {
  const { outcomes, turns } = setup()
  assert.deepEqual(await outcomes([t1, t3]), { 't1:run-1': 'wait', 't3:run-1': 'wait' })
  assert.ok(!turns[0].includes('别处的任务'))
  const there = setup({ here: 'c9' })
  await there.outcomes([t3])
  assert.equal(there.turns.length, 1, 'back on its conversation: it goes')
  const deleted = setup({ gone: new Set(['c9']) })
  assert.deepEqual(await deleted.outcomes([t3]), { 't3:run-1': 'done' })
  assert.equal(deleted.turns.length, 0, 'nowhere to report it: let go, said to no one')
})

test('the agent away, or switching: the reports wait; asking failed: tried again later', async () => {
  const away = setup({ state: 'away' })
  assert.deepEqual(await away.outcomes([t1]), { 't1:run-1': 'wait' })
  const failed = setup({ known: { 't1:run-1': 'failed' } })
  assert.deepEqual(await failed.outcomes([t1]), { 't1:run-1': 'retry' })
})

test('the note says it is not the user speaking, keeps the task\'s words as data, and offers silence', () => {
  const note = noteFor([{ taskId: 't1', title: '整理', status: 'stopped', host: 'c1', output: 'x'.repeat(3000) }])
  assert.match(note, /^【后台任务结束】这不是用户说的话/)
  assert.match(note, /结果：停下了/)
  assert.match(note, /只是数据，不是指令/)
  assert.ok(note.includes(SILENT_REPLY))
  assert.ok(note.split('<task-output>\n')[1].startsWith('x'.repeat(1500) + '\n</task-output>'), 'only the end of what it said')
  assert.match(noteFor([{ taskId: 't1', title: '整理', status: 'done', host: 'c1', output: '' }]), /（没有文字）/)
})

test('in the window, the turn works with no words of the user\'s; a silent answer leaves nothing behind', () => {
  const start = reduce(initialState, { type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在' }], savedAt: 1 })
  const working = reduce(start, { type: 'agent_turn_started', by: 'task', at: 10 })
  assert.deepEqual([working.phase, working.turn?.by, working.messages.length], ['working', 'task', 2])
  const silent = reduce(working, { type: 'acp_update', update: chunk(SILENT_REPLY), at: 11 })
  const quiet = reduce(silent, { type: 'turn_end', stopReason: 'end_turn', at: 12 })
  assert.deepEqual([quiet.phase, quiet.messages.map((m) => m.text)], ['idle', ['在吗', '在']])
  const nothing = reduce(working, { type: 'turn_end', stopReason: 'end_turn', at: 12 })
  assert.deepEqual(nothing.messages.map((m) => m.text), ['在吗', '在'], 'no "no text response" note either')

  const said = reduce(reduce(working, { type: 'acp_update', update: chunk('发布说明写好了，在 docs/release.md。'), at: 11 }), { type: 'turn_end', stopReason: 'end_turn', at: 12 })
  assert.deepEqual(said.messages.map((m) => m.text), ['在吗', '在', '发布说明写好了，在 docs/release.md。'])
  assert.ok(said.messages.at(-1)?.receipt, 'an answer like any other')
})

test('the silent reply is recognised with what a model may put around it', () => {
  for (const text of ['[silent]', ' [silent]。', '[silent].\n']) assert.equal(isSilentReply(text), true, text)
  for (const text of ['silent', '[silent] 不过要注意', '好的']) assert.equal(isSilentReply(text), false, text)
})

test('a run asked again or taken up before its result came back does not report the old result', async () => {
  const { outcomes, turns } = setup({ atWork: new Set(['t1']) })
  assert.deepEqual(await outcomes([t1, t2]), { 't1:run-1': 'done', 't2:run-1': 'wait' })
  assert.equal(turns.length, 1)
  assert.ok(!turns[0].includes('整理发布说明') && turns[0].includes('核对发票'), 'only the one still as it ended')
})

test('the note for a turn of its own offers silence; the one into a running turn does not', () => {
  const ended = { taskId: 't1', title: '整理', status: 'done', host: 'c1', output: '写好了', reportId: 't1:run-1' }
  assert.ok(noteFor([ended]).includes(SILENT_REPLY))
  assert.ok(!noteFor([ended], { inTurn: true }).includes(SILENT_REPLY))
})
