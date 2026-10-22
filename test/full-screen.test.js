import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { leaveFullScreen } from '../src/main/full-screen.ts'

function fakeWindow() {
  const win = new EventEmitter()
  win.calls = []
  win.setFullScreen = (on) => win.calls.push(['setFullScreen', on])
  win.isDestroyed = () => false
  return win
}

test('a full-screen window leaves full screen first, and goes once the system says it has', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = fakeWindow()
  let hidden = 0
  leaveFullScreen(win, () => { hidden += 1 })
  assert.deepEqual([win.calls, hidden], [[['setFullScreen', false]], 0], 'not hidden while still full screen')
  win.emit('leave-full-screen')
  t.mock.timers.tick(5_000)
  assert.equal(hidden, 1, 'once, not again when the timeout passes')
})

test('should the system never say so, the window goes anyway', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = fakeWindow()
  let hidden = 0
  leaveFullScreen(win, () => { hidden += 1 })
  t.mock.timers.tick(1_500)
  win.emit('leave-full-screen')
  assert.equal(hidden, 1)
})
