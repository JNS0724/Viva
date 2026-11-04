import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { registerHistoryIpc } from '../src/backend/history-ipc.ts'

const question = (text) => ({ role: 'user', text, receipt: null })

/** Wires the handlers to a real database and a fake agent; `call` invokes a channel like the renderer would. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-ipc-'))
  const db = openHistoryDb({ file: path.join(dir, 'history.db') })
  const handlers = new Map()
  let conversation = db.create({ sessionId: 'live-1' })
  const info = { mode: 'live', model: 'V4', sessionId: 'live-1', resumed: false }
  registerHistoryIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    db,
    dshHome: path.join(dir, 'no-dsh'),
    current: () => conversation,
    setCurrent: (next) => { conversation = next },
    agentInfo: () => info,
    switchAgent: async () => info,
  })
  // Like ipcMain.handle, a handler that throws becomes a rejected promise.
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args)
  return { db, call }
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

test('search goes through to the database and refuses what is not a query', async () => {
  const { call, db } = setup()
  db.save(db.create({}), [question('整理接口联调的待办')])

  const results = await call('history:search', '接口联调')

  assert.deepEqual(results.map((r) => r.title), ['整理接口联调的待办'])
  await assert.rejects(call('history:search', 42), /invalid/)
})

test('the trace is unavailable without dsh logs', async () => {
  const { call, db } = setup()
  const demo = db.save(db.create({ sessionId: 'missing-session-1' }), [question('日志已被清理的对话')])

  const trace = await call('history:trace', demo.id, Date.now())
  assert.deepEqual([trace.available, trace.trace.timeline], [false, []])
})
