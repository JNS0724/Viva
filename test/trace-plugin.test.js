import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { keptArguments, stepsFrom } from '../plugins/trace/lib/steps.ts'
import { openTraceDb } from '../plugins/trace/lib/store.ts'
import { readSessionTrace } from '../src/main/dsh-log.ts'
import { DSH_TIMEOUT_MS, eventually, startHarness } from './fixtures/dsh-harness.js'

/** The trace plugin: what it keeps from dsh's events, its store, and the app reading it instead of dsh's log. */
const event = (type, seq, data) => ({ type, seq, time: 1000 + seq, data })

test('steps keep thoughts and tool calls with their outcome, and only small arguments', () => {
  const steps = stepsFrom([
    event('user/message', 1, { content: [{ type: 'text', text: '你好' }] }),
    event('assistant/message', 2, { message: { content: [{ type: 'reasoning', text: '先看看文件' }, { type: 'text', text: '好的' }] } }),
    event('tool/call', 3, { callId: 'c1', name: 'read', arguments: '{"file_path":"a.md"}' }),
    event('tool/call', 4, { callId: 'c2', name: 'write', arguments: JSON.stringify({ file_path: 'b.md', content: 'x'.repeat(5000) }) }),
    event('tool/result', 5, { message: { toolCallId: 'c1', isError: false } }),
    event('tool/result', 6, { message: { toolCallId: 'c2', isError: true } }),
  ])
  assert.deepEqual(steps, [
    { seq: 2, at: 1002, kind: 'thought', text: '先看看文件' },
    { seq: 3, at: 1003, kind: 'tool', callId: 'c1', name: 'read', args: { file_path: 'a.md' }, status: 'completed' },
    { seq: 4, at: 1004, kind: 'tool', callId: 'c2', name: 'write', args: { file_path: 'b.md' }, status: 'failed' },
  ])
  assert.deepEqual(keptArguments('not json'), {})
})

test('the store keeps steps per session, updates a finished tool, and refuses a newer contract', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'trace.db')
  const db = openTraceDb({ file })
  db.recordSteps('s-1', [{ seq: 3, at: 1003, kind: 'tool', callId: 'c1', name: 'read', args: {}, status: 'in_progress' }])
  db.recordSteps('s-1', [{ seq: 3, at: 1003, kind: 'tool', callId: 'c1', name: 'read', args: {}, status: 'completed' }])
  assert.deepEqual(db.stepsOf('s-1').map((step) => step.status), ['completed'])
  assert.deepEqual([db.hasSession('s-1'), db.hasSession('s-2'), db.stepsOf('s-1', 1000).length], [true, false, 0])
  db.close()

  const raw = new DatabaseSync(file)
  raw.prepare("UPDATE meta SET value = '2' WHERE key = 'contract_version'").run()
  raw.close()
  assert.throws(() => openTraceDb({ file }), /更新的版本/)
})

test('inside dsh the plugin records each turn, and the app reads it without dsh logs', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { userData, bridge, defer } = await startHarness(t)
  const agent = bridge()
  const { sessionId } = await agent.start()

  await agent.prompt('查一下 张三')

  const db = openTraceDb({ file: path.join(userData, 'trace.db') })
  defer(() => db.close())
  await eventually(() => db.hasSession(sessionId))
  assert.deepEqual(db.stepsOf(sessionId).map((step) => [step.kind, step.name, step.args, step.status]), [
    ['tool', 'memory_recall', { query: '张三' }, 'completed'],
  ])
  const { trace, available } = await readSessionTrace({ dshHome: path.join(userData, 'no-dsh-here'), traceDb: db, sessionIds: [sessionId], until: Date.now() })
  assert.equal(available, true, 'no dsh log was needed')
  assert.deepEqual(Object.values(trace.tools).map((tool) => [tool.title, tool.status]), [['memory_recall', 'completed']])
})
