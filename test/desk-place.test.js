import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deskLayout, DRAG_SIZE, dragBounds, homePoint, keepInside, pointOf, readPlaces, settle, withPlace } from '../src/main/desk-place.ts'

const mac = { x: 0, y: 25, width: 1440, height: 875 }
const left = { x: -1920, y: 0, width: 1920, height: 1040 }

test('by default the island sits at the top centre of the screen', () => {
  assert.deepEqual(deskLayout(homePoint(mac), mac), { bounds: { x: 420, y: 31, width: 600, height: 320 }, align: 'center', dir: 'down' })
  assert.deepEqual(deskLayout(homePoint(left), left).bounds, { x: -1260, y: 6, width: 600, height: 320 }, 'on a display left of the main one too')
})

test('in the lower half it unfolds upwards, its head staying where it was put', () => {
  const { bounds, dir } = deskLayout({ x: 720, y: 800 }, mac)
  assert.equal(dir, 'up')
  assert.equal(bounds.y + bounds.height, 800 + 24 + 10, 'the window ends just below the head')
  assert.equal(deskLayout({ x: 720, y: 880 }, mac).bounds.y + 320 <= mac.y + mac.height, true, 'and never below the screen')
})

test('near a side it keeps to that side, so what it unfolds stays on the screen', () => {
  const nearLeft = deskLayout({ x: 100, y: 300 }, mac)
  assert.deepEqual([nearLeft.align, nearLeft.bounds.x], ['start', 0])
  const nearRight = deskLayout({ x: 1400, y: 300 }, mac)
  assert.deepEqual([nearRight.align, nearRight.bounds.x], ['end', 1440 - 600])
})

test('dragged, the window is just the cat, centred under the pointer', () => {
  assert.deepEqual(dragBounds({ x: 100, y: 300.4 }), { x: 64, y: 264, ...DRAG_SIZE })
})

test('dropped near home it goes home; elsewhere it is kept as fractions of the screen', () => {
  const home = homePoint(mac)
  assert.equal(settle({ x: home.x + 30, y: home.y + 20 }, mac), null)
  const place = settle({ x: 1080, y: 681.25 }, mac)
  assert.deepEqual(place, { fx: 0.75, fy: 0.75 })
  assert.deepEqual(pointOf(place, mac), { x: 1080, y: 681.25 })
  assert.deepEqual(pointOf(place, { x: 0, y: 0, width: 800, height: 600 }), { x: 600, y: 450 }, 'on a smaller screen, at the same spot')
  assert.deepEqual(pointOf(null, mac), home)
})

test('the head is never off the screen', () => {
  assert.deepEqual(keepInside({ x: -50, y: 2000 }, mac), { x: 24, y: 900 - 24 })
  assert.deepEqual(pointOf({ fx: 1, fy: 0 }, mac), { x: 1440 - 24, y: 25 + 24 })
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
