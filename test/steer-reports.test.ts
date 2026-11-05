import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSteerChannel } from '../plugins/steer/lib/channel.ts'
import { createReportDesk, REPORT_MARK, REPORT_SOURCE, reportIdsOf, type ReportAgent, type ReportMessage } from '../plugins/steer/lib/reports.ts'
import { createSteerDesk, NO_PLUGIN } from '../src/backend/steer-channel.ts'

/**
 * Background tasks' results through viva-steer (plugins/steer/lib/reports.ts, system-design §12.4): found again by
 * their report, read once written and flushed, lost when a turn drops them; and the app's side of the channel.
 */

const steered = (reportId: string): ReportMessage => ({ source: { kind: REPORT_SOURCE, reportId }, content: [{ type: 'text', text: '【后台任务结束】' }] })
const noted = (...ids: string[]): ReportMessage => ({ source: { kind: 'user' }, content: [{ type: 'text', text: ids.map((id) => `${REPORT_MARK}${id}`).join('\n') }] })

function agent({ status = 'running', flushes = true } = {}) {
  const state = { status, nextStep: [] as ReportMessage[], nextTurn: [] as ReportMessage[], history: [] as ReportMessage[], steers: [] as string[], flushes }
  const view: ReportAgent = {
    get status() { return state.status },
    inbox: { get nextStep() { return state.nextStep }, get nextTurn() { return state.nextTurn } },
    history: () => state.history,
    flush: async () => state.flushes,
    steer: (reportId) => { state.steers.push(reportId); state.nextStep = [...state.nextStep, steered(reportId)] },
  }
  return { state, view }
}

function desk(options?: Parameters<typeof agent>[0]) {
  const a = agent(options)
  const sent: Array<{ type: string, reportId: string }> = []
  const reports = createReportDesk({ agentOf: (sessionId) => (sessionId === 's1' ? a.view : null), send: (message) => { sent.push(message) } })
  return { reports, sent, state: a.state }
}

test('a message is its reports: by its source when steered in, by the note\'s lines when a turn was opened for them', () => {
  assert.deepEqual(reportIdsOf(steered('t1:run-1')), ['t1:run-1'])
  assert.deepEqual(reportIdsOf(noted('t1:run-1', 't2:run-3')), ['t1:run-1', 't2:run-3'])
  assert.deepEqual(reportIdsOf({ source: { kind: 'user' }, content: [{ type: 'text', text: '只是用户说的话' }] }), [])
  assert.deepEqual(reportIdsOf(null), [])
})

test('into the running turn once: there already (waiting, or in the history), it is not sent again', async () => {
  const { reports, state } = desk()
  assert.equal(await reports.status('s1', 't1:run-1'), 'none')
  assert.equal(await reports.deliver('s1', 't1:run-1', 'note'), 'steered')
  assert.equal(await reports.deliver('s1', 't1:run-1', 'note'), 'pending', 'in the inbox')
  state.nextStep = []
  state.history = [steered('t1:run-1')]
  assert.equal(await reports.deliver('s1', 't1:run-1', 'note'), 'read', 'in the history, flushed')
  assert.deepEqual(state.steers, ['t1:run-1'])
  assert.equal(await reports.deliver('s2', 't1:run-1', 'note'), null, 'no agent for that session')
})

test('no turn running: idle, for the app to open one; written but not flushed: pending, not read', async () => {
  const idle = desk({ status: 'idle' })
  assert.equal(await idle.reports.deliver('s1', 't1:run-1', 'note'), 'idle')
  assert.deepEqual(idle.state.steers, [])
  const unflushed = desk({ flushes: false })
  unflushed.state.history = [noted('t1:run-1')]
  assert.equal(await unflushed.reports.status('s1', 't1:run-1'), 'pending')
})

test('written in the history and flushed: read is said; not flushed: nothing yet', async () => {
  const { reports, sent } = desk()
  await reports.written('s1', noted('t1:run-1', 't2:run-1'))
  assert.deepEqual(sent, [{ type: 'report_read', sessionId: 's1', reportId: 't1:run-1' }, { type: 'report_read', sessionId: 's1', reportId: 't2:run-1' }])
  const quiet = desk({ flushes: false })
  await quiet.reports.written('s1', steered('t1:run-1'))
  assert.deepEqual(quiet.sent, [])
  await reports.written('s1', { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] })
  assert.equal(sent.length, 2, 'the user\'s own words are no report')
})

test('discarded from the inbox, or taken by a step that never wrote it: lost is said; taken and written: not', async () => {
  const { reports, sent, state } = desk()
  reports.discarded('s1', steered('t1:run-1'))
  reports.taken('s1', steered('t2:run-1'))
  assert.equal(await reports.status('s1', 't2:run-1'), 'pending', 'taken by a step: pending')
  reports.taken('s1', steered('t3:run-1'))
  state.history = [steered('t3:run-1')]
  reports.idle('s1')
  assert.deepEqual(sent.map(({ type, reportId }) => `${type} ${reportId}`), ['report_dropped t1:run-1', 'report_dropped t2:run-1'])
  assert.equal(await reports.status('s1', 't2:run-1'), 'none', 'lost: to be sent again')
})

test('the channel answers report requests; a request without what it needs fails', async () => {
  const sent: Array<Record<string, unknown>> = []
  let onMessage: (message: unknown) => void = () => {}
  const { reports } = desk()
  createSteerChannel({ send: (message) => { sent.push(message as Record<string, unknown>) }, on: (_: string, fn: (message: unknown) => void) => { onMessage = fn }, off: () => {} },
    () => null, () => {}, reports)
  onMessage({ type: 'report', id: 'r1', sessionId: 's1', reportId: 't1:run-1', text: 'note' })
  onMessage({ type: 'report_status', id: 'r2', sessionId: 's1', reportId: 't1:run-1' })
  onMessage({ type: 'report', id: 'r3', sessionId: 's1', reportId: 't1:run-1' })
  onMessage({ type: 'report_status', id: 'r4', sessionId: 'nobody', reportId: 't1:run-1' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  // One at a time, in the order asked: the status asked after the steer sees it waiting.
  assert.deepEqual([...sent].sort((a, b) => String(a.id).localeCompare(String(b.id))), [
    { type: 'report_result', id: 'r1', status: 'steered' },
    { type: 'report_result', id: 'r2', status: 'pending' },
    { type: 'report_result', id: 'r3', status: 'failed' },
    { type: 'report_result', id: 'r4', status: 'missing' },
  ])
})

test('the app\'s side: each report request answered by the plugin or a timeout; read and lost heard for its session only', async () => {
  const sent: Array<Record<string, unknown>> = []
  const heard: Array<{ type: string, reportId: string }> = []
  const steering = createSteerDesk({ send: (message) => { sent.push(message as Record<string, unknown>) }, sessionId: () => 's1', timeoutMs: 20, onReport: (event) => { heard.push(event) } })
  const asked = steering.report('t1:run-1', 'note')
  assert.deepEqual([sent[0].type, sent[0].sessionId, sent[0].reportId, sent[0].text], ['report', 's1', 't1:run-1', 'note'])
  steering.receive({ type: 'report_result', id: sent[0].id, status: 'steered' })
  assert.equal(await asked, 'steered')
  assert.equal(await steering.reportStatus('t1:run-1'), NO_PLUGIN, 'no answer: the plugin is not there')
  steering.receive({ type: 'report_read', sessionId: 's1', reportId: 't1:run-1' })
  steering.receive({ type: 'report_dropped', sessionId: 'other', reportId: 't9:run-1' })
  assert.deepEqual(heard, [{ type: 'report_read', reportId: 't1:run-1' }], 'another session\'s report is not the app\'s')
})
