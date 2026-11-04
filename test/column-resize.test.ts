import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampColumn, COLUMN } from '../src/renderer/view/column-resize.ts'

/** The lane the turn rail (view/turn-rail.ts) needs clear of the text at the main area's left edge. */
const RAIL_LANE_PX = 40

test('the conversation column is as wide as asked, within what the window allows', () => {
  assert.equal(COLUMN.default, 760)
  assert.equal(clampColumn(900, 1400), 900)
  assert.equal(clampColumn(300, 1400), COLUMN.min, 'never narrower than reads well')
  assert.equal(clampColumn(1600, 1200), 1200 - COLUMN.margin, 'never wider than the window leaves room for')
  assert.ok(COLUMN.margin / 2 >= RAIL_LANE_PX, 'at its widest, the rail\'s lane is still left on each side')
  assert.equal(clampColumn(Number.NaN, 1400), COLUMN.default, 'nothing usable saved: the default')
  assert.equal(clampColumn(800, 500), COLUMN.min, 'a window narrower than the minimum still gets the minimum (it scrolls)')
})
