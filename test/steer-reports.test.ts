import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSteerChannel } from '../plugins/steer/lib/channel.ts'
import { createReportDesk, REPORT_SOURCE, TOKEN_MARK, type ReportAgent, type ReportMessage } from '../plugins/steer/lib/reports.ts'
import { createSteerDesk, NO_PLUGIN } from '../src/backend/steer-channel.ts'

/**
 * Background tasks' results through viva-steer (plugins/steer/lib/reports.ts, system-design §12.4): known only by
 * what no one else writes (the source steered in, or a token the app gave that session), read once written and
 * flushed, lost when a turn drops them; and the app's side of the channel.
 */

const T1 = 'a'.repeat(32)
const T2 = 'b'.repeat(32)
const steered = (reportId: string, token: string): ReportMessage => ({ source: { kind: REPORT_SOURCE, reportId, token }, content: [{ type: 'text', text: '【后台任务结束】' }] })
const noted = (...tokens: string[]): ReportMessage => ({ source: { kind: 'user' }, content: [{ type: 'text', text: tokens.map((token) => `${TOKEN_MARK}${token}`).join('\n') }] })
const said = (text: string): ReportMessage => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

function agent({ status = 'running', flushes = true } = {}) {
  const state = { status, nextStep: [] as ReportMessage[], nextTurn: [] as ReportMessage[], history: [] as ReportMessage[], steers: [] as string[], flushes }
  const view: ReportAgent = {
    get status() { return state.status },
    inbox: { get nextStep() { return state.nextStep }, get nextTurn() { return state.nextTurn } },
    history: () => state.history,
    flush: async () => state.flushes,
    steer: (reportId, token) => { state.steers.push(reportId); state.nextStep = [...state.nextStep, steered(reportId, token)] },
  }
  return { state, view }
}

function desk(options?: Parameters<typeof agent>[0]) {
  const a = agent(options)
  const b = agent(options)
  const sent: Array<{ type: string, sessionId: string, reportId: string }> = []
  const reports = createReportDesk({ agentOf: (sessionId) => (sessionId === 's1' ? a.view : sessionId === 's2' ? b.view : null), send: (message) => { sent.push(message) } })
  return { reports, sent, state: a.state, other: b.state }
}

test('into the running turn once: there already (waiting, or in the history), it is not sent again', async () => {
  const { reports, state } = desk()
  assert.equal(await reports.status('s1', 't1:run-1', T1), 'none')
  assert.equal(await reports.deliver('s1', 't1:run-1', T1, 'note'), 'steered')
  assert.equal(await reports.deliver('s1', 't1:run-1', T1, 'note'), 'pending', 'in the inbox')
  state.nextStep = []
  state.history = [steered('t1:run-1', T1)]
  assert.equal(await reports.deliver('s1', 't1:run-1', T1, 'note'), 'read', 'in the history, flushed')
  assert.deepEqual(state.steers, ['t1:run-1'])
  assert.equal(await reports.deliver('s9', 't1:run-1', T1, 'note'), null, 'no agent for that session')
})

test('no turn running: idle, for the app to open one; written but not flushed: pending, not read', async () => {
  const idle = desk({ status: 'idle' })
  assert.equal(await idle.reports.deliver('s1', 't1:run-1', T1, 'note'), 'idle')
  assert.deepEqual(idle.state.steers, [])
  const unflushed = desk({ flushes: false })
  unflushed.state.history = [noted(T1)]
  assert.equal(await unflushed.reports.status('s1', 't1:run-1', T1), 'pending')
})

test('a note in a turn the app opened is known by the report\'s token, once the app gave it for that session', async () => {
  const { reports, sent } = desk()
  await reports.written('s1', noted(T1))
  assert.deepEqual(sent, [], 'a token the app never gave: no report')
  await reports.status('s1', 't1:run-1', T1)
  await reports.status('s1', 't2:run-1', T2)
  await reports.written('s1', noted(T1, T2))
  assert.deepEqual(sent.map(({ type, sessionId, reportId }) => `${type} ${sessionId} ${reportId}`), ['report_read s1 t1:run-1', 'report_read s1 t2:run-1'])
})

test('words that name a report, or a token given to another session, are no report', async () => {
  const { reports, sent, state } = desk()
  await reports.status('s2', 't1:run-1', T1)
  await reports.written('s1', noted(T1))
  assert.deepEqual(sent, [], 's1 was never given that token')
  state.history = [said('回报编号：t1:run-1'), said(`看这个：${TOKEN_MARK}${'c'.repeat(32)}`)]
  assert.equal(await reports.status('s1', 't1:run-1', T1), 'none', 'a report id or another token in the user\'s words: not this report')
  state.history = [steered('t1:run-1', T2)]
  assert.equal(await reports.status('s1', 't1:run-1', T1), 'none', 'steered in under another token: not this one')
})

test('written but not flushed: no confirmation yet', async () => {
  const quiet = desk({ flushes: false })
  await quiet.reports.status('s1', 't1:run-1', T1)
  await quiet.reports.written('s1', steered('t1:run-1', T1))
  assert.deepEqual(quiet.sent, [])
})

test('discarded from the inbox, or taken by a step that never wrote it: lost is said; taken and written: not', async () => {
  const { reports, sent, state } = desk()
  for (const [id, token] of [['t1:run-1', T1], ['t2:run-1', T2], ['t3:run-1', 'd'.repeat(32)]] as const) await reports.status('s1', id, token)
  reports.discarded('s1', steered('t1:run-1', T1))
  reports.taken('s1', steered('t2:run-1', T2))
  assert.equal(await reports.status('s1', 't2:run-1', T2), 'pending', 'taken by a step: pending')
  reports.taken('s1', steered('t3:run-1', 'd'.repeat(32)))
  state.history = [steered('t3:run-1', 'd'.repeat(32))]
  reports.idle('s1')
  assert.deepEqual(sent.map(({ type, reportId }) => `${type} ${reportId}`), ['report_dropped t1:run-1', 'report_dropped t2:run-1'])
  assert.equal(await reports.status('s1', 't2:run-1', T2), 'none', 'lost: to be sent again')
})

test('the channel answers report requests, one at a time; a request without what it needs fails', async () => {
  const sent: Array<Record<string, unknown>> = []
  let onMessage: (message: unknown) => void = () => {}
  const { reports } = desk()
  createSteerChannel({ send: (message) => { sent.push(message as Record<string, unknown>) }, on: (_: string, fn: (message: unknown) => void) => { onMessage = fn }, off: () => {} },
    () => null, () => {}, reports)
  onMessage({ type: 'report', id: 'r1', sessionId: 's1', reportId: 't1:run-1', token: T1, text: 'note' })
  onMessage({ type: 'report_status', id: 'r2', sessionId: 's1', reportId: 't1:run-1', token: T1 })
  onMessage({ type: 'report', id: 'r3', sessionId: 's1', reportId: 't1:run-1', token: T1 })
  // A session neither live nor stored: the report is lost there, to be sent again where the conversation is now.
  onMessage({ type: 'report_status', id: 'r4', sessionId: 's9', reportId: 't1:run-1', token: T1 })
  onMessage({ type: 'report_status', id: 'r5', sessionId: 's1', reportId: 't1:run-1', token: 'not-a-token' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  // In the order asked: the status asked after the steer sees it waiting.
  assert.deepEqual([...sent].sort((a, b) => String(a.id).localeCompare(String(b.id))), [
    { type: 'report_result', id: 'r1', status: 'steered' },
    { type: 'report_result', id: 'r2', status: 'pending' },
    { type: 'report_result', id: 'r3', status: 'failed' },
    { type: 'report_result', id: 'r4', status: 'none' },
    { type: 'report_result', id: 'r5', status: 'failed' },
  ])
})

test('the app\'s side: each report request goes to its session, answered by the plugin or a timeout; notices carry their session', async () => {
  const sent: Array<Record<string, unknown>> = []
  const heard: Array<{ type: string, reportId: string, sessionId: string }> = []
  const steering = createSteerDesk({ send: (message) => { sent.push(message as Record<string, unknown>) }, sessionId: () => 's1', timeoutMs: 20, onReport: (event) => { heard.push(event) } })
  const asked = steering.report('s2', 't1:run-1', T1, 'note')
  assert.deepEqual([sent[0].type, sent[0].sessionId, sent[0].reportId, sent[0].token, sent[0].text], ['report', 's2', 't1:run-1', T1, 'note'])
  steering.receive({ type: 'report_result', id: sent[0].id, status: 'steered' })
  assert.equal(await asked, 'steered')
  assert.equal(await steering.reportStatus('s2', 't1:run-1', T1), NO_PLUGIN, 'no answer: the plugin is not there')
  steering.receive({ type: 'report_read', sessionId: 's2', reportId: 't1:run-1' })
  steering.receive({ type: 'report_read', reportId: 't9:run-1' })
  assert.deepEqual(heard, [{ type: 'report_read', reportId: 't1:run-1', sessionId: 's2' }], 'one without its session is ignored')
})

test('a session no agent holds now is read as stored: there, read; not there, or no such session, lost there', async () => {
  const sent: unknown[] = []
  const store: Record<string, ReportMessage[]> = { old: [noted(T1), said('其他的话')] }
  const reports = createReportDesk({
    agentOf: () => null,
    stored: async (sessionId) => {
      if (sessionId === 'broken') throw new Error('disk')
      return store[sessionId] ?? null
    },
    send: (message) => { sent.push(message) },
  })
  assert.equal(await reports.status('old', 't1:run-1', T1), 'read', 'in its stored history')
  assert.equal(await reports.status('old', 't2:run-1', T2), 'none', 'not there: lost there')
  assert.equal(await reports.status('gone', 't1:run-1', T1), 'none', 'no such session')
  assert.equal(await reports.status('broken', 't1:run-1', T1), null, 'it cannot be read: not known, asked again later')
  assert.equal(await reports.deliver('old', 't2:run-1', T2, 'note'), null, 'never steered into a session no agent holds')
})
