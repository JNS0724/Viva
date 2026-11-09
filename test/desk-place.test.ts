import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deskLayout, DESK_SIZE, DRAG_SIZE, FIXED_DESK_HOST, dragBounds, homePoint, keepInside, pointOf, readPlaces, settle, withPlace } from '../src/shell/desk-place.ts'

const mac = { x: 0, y: 25, width: 1440, height: 875 }
const left = { x: -1920, y: 0, width: 1920, height: 1040 }

test('by default the island sits at the top centre of the screen', () => {
  if (FIXED_DESK_HOST) {
    const layout = deskLayout(homePoint(mac), mac)
    assert.deepEqual(layout.anchor, { x: 504, y: 352 })
    assert.deepEqual(layout.bounds, { x: 216, y: -271, width: 1008, height: 704 })
    assert.deepEqual(deskLayout(homePoint(left), left).bounds, { x: -1464, y: -296, width: 1008, height: 704 })
    return
  }
  assert.deepEqual(deskLayout(homePoint(mac), mac), { bounds: { x: 660, y: 31, width: 600, height: 352 }, align: 'start', dir: 'down', anchor: { x: 60, y: 50 }, side: 'right', panelWidth: 440 })
  assert.deepEqual(deskLayout(homePoint(left), left).bounds, { x: -1020, y: 6, width: 600, height: 352 }, 'on a display left of the main one too')
})

test('in the lower half it unfolds upwards, its head staying where it was put', () => {
  const { bounds, dir } = deskLayout({ x: 720, y: 800 }, mac)
  assert.equal(dir, 'up')
  if (FIXED_DESK_HOST) {
    assert.equal(bounds.y + DESK_SIZE.height / 2, 800)
    return
  }
  assert.equal(bounds.y + bounds.height, 800 + 40 + 10, 'the window ends just below the head')
  assert.equal(deskLayout({ x: 720, y: 880 }, mac).bounds.y + 352 <= mac.y + mac.height, true, 'and never below the screen')
})

test('near a side it keeps to that side, so what it unfolds stays on the screen', () => {
  const nearLeft = deskLayout({ x: 100, y: 300 }, mac)
  assert.deepEqual([nearLeft.align, nearLeft.bounds.x], ['start', FIXED_DESK_HOST ? -404 : 40])
  const nearRight = deskLayout({ x: 1400, y: 300 }, mac)
  assert.deepEqual([nearRight.align, nearRight.bounds.x], ['end', FIXED_DESK_HOST ? 896 : 1440 - 600])
})

test('the drag host keeps its platform size and is centred under the pointer', () => {
  assert.deepEqual(dragBounds({ x: 100, y: 300.4 }), { x: Math.round(100 - DRAG_SIZE.width / 2), y: Math.round(300.4 - DRAG_SIZE.height / 2), ...DRAG_SIZE })
})

test('dropped near home it goes home; elsewhere it is kept as fractions of the screen', () => {
  const home = homePoint(mac)
  assert.equal(settle(home, mac), null)
  assert.notEqual(settle({ x: home.x + 30, y: home.y + 20 }, mac), null, 'an intentional short drag is kept instead of snapping back')
  const place = settle({ x: 1080, y: 681.25 }, mac)
  assert.deepEqual(place, { fx: 0.75, fy: 0.75 })
  assert.deepEqual(pointOf(place, mac), { x: 1080, y: 681.25 })
  assert.deepEqual(pointOf(place, { x: 0, y: 0, width: 800, height: 600 }), { x: 600, y: 450 }, 'on a smaller screen, at the same spot')
  assert.deepEqual(pointOf(null, mac), home)
})

test('the head is never off the screen', () => {
  assert.deepEqual(keepInside({ x: -50, y: 2000 }, mac), { x: 40, y: 900 - 40 })
  assert.deepEqual(pointOf({ fx: 1, fy: 0 }, mac), { x: 1440 - 40, y: 25 + 40 })
})

test('every layout keeps the saved avatar centre and its neighbouring panel within the host', () => {
  for (const area of [mac, left, { x: 0, y: 0, width: 1024, height: 768 }, { x: 100, y: -700, width: 800, height: 600 }]) {
    for (const fx of [0, .25, .5, .75, 1]) for (const fy of [0, .5, 1]) {
      const point = pointOf({ fx, fy }, area)
      const { bounds, anchor, side, panelWidth } = deskLayout(point, area)
      assert.ok(Math.abs(bounds.x + anchor.x - point.x) <= 1)
      assert.ok(Math.abs(bounds.y + anchor.y - point.y) <= 1)
      const panelX = side === 'right' ? anchor.x + 52 : anchor.x - 52 - panelWidth
      assert.ok(panelX >= 0 && panelX + panelWidth <= bounds.width)
      assert.ok(bounds.x + panelX >= area.x - 1 && bounds.x + panelX + panelWidth <= area.x + area.width + 1)
      if (FIXED_DESK_HOST) {
        assert.deepEqual(anchor, { x: DESK_SIZE.width / 2, y: DESK_SIZE.height / 2 })
        assert.deepEqual(bounds, dragBounds(point), 'crossing midlines cannot move the local portrait anchor or resize the host')
      }
    }
  }
})

test('what preferences.json holds is checked; a place per display, the last one dragged to', () => {
  assert.deepEqual(readPlaces(null), { last: null, places: {} })
  assert.deepEqual(readPlaces({ last: 7, places: { a: { fx: 0.5, fy: 2 }, b: { fx: 0.1, fy: 0.2 }, c: 'x' } }), { last: null, places: { b: { fx: 0.1, fy: 0.2 } } })
  const one = withPlace(readPlaces(null), 1, { fx: 0.2, fy: 0.8 })
  const two = withPlace(one, 2, { fx: 0.9, fy: 0.9 })
  assert.deepEqual(two, { last: '2', places: { 1: { fx: 0.2, fy: 0.8 }, 2: { fx: 0.9, fy: 0.9 } } })
  assert.deepEqual(withPlace(two, 1, null), { last: '1', places: { 2: { fx: 0.9, fy: 0.9 } } }, 'home again: no place kept')
  assert.deepEqual(one.places, { 1: { fx: 0.2, fy: 0.8 } }, 'a new value each time; the old one is left as it was')
})
