import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronShape, draftOf, editsOf, wallClock } from '../src/renderer/proposal-draft.ts'
import type { ScheduleProposal } from '../src/renderer/proposal-types.ts'

/** A proposal in the words of its card's form, and back (proposal-draft.ts): the user never edits a cron to change one. */

const ZONE = 'Asia/Shanghai'
const NOW = Date.parse('2026-11-06T10:00:00+08:00')
const proposalOf = (rule: ScheduleProposal['rule'], firstAt = '2026-11-09T01:00:00.000Z'): ScheduleProposal =>
  ({ proposalId: 'p1', title: '周报', prompt: '起草周报', firstAt, rule })

test('the crons the form can say read as its words; one that says more is kept as written', () => {
  assert.deepEqual(cronShape('0 9 * * *'), { repeat: 'daily', time: '09:00' })
  assert.deepEqual(cronShape('30 18 * * 1-5'), { repeat: 'weekly', time: '18:30', weekdays: [1, 2, 3, 4, 5] })
  assert.deepEqual(cronShape('0 9 * * 0,3'), { repeat: 'weekly', time: '09:00', weekdays: [3, 7] }, 'Sunday 0 is ISO 7')
  assert.deepEqual(cronShape('0 9 * * 0-6'), { repeat: 'daily', time: '09:00' }, 'every weekday of the week is every day')
  assert.deepEqual(cronShape(' 5 7 15 * * '), { repeat: 'monthly', time: '07:05', day: 15 })
  for (const said of ['*/15 * * * *', '0 9,18 * * *', '0 9 1 1 *', '0 9 1 * 1', '0 9 * * MON', '0 9 * * 1-3/2', '0 24 * * *', '0 9 * *', '0 9 32 * *']) {
    assert.equal(cronShape(said), null, said)
  }
})

test('a proposal opens in the form\'s words, in its own zone; values its repeat does not use are its first run\'s', () => {
  const cron = draftOf(proposalOf({ kind: 'cron', cron: { expression: '0 9 * * 1', time_zone: ZONE } }), NOW)
  assert.deepEqual(cron, { title: '周报', prompt: '起草周报', repeat: 'weekly', zone: ZONE, date: '2026-11-09', time: '09:00', weekdays: [1], day: 9, expression: '0 9 * * 1' })
  assert.equal(draftOf(proposalOf({ kind: 'cron', cron: { expression: '*/30 * * * *', time_zone: ZONE } }), NOW).repeat, 'cron')
  const once = draftOf(proposalOf({ kind: 'at', at: '2026-11-09T09:00:00+08:00' }, '2026-11-09T01:00:00.000Z'), NOW)
  assert.deepEqual([once.repeat, once.date, once.time], ['at', ...Object.values(wallClock(Date.parse('2026-11-09T01:00:00.000Z'), once.zone)).slice(0, 2)])
  const daily = draftOf(proposalOf({ kind: 'daily', daily: { time: '07:30:00', time_zone: 'Europe/London' } }), NOW)
  assert.deepEqual([daily.repeat, daily.time, daily.zone], ['daily', '07:30', 'Europe/London'])
})

test('the form back as dsh-schedule\'s rule: once, every day, some weekdays, a day of the month (a cron), or the cron kept', () => {
  const draft = draftOf(proposalOf({ kind: 'cron', cron: { expression: '0 9 * * 1', time_zone: ZONE } }), NOW)
  const rule = (changes: Partial<typeof draft>) => {
    const made = editsOf({ ...draft, ...changes })
    return 'edits' in made ? made.edits.rule : made.problem
  }
  assert.deepEqual(rule({ repeat: 'at', date: '2026-11-20', time: '08:15' }), { kind: 'at', at: { date: '2026-11-20', time: '08:15:00', time_zone: ZONE } })
  assert.deepEqual(rule({ repeat: 'daily' }), { kind: 'daily', daily: { time: '09:00:00', time_zone: ZONE } })
  assert.deepEqual(rule({ repeat: 'weekly', weekdays: [5, 1, 5] }), { kind: 'weekly', weekly: { time: '09:00:00', weekdays: [1, 5], time_zone: ZONE } })
  assert.deepEqual(rule({ repeat: 'monthly', day: 1, time: '07:05' }), { kind: 'cron', cron: { expression: '5 7 1 * *', time_zone: ZONE } })
  assert.deepEqual(rule({ repeat: 'cron', expression: ' */30 * * * * ' }), { kind: 'cron', cron: { expression: '*/30 * * * *', time_zone: ZONE } })
  const made = editsOf({ ...draft, title: '  周会  ', prompt: ' 整理议程 ' })
  assert.deepEqual('edits' in made && [made.edits.title, made.edits.prompt], ['周会', '整理议程'])
})

test('what a form lacks is said before anything is sent', () => {
  const draft = draftOf(proposalOf({ kind: 'daily', daily: { time: '09:00:00', time_zone: ZONE } }), NOW)
  const problem = (changes: Partial<typeof draft>) => {
    const made = editsOf({ ...draft, ...changes })
    return 'problem' in made ? made.problem : null
  }
  assert.equal(problem({ title: ' ' }), 'schedule.edit.title.missing')
  assert.equal(problem({ title: 'x'.repeat(121) }), 'schedule.edit.title.long')
  assert.equal(problem({ prompt: '' }), 'schedule.edit.prompt.missing')
  assert.equal(problem({ time: '' }), 'schedule.edit.time.invalid')
  assert.equal(problem({ repeat: 'at', date: '2026-02-30' }), 'schedule.edit.date.invalid')
  assert.equal(problem({ repeat: 'weekly', weekdays: [] }), 'schedule.edit.weekdays.missing')
  assert.equal(problem({ repeat: 'monthly', day: 0 }), 'schedule.edit.day.invalid')
  assert.equal(problem({ repeat: 'monthly', day: Number.NaN }), 'schedule.edit.day.invalid')
  assert.equal(problem({ repeat: 'cron', expression: ' ' }), 'schedule.edit.cron.missing')
  assert.equal(problem({}), null)
})
