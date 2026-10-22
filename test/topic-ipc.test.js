import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.js'
import { registerHistoryIpc } from '../src/main/history-ipc.js'

/** 回到这个话题 and 撤销 a new topic, in the main process: the agent takes that session up again; the timeline stays in order. */

const question = (text) => ({ role: 'user', text, receipt: null })

function setup({ busy = false } = {}) {
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'topic-ipc-')), 'history.db') })
  const handlers = new Map()
  const switches = []
  let conversation = db.create({ sessionId: 'live-1', cwd: '/w' })
  let info = { mode: 'live', model: 'V4', sessionId: 'live-1', resumed: false }
  registerHistoryIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    db,
    dshHome: '/no-dsh',
    current: () => conversation,
    setCurrent: (next) => { conversation = next },
    agentInfo: () => info,
    switchAgent: async (sessionId, cwd) => {
      switches.push([sessionId, cwd])
      info = { ...info, sessionId, cwd, resumed: sessionId !== 'gone' }
      return info
    },
    chooseExportPath: async () => null,
    isBusy: () => busy,
  })
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args)
  return { db, call, switches, current: () => conversation, startNew: (fields) => { conversation = db.create(fields) } }
}

test('going back to a topic takes up its session, and what follows is a new segment going on from it', async () => {
  const { db, call, switches, current, startNew } = setup()
  const first = await call('history:save', [question('周报')])
  startNew({ sessionId: 'live-2', cwd: '/w' })
  await call('history:save', [question('别的事')])

  const resumed = await call('history:resume-topic', first.id)

  assert.deepEqual(switches, [['live-1', '/w']])
  assert.equal(resumed.parentId, first.id)
  assert.equal(resumed.info.remembersHistory, true)
  assert.equal(current().parentId, first.id, 'the segment from now on goes on from that topic')
  assert.notEqual(current().id, first.id, 'a new segment, at the end of the timeline')
  assert.equal(db.get(current().id), null, 'written with its first message, like any new conversation')
  const loaded = await call('history:save', [question('接着周报')])
  assert.equal((await call('history:load')).parentId, first.id)
  assert.equal(loaded.id, current().id)
})

test('a topic whose session the agent no longer has, or a busy agent, says so', async () => {
  const { call, startNew } = setup()
  startNew({ sessionId: 'gone', cwd: '/w' })
  const lost = await call('history:save', [question('很久以前')])
  startNew({ sessionId: 'live-3', cwd: '/w' })
  await assert.rejects(call('history:resume-topic', lost.id), /接不回来/)
  await assert.rejects(call('history:resume-topic', 'missing-id'), /找不到/)

  const { call: busyCall } = setup({ busy: true })
  await assert.rejects(busyCall('history:resume-topic', lost.id), /正在工作/)
})
