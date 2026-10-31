import test from 'node:test'
import assert from 'node:assert/strict'
import {createScrollFollower, takeReaderControl} from '../src/renderer/view/scroll-follow.ts'

test('explicitly revealing an answer keeps the reading offset and still offers the new bottom', () => {
  const pane = Object.assign(new EventTarget(), {
    scrollTop: 0, scrollHeight: 1000, clientHeight: 600, style: {overflowAnchor: 'auto'},
  })
  let top = 0
  Object.defineProperty(pane, 'scrollTop', {
    get: () => top,
    set: (value: number) => { top = Math.max(0, Math.min(value, pane.scrollHeight - pane.clientHeight)) },
  })
  const jump = {hidden: true}
  const follower = createScrollFollower(pane as unknown as HTMLElement, jump as HTMLElement)
  follower.jumpToLatest()
  assert.equal(pane.scrollTop, 400)

  takeReaderControl(pane as unknown as Element)
  pane.scrollHeight = 8000
  follower.onContentResize()
  assert.equal(pane.scrollTop, 400)
  assert.equal(follower.isFollowing(), false)
  assert.equal(jump.hidden, false)
  assert.equal(pane.style.overflowAnchor, 'auto')

  follower.jumpToLatest()
  assert.equal(pane.scrollTop, 7400)
  assert.equal(follower.isFollowing(), true)
  assert.equal(jump.hidden, true)
})
