import { test } from 'node:test'
import assert from 'node:assert/strict'
import { timelineSeedTime } from '../src/main/smoke-timeline.ts'

test('the latest timeline fixture stays today even during the first half hour after midnight', () => {
  for (const minute of [0, 1, 24, 29, 30, 59]) {
    const now = new Date(2026, 9, 30, 0, minute).getTime()
    const seeded = timelineSeedTime(now, 0, -0.5)
    assert.equal(new Date(seeded).toDateString(), new Date(now).toDateString())
    assert.ok(seeded <= now)
  }
})

test('calendar fixtures retain their local date and clock across month and year boundaries', () => {
  for (const now of [new Date(2026, 0, 1), new Date(2026, 2, 1), new Date(2026, 10, 2)]) {
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const seeded = new Date(timelineSeedTime(now.getTime(), 1, 9.5))
    assert.equal(seeded.toDateString(), yesterday.toDateString())
    assert.equal(seeded.getHours(), 9)
    assert.equal(seeded.getMinutes(), 30)
  }
  const now = new Date(2026, 2, 1).getTime()
  const months = [0, 1, 20, 35].map(days => new Date(timelineSeedTime(now, days, 11)).getMonth())
  assert.equal(new Set(months).size, 3, 'a 35-day fixture may span three calendar months')
})
