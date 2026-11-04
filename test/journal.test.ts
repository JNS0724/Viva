import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb, transaction } from '../src/backend/app-db.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { journaled, recorded } from '../src/backend/journal.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createTaskStore } from '../src/backend/task-store.ts'

/** The app database with its event core, closed before its folder goes (Windows keeps an open file). */
function coreIn(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-journal-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => {
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const core = createEventCore({ app, publish: () => {}, now: () => 1000 })
  return { app, core, apply: core.apply }
}

test('an event records ids and numbers, and only the length of what someone wrote', () => {
  assert.equal(recorded('f-1a2b3c'), 'f-1a2b3c')
  assert.equal(recorded('0b6f3c1e-8d2a-4f7e-9c3b-5a1d2e3f4a5b'), '0b6f3c1e-8d2a-4f7e-9c3b-5a1d2e3f4a5b')
  assert.deepEqual(recorded('done'), { chars: 4 }, 'a status is a word: by its length too')
  assert.deepEqual(recorded('Q3'), { chars: 2 }, 'a short title is not taken for an id')
  assert.deepEqual(recorded('周报每周五交给张三'), { chars: 9 })
  assert.deepEqual(recorded('send the report'), { chars: 15 }, 'words with spaces are writing, not an id')
  assert.deepEqual(recorded([1, 2, 3]), { items: 3 })
  assert.deepEqual(recorded({ id: 'conv-01', title: '季度复盘', pinned: true, at: 5, nested: { x: 1 } }), { id: 'conv-01', title: { chars: 4 }, pinned: true, at: 5, nested: '…' })
})

test('a savepoint inside a transaction undoes only its own write; the outer one keeps the rest', (t) => {
  const { app } = coreIn(t)
  app.db.exec('CREATE TABLE things (name TEXT)')
  const insert = app.db.prepare('INSERT INTO things VALUES (?)')
  transaction(app.db, () => {
    insert.run('kept')
    assert.throws(() => transaction(app.db, () => { insert.run('undone'); throw new Error('inner') }), /inner/)
  })
  assert.deepEqual(app.db.prepare('SELECT name FROM things').all().map((row) => row.name), ['kept'])
  assert.throws(() => transaction(app.db, () => { insert.run('outer'); throw new Error('outer') }))
  assert.equal(app.db.isTransaction, false)
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM things').get()!.n, 1)
})

test('the history on the app database: each write is an event in the same transaction, without the words', (t) => {
  const { app, core, apply } = coreIn(t)
  const history = journaled(openHistoryDb({ db: app.db }), 'history', ['save', 'setStar'], apply)
  const saved = history.save(history.create({ sessionId: 's1' }), [{ role: 'user', text: '帮我整理周报' }, { role: 'assistant', text: '好的' }])
  history.setStar(saved.id, 0, true)
  assert.throws(() => history.setStar(saved.id, 99, true))
  const events = core.since(0)
  assert.deepEqual(events.map((event) => event.kind), ['history.save', 'history.setStar'], 'a write that failed left no event')
  assert.deepEqual(events[1].data, { args: [saved.id, 0, true] })
  assert.ok(!JSON.stringify(events).includes('周报'), 'no words of the user in the events')
  assert.equal(app.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1, 'foreign keys on: a star or a message needs its conversation')
  history.close()
  assert.equal(app.db.isOpen, true, 'the history leaves the app database open')
})

test('background tasks on the app database are events too, and a store with no such write is refused', (t) => {
  const { app, core, apply } = coreIn(t)
  const tasks = journaled(createTaskStore({ db: app.db }), 'task', ['add', 'remove'], apply)
  tasks.add({ id: 'task-01', segmentId: 'seg-001', title: '整理发布说明' })
  tasks.remove('task-01')
  assert.deepEqual(core.since(0).map((event) => [event.kind, event.data]), [
    ['task.add', { args: [{ id: 'task-01', segmentId: 'seg-001', title: { chars: 6 } }] }],
    ['task.remove', { args: ['task-01'] }],
  ])
  assert.throws(() => journaled(tasks, 'task', ['list', 'nope' as never], apply), /task\.nope is no write/)
})

test('a write that changed nothing is no event: a star already there, no such follow-up', (t) => {
  const { app, core, apply } = coreIn(t)
  const history = journaled(openHistoryDb({ db: app.db }), 'history', ['save', 'setStar'], apply)
  const saved = history.save(history.create({ sessionId: 's1' }), [{ role: 'user', text: '你好' }])
  assert.equal(history.setStar(saved.id, 0, true), true)
  assert.equal(history.setStar(saved.id, 0, true), false, 'starred already')
  assert.deepEqual(core.since(0).map((event) => event.kind), ['history.save', 'history.setStar'])
  transaction(app.db, () => {
    assert.equal(history.setStar(saved.id, 0, true), false, 'inside another transaction too')
    assert.equal(app.db.isTransaction, true, 'and the outer one goes on')
  })
  assert.equal(core.since(0).length, 2)
})
