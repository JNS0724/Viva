import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTaskStore } from '../src/main/task-store.js'

/** Background tasks still going are kept on disk, so a later launch can offer to go on with them. */

const fileIn = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-')), 'background-tasks.json')
const task = (id, extra = {}) => ({ id, segmentId: `c-${id}`, title: '整理发布说明', words: '整理发布说明', keep: 2, next: `n-${id}`, cwd: '/w', startedAt: 10, ...extra })

test('a task kept stays across launches until it is let go', () => {
  const file = fileIn()
  const store = createTaskStore({ file })
  assert.deepEqual(store.list(), [], 'nothing kept yet')
  store.add(task('s1'))
  store.add(task('s2', { title: '查天气' }))

  const later = createTaskStore({ file })
  assert.deepEqual(later.list().map((entry) => [entry.id, entry.title]), [['s1', '整理发布说明'], ['s2', '查天气']])
  later.remove('s1')
  assert.deepEqual(createTaskStore({ file }).list().map((entry) => entry.id), ['s2'])
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600', 'only the user reads it')
})

test('the same task is kept once; what is not a task is left out when read', () => {
  const file = fileIn()
  const store = createTaskStore({ file })
  store.add(task('s1'))
  store.add(task('s1', { title: '改了名' }))
  assert.deepEqual(store.list().map((entry) => entry.title), ['改了名'])

  fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [task('ok'), { id: 5 }, null, { title: 'x' }] }))
  assert.deepEqual(createTaskStore({ file }).list().map((entry) => entry.id), ['ok'])
})

test('a broken file reads as nothing kept, and says so', () => {
  const file = fileIn()
  fs.writeFileSync(file, '{ not json')
  const errors = []
  assert.deepEqual(createTaskStore({ file, onError: (err) => errors.push(err) }).list(), [])
  assert.equal(errors.length, 1)
})
