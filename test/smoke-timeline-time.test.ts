import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seedTimeline, timelineSeedTime } from './smoke/smoke-timeline.ts'

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


for (const kind of ['timeline', 'performance'] as const) {
  test(`${kind} smoke seeds retain assistant identities with their native session references`, async t => {
    const { scratch } = await import('./fixtures/scratch.js')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const { seedPerf } = await import('./smoke/smoke-perf.ts')
    const { dir, defer } = scratch(t, `smoke-${kind}-history-`)
    if (kind === 'timeline') seedTimeline(dir)
    else seedPerf(dir)
    const db = new DatabaseSync(join(dir, 'app.db'), { readOnly: true })
    defer(() => db.close())
    const rows = db.prepare(`SELECT m.text,m.source_key,m.session_id FROM messages m
      WHERE m.role='assistant'`).all()
    assert.ok(rows.length > 10)
    for (const row of rows) {
      assert.ok(typeof row.text === 'string' && row.text.length > 0)
      assert.ok(typeof row.source_key === 'string' && row.source_key.length > 0)
      assert.match(String(row.session_id), /^seeded-session-/u, 'synthetic history retains its source identity while the original native session stays unavailable')
    }
    if (kind === 'timeline') assert.ok(Number(db.prepare('SELECT count(*) AS n FROM stars').get()?.n) > 0)
    else assert.ok(rows.some(row => Buffer.byteLength(String(row.text), 'utf8') >= 200_000))
  })
}
