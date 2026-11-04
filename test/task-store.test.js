import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTaskStore } from '../src/main/task-store.ts'

/** Background tasks still going are kept in the app database, so a later launch can offer to go on with them. */

function fileIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-'))
  const opened = []
  t.after(() => {
    for (const db of opened) if (db.isOpen) db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const open = () => {
    const db = new DatabaseSync(path.join(dir, 'app.db'))
    opened.push(db)
    return db
  }
  return open
}
const task = (id, extra = {}) => ({ id, segmentId: `c-${id}`, title: '整理发布说明', words: '整理发布说明', keep: 2, next: `n-${id}`, cwd: '/w', startedAt: 10, ...extra })

test('a task kept stays across launches until it is let go', (t) => {
  const open = fileIn(t)
  const store = createTaskStore({ db: open() })
  assert.deepEqual(store.list(), [], 'nothing kept yet')
  store.add(task('s1'))
  store.add(task('s2', { title: '查天气' }))

  const later = createTaskStore({ db: open() })
  assert.deepEqual(later.list().map((entry) => [entry.id, entry.title]), [['s1', '整理发布说明'], ['s2', '查天气']])
  later.remove('s1')
  assert.deepEqual(createTaskStore({ db: open() }).list().map((entry) => entry.id), ['s2'])
})

test('the same task is kept once and goes last; what is not a task is left out, and a broken row says so', (t) => {
  const open = fileIn(t)
  const db = open()
  const errors = []
  const store = createTaskStore({ db, onError: (err) => errors.push(err) })
  store.add(task('s1'))
  store.add(task('s2'))
  store.add(task('s1', { title: '改了名' }))
  assert.deepEqual(store.list().map((entry) => [entry.id, entry.title]), [['s2', '整理发布说明'], ['s1', '改了名']])

  const raw = db.prepare('INSERT INTO background_tasks (id, task) VALUES (?, ?)')
  raw.run('n', JSON.stringify({ id: 5 }))
  raw.run('b', '{ not json')
  assert.deepEqual(store.list().map((entry) => entry.id), ['s2', 's1'])
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /background task b/)
})
