import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localBoundary, localDay, nextDay, todayAt } from '../src/memory/core/memory-calendar.ts'

test('daily calendar boundaries use the source timezone and reject ambiguous civil times', () => {
  assert.equal(localDay('2026-11-14', 'Asia/Shanghai'), Date.parse('2026-11-13T16:00:00Z'))
  assert.equal(localDay('2026-02-30', 'UTC'), null)
  assert.equal(todayAt(Date.parse('2026-11-14T17:00:00Z'), 'Asia/Shanghai'), '2026-11-15')
  assert.equal(nextDay('2026-12-31'), '2027-01-01')
  assert.equal(localBoundary({ date: '2026-03-08', time: '02:30' }, 0, 'America/New_York'), null)
  assert.equal(localBoundary({ date: '2026-11-01', time: '01:30' }, 0, 'America/New_York'), null)
  assert.equal(localBoundary({ daysFromSource: 1, time: '14:00' }, Date.parse('2026-11-14T00:00:00Z'), 'Asia/Shanghai'), Date.parse('2026-11-15T06:00:00Z'))
})
