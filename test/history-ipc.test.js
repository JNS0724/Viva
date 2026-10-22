import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'
import { registerHistoryIpc, UNDO_WINDOW_MS } from '../src/main/history-ipc.ts'

const question = (text) => ({ role: 'user', text, receipt: null })

/** Wires the handlers to a real database and a fake agent; `call` invokes a channel like the renderer would. */
function setup({ exportPath = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-ipc-'))
  const db = openHistoryDb({ file: path.join(dir, 'history.db') })
  const handlers = new Map()
  const scheduled = []
  const switches = []
  let conversation = db.create({ sessionId: 'live-1' })
  let info = { mode: 'live', model: 'V4', sessionId: 'live-1', resumed: false }
  registerHistoryIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    db,
    dshHome: path.join(dir, 'no-dsh'),
    current: () => conversation,
    setCurrent: (next) => { conversation = next },
    agentInfo: () => info,
    switchAgent: async (sessionId) => {
      switches.push(sessionId)
      info = { ...info, sessionId: sessionId === 'gone' ? 'live-new' : sessionId, resumed: sessionId !== 'gone' }
      return info
    },
    chooseExportPath: async () => (exportPath ? path.join(dir, exportPath) : null),
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  })
  // Like ipcMain.handle, a handler that throws becomes a rejected promise.
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args)
  return { db, dir, call, scheduled, switches, current: () => conversation, startNew: (sessionId) => { conversation = db.create({ sessionId }) } }
}

test('saving the conversation on screen records the model and returns its title', async () => {
  const { call, db } = setup()

  const summary = await call('history:save', [question('第一个问题')])
  const loaded = await call('history:load')

  assert.equal(summary.title, '第一个问题')
  assert.deepEqual(loaded.messages, [question('第一个问题')])
  assert.deepEqual(loaded.folds, [], 'no path folded off it yet')
  assert.equal(db.get(summary.id).conversation.model, 'V4')
})

test('opening an older conversation reattaches the agent to its session, or says it could not', async () => {
  // Arrange
  const { call, db, switches, startNew, current } = setup()
  const older = db.save(db.create({ sessionId: 'old-1' }), [question('旧的')])
  const lost = db.save(db.create({ sessionId: 'gone' }), [question('失效的')])
  startNew('live-1')

  // Act
  const reopened = await call('history:open', older.id)
  const fallback = await call('history:open', lost.id)
  const again = await call('history:open', lost.id)

  // Assert
  assert.deepEqual(reopened.conversation.messages, [question('旧的')])
  assert.equal(reopened.info.remembersHistory, true)
  assert.equal(fallback.info.remembersHistory, false)
  assert.equal(current().sessionId, 'live-new', 'new messages go to the fresh session')
  assert.deepEqual(switches, ['old-1', 'gone'], 'reopening the conversation on screen does not switch again')
  assert.equal(again.conversation.id, lost.id)
  await assert.rejects(call('history:open', 'missing'), /找不到/)
})

test('delete hides at once and purges after the undo window; restore brings it back', async () => {
  const { call, db, scheduled } = setup()
  const doomed = db.save(db.create({}), [question('要删的')])

  await call('history:delete', doomed.id)
  const afterDelete = (await call('history:list')).items.length
  await call('history:restore', doomed.id)
  const afterRestore = (await call('history:list')).items.length

  assert.deepEqual([afterDelete, afterRestore], [0, 1])
  assert.equal(scheduled[0].ms > UNDO_WINDOW_MS, true)
  scheduled[0].fn()
  assert.notEqual(db.get(doomed.id), null, 'a restored conversation survives the scheduled purge')
})

test('rename, pin, search and export go through to the database', async () => {
  const { call, db, dir } = setup({ exportPath: 'out.md' })
  const notes = db.save(db.create({}), [question('整理接口联调的待办')])

  await call('history:rename', notes.id, '联调待办')
  await call('history:pin', notes.id, true)
  const results = await call('history:search', '接口联调')
  const exported = await call('history:export', notes.id)

  assert.deepEqual(results.map((r) => [r.title, r.pinned]), [['联调待办', true]])
  assert.deepEqual(exported, { saved: true, file: path.join(dir, 'out.md') })
  assert.match(fs.readFileSync(exported.file, 'utf8'), /^# 联调待办\n/)
  await assert.rejects(call('history:search', 42), /invalid/)
})

test('export can be cancelled, and the trace is unavailable without dsh logs', async () => {
  const { call, db } = setup()
  const demo = db.save(db.create({ sessionId: 'missing-session-1' }), [question('日志已被清理的对话')])

  assert.deepEqual(await call('history:export', demo.id), { saved: false })
  const trace = await call('history:trace', demo.id, Date.now())
  assert.deepEqual([trace.available, trace.trace.timeline], [false, []])
})
