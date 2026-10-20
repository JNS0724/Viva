import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DESK_TIMES, deskBounds, deskForm } from '../src/main/desk-island.js'
import { checkIslandAction, checkIslandView } from '../src/main/island-ipc.js'

const view = (form, extra = {}) => ({ form, tone: 'idle', mood: 'idle', label: 'x', recent: [], ...extra })
const away = { enabled: true, foreground: false, sinceDone: 0 }

test('the desktop island shows only while the window is away and there is something to tell', () => {
  for (const form of ['working', 'waiting', 'asking', 'error']) assert.equal(deskForm({ ...away, view: view(form) }), form)
  for (const form of ['idle', 'pending']) assert.equal(deskForm({ ...away, view: view(form) }), null)
  assert.equal(deskForm({ ...away, foreground: true, view: view('working') }), null, 'the window in front has its own island')
  assert.equal(deskForm({ ...away, enabled: false, view: view('waiting') }), null)
  assert.equal(deskForm({ ...away, view: null }), null)
})

test('after a turn the island says done, rests as a cat, then goes', () => {
  const done = view('done')
  assert.equal(deskForm({ ...away, view: done, sinceDone: 0 }), 'done')
  assert.equal(deskForm({ ...away, view: done, sinceDone: DESK_TIMES.done }), 'mini')
  assert.equal(deskForm({ ...away, view: done, sinceDone: DESK_TIMES.done + DESK_TIMES.mini }), null)
})

test('the island sits at the top centre of the screen the window is on', () => {
  assert.deepEqual(deskBounds({ x: 0, y: 25, width: 1440, height: 875 }), { x: 500, y: 31, width: 440, height: 300 })
  assert.deepEqual(deskBounds({ x: -1920, y: 0, width: 1920, height: 1040 }), { x: -1180, y: 6, width: 440, height: 300 })
})

test('only the actions the island offers get through, with their ids', () => {
  assert.deepEqual(checkIslandAction({ kind: 'permission', requestId: 'r1', optionId: 'allow-once', extra: 'x' }), { kind: 'permission', requestId: 'r1', optionId: 'allow-once' })
  assert.deepEqual(checkIslandAction({ kind: 'answer', questionId: 'q', id: 'city', label: '上海' }), { kind: 'answer', questionId: 'q', id: 'city', label: '上海' })
  assert.deepEqual(checkIslandAction({ kind: 'cancel' }), { kind: 'cancel' })
  assert.deepEqual(checkIslandAction({ kind: 'open' }), { kind: 'open' })
  assert.deepEqual(checkIslandAction({ kind: 'pointer', inside: true }), { kind: 'pointer', inside: true })
  assert.equal(checkIslandAction({ kind: 'prompt', text: 'rm -rf /' }), null, 'nothing else, such as sending a prompt')
  assert.equal(checkIslandAction({ kind: 'permission', requestId: 5 }), null)
  assert.equal(checkIslandAction({ kind: 'answer', questionId: 'q', id: 'a', label: 'x'.repeat(500) }), null)
  assert.equal(checkIslandAction(null), null)
})

test('a view from the window must look like one and stay small', () => {
  const ok = view('working', { action: '读取网页', startedAt: 1, steps: 2 })
  assert.deepEqual(checkIslandView(ok), ok)
  assert.equal(checkIslandView(view('exploded')), null)
  assert.equal(checkIslandView({ form: 'working' }), null, 'needs its label and steps')
  assert.equal(checkIslandView(view('working', { detail: 'x'.repeat(40_000) })), null)
  assert.equal(checkIslandView('working'), null)
})
