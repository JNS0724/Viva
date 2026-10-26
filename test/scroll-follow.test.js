import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScrollFollower, distanceFromBottom, drawerScrollPlan, followTarget } from '../src/renderer/view/scroll-follow.ts'

/** Minimal stand-in for a scrollable element: clamps scrollTop like a browser and lets tests fire events. */
function fakeScroller({ scrollHeight, clientHeight = 600, scrollTop = 0 }) {
  const listeners = {}
  let top = scrollTop
  return {
    style: { overflowAnchor: '' },
    scrollHeight,
    clientHeight,
    get scrollTop() {
      return top
    },
    set scrollTop(value) {
      top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
    },
    addEventListener(type, fn) {
      listeners[type] = [...(listeners[type] ?? []), fn]
    },
    fire(type, event = {}) {
      for (const fn of listeners[type] ?? []) fn(event)
    },
  }
}

const userScrollTo = (el, top) => {
  el.scrollTop = top
  el.fire('scroll')
}

test('automatic following owns anchoring; capped and reader-controlled scrolling restore native anchoring', () => {
  const el = fakeScroller({ scrollHeight: 454, clientHeight: 356 })
  el.style.overflowAnchor = 'auto'
  const follower = createScrollFollower(el, { hidden: true })
  follower.resetForPrompt()
  follower.afterRender({ anchorTop: 289 })
  assert.equal(el.scrollTop, 98)
  assert.equal(el.style.overflowAnchor, 'none', 'native anchoring must not create an unmatched scroll during our deferred layout')
  el.scrollHeight = 495
  el.fire('scroll')
  follower.afterRender({ anchorTop: 289 })
  el.scrollHeight = 700
  follower.afterRender({ anchorTop: 289 })
  assert.equal(el.scrollTop, 265)
  assert.equal(el.style.overflowAnchor, 'auto', 'the browser may keep the question anchored once automatic following stops')
  follower.resetForPrompt()
  assert.equal(el.style.overflowAnchor, 'none')
  el.fire('wheel', { deltaY: -1 })
  assert.equal(el.style.overflowAnchor, 'auto', 'reader control keeps normal native anchoring')
  follower.jumpToLatest()
  assert.equal(el.style.overflowAnchor, 'none')
})

test('followTarget goes to the bottom unless that would push the question off the top', () => {
  assert.deepEqual(followTarget({ scrollHeight: 1000, clientHeight: 600, anchorTop: null }), { scrollTop: 400, capped: false })
  assert.deepEqual(followTarget({ scrollHeight: 1000, clientHeight: 600, anchorTop: 500 }), { scrollTop: 400, capped: false })
  assert.deepEqual(followTarget({ scrollHeight: 3000, clientHeight: 600, anchorTop: 1000 }), { scrollTop: 976, capped: true })
  assert.deepEqual(followTarget({ scrollHeight: 300, clientHeight: 600, anchorTop: 10 }), { scrollTop: 0, capped: false })
})

test('distanceFromBottom', () => {
  assert.equal(distanceFromBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 600 }), 300)
})

test('short replies keep following the bottom', () => {
  // Arrange
  const el = fakeScroller({ scrollHeight: 800 })
  const jump = { hidden: true }
  const follower = createScrollFollower(el, jump)

  // Act
  el.scrollHeight = 900
  follower.afterRender({ anchorTop: 700 })

  // Assert
  assert.equal(el.scrollTop, 300)
  assert.equal(follower.isFollowing(), true)
  assert.equal(jump.hidden, true)
})

test('a long reply stops at the question and offers a jump button instead of racing to the bottom', () => {
  const el = fakeScroller({ scrollHeight: 1200 })
  const jump = { hidden: true }
  const follower = createScrollFollower(el, jump)

  el.scrollHeight = 3000
  follower.afterRender({ anchorTop: 1000 })
  el.fire('scroll')
  el.scrollHeight = 5000
  follower.afterRender({ anchorTop: 1000 })

  assert.equal(el.scrollTop, 976)
  assert.equal(follower.isFollowing(), false)
  assert.equal(jump.hidden, false)
})

test('scrolling up stops following immediately; returning to the bottom resumes without the anchor cap', () => {
  const el = fakeScroller({ scrollHeight: 1200 })
  const jump = { hidden: true }
  const follower = createScrollFollower(el, jump)
  follower.afterRender({ anchorTop: 900 })

  el.fire('wheel', { deltaY: -40 })
  el.scrollHeight = 1400
  follower.afterRender({ anchorTop: 900 })
  assert.equal(el.scrollTop, 600, 'must not move while the user reads')
  assert.equal(jump.hidden, false)

  userScrollTo(el, 800)
  el.scrollHeight = 2600
  follower.afterRender({ anchorTop: 900 })
  assert.equal(follower.isFollowing(), true)
  assert.equal(el.scrollTop, 2000, 'user chose to follow, so the anchor no longer caps')
  assert.equal(jump.hidden, true)
})

test('keyboard paging up also hands control to the user', () => {
  const el = fakeScroller({ scrollHeight: 1200 })
  const follower = createScrollFollower(el, { hidden: true })
  follower.afterRender({ anchorTop: null })

  el.fire('keydown', { key: 'PageUp' })
  el.fire('keydown', { key: 'a' })

  assert.equal(follower.isFollowing(), false)
})

test('our own scroll writes are not mistaken for the user scrolling away', () => {
  const el = fakeScroller({ scrollHeight: 1200 })
  const follower = createScrollFollower(el, { hidden: true })
  follower.afterRender({ anchorTop: null })

  el.scrollHeight = 1500
  el.fire('scroll')

  assert.equal(follower.isFollowing(), true)
})

test('a new prompt re-arms following with a fresh anchor; jumpToLatest goes to the very bottom', () => {
  const el = fakeScroller({ scrollHeight: 3000 })
  const jump = { hidden: true }
  const follower = createScrollFollower(el, jump)
  el.fire('wheel', { deltaY: -10 })

  follower.resetForPrompt()
  follower.afterRender({ anchorTop: 1000 })
  assert.equal(el.scrollTop, 976)

  follower.jumpToLatest()
  assert.equal(el.scrollTop, 2400)
  assert.equal(follower.isFollowing(), true)
  assert.equal(jump.hidden, true)
})

test('drawer scroll plan: latest step on open, stick when at bottom, otherwise keep the reader’s place', () => {
  assert.deepEqual(drawerScrollPlan(null, 'trace'), { stickToBottom: true, top: 0 })
  assert.deepEqual(drawerScrollPlan(null, 'files'), { stickToBottom: false, top: 0 })
  assert.deepEqual(drawerScrollPlan({ tab: 'files', top: 300, atBottom: false }, 'trace'), { stickToBottom: true, top: 0 })
  assert.deepEqual(drawerScrollPlan({ tab: 'trace', top: 300, atBottom: true }, 'trace'), { stickToBottom: true, top: 300 })
  assert.deepEqual(drawerScrollPlan({ tab: 'trace', top: 300, atBottom: false }, 'trace'), { stickToBottom: false, top: 300 })
})

test('content that grows without a re-render (fonts, wrapping) keeps a bottom-follower at the bottom only', () => {
  // Arrange
  const el = fakeScroller({ scrollHeight: 1000 })
  const follower = createScrollFollower(el, { hidden: true })
  follower.jumpToLatest()

  // Act
  el.scrollHeight = 1007
  follower.onContentResize()
  const followed = distanceFromBottom(el)
  follower.resetForPrompt()
  el.scrollHeight = 1500
  follower.onContentResize()
  const anchored = el.scrollTop

  // Assert
  assert.equal(followed, 0)
  assert.equal(anchored, 407, 'a fresh question is anchored by afterRender, not by resize')
})
