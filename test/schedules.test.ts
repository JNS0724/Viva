import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createSchedules } from '../src/backend/schedules.ts'
import { parseTaskAction } from '../src/backend/tasks-channel.ts'

/** Schedules by talking (schedules.ts): proposed by the model, kept only on the user's yes, changed by asking. */

function setup() {
  const shown: unknown[] = []
  let changes = 0
  let n = 0
  const schedules = createSchedules({
    db: new DatabaseSync(':memory:'), emit: (event) => { shown.push(event) }, changed: () => { changes++ },
    now: () => Date.parse('2026-11-06T10:00:00+08:00'), newId: () => `p${++n}`,
  })
  return { schedules, shown, changes: () => changes }
}
const weekly = { kind: 'weekly', weekly: { time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [5] } }

test('proposed: a card for the window, nothing kept; yes keeps it; a proposal taken once', () => {
  const { schedules, shown, changes } = setup()
  const said = schedules.act({ op: 'schedule_create', title: '周报', prompt: '按模板起草周报', rule: weekly }, 'c1', '/work') as { proposed: boolean, firstAt: string }
  assert.deepEqual([said.proposed, said.firstAt, schedules.list()], [true, '2026-11-06T08:00:00.000Z', []], 'nothing kept before yes (11-06 is a Friday: this afternoon)')
  assert.deepEqual(shown, [{ type: 'schedule_propose', proposal: { proposalId: 'p1', title: '周报', prompt: '按模板起草周报', rule: weekly, firstAt: '2026-11-06T08:00:00.000Z' } }])
  const kept = schedules.accept('p1')
  assert.deepEqual([kept.title, kept.nextAt, kept.status, schedules.list().length, changes()], ['周报', '2026-11-06T08:00:00.000Z', 'active', 1, 1])
  assert.throws(() => schedules.accept('p1'), 'a card says yes once')
})

test('declined, or a time dsh refuses: nothing kept, no card for the refused', () => {
  const { schedules, shown } = setup()
  schedules.act({ op: 'schedule_create', title: '报销', prompt: '提醒我交报销单', rule: { kind: 'at', at: '2026-11-07T16:00:00+08:00' } }, null, '/work')
  schedules.decline('p1')
  assert.throws(() => schedules.accept('p1'))
  assert.throws(() => schedules.act({ op: 'schedule_create', title: '过去', prompt: 'x', rule: { kind: 'at', at: '2020-01-01T00:00:00Z' } }, null, '/work'))
  assert.deepEqual([shown.length, schedules.list()], [1, []])
})

test('changed by asking: paused, resumed, moved, deleted; an unknown one is said so', () => {
  const { schedules } = setup()
  schedules.act({ op: 'schedule_create', title: '周报', prompt: '起草周报', rule: weekly }, null, '/work')
  const { id } = schedules.accept('p1')
  assert.equal((schedules.act({ op: 'schedule_update', id, paused: true }, null, '/work') as { status: string }).status, 'paused')
  assert.equal((schedules.act({ op: 'schedule_update', id, paused: false }, null, '/work') as { status: string }).status, 'active')
  const moved = schedules.act({ op: 'schedule_update', id, rule: { kind: 'weekly', weekly: { time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [4] } } }, null, '/work') as { nextAt: string }
  assert.equal(moved.nextAt, '2026-11-12T08:00:00.000Z')
  assert.deepEqual(schedules.act({ op: 'schedule_delete', id }, null, '/work'), { deleted: true })
  assert.throws(() => schedules.act({ op: 'schedule_update', id, paused: true }, null, '/work'))
})

test('what the model sends is checked before anything is done', () => {
  assert.deepEqual(parseTaskAction({ op: 'schedule_list', extra: 1 }), { op: 'schedule_list' })
  assert.deepEqual(parseTaskAction({ op: 'schedule_create', title: ' 周报 ', prompt: '起草', rule: { ...weekly, junk: 1 } }),
    { op: 'schedule_create', title: '周报', prompt: '起草', rule: weekly })
  assert.throws(() => parseTaskAction({ op: 'schedule_create', title: '', prompt: '起草', rule: weekly }))
  assert.throws(() => parseTaskAction({ op: 'schedule_create', title: '周报', prompt: '起草', rule: { kind: 'hourly' } }))
  assert.throws(() => parseTaskAction({ op: 'schedule_update', title: '无 id' }))
  assert.deepEqual(parseTaskAction({ op: 'schedule_update', id: 's1', paused: true }), { op: 'schedule_update', id: 's1', paused: true })
})

test('a yes whose save fails leaves the card to be answered again', () => {
  let refuse = true
  const schedules = createSchedules({
    db: new DatabaseSync(':memory:'), emit: () => {},
    apply: (_kind, _data, write) => {
      if (refuse) {
        refuse = false
        throw new Error('database is locked')
      }
      return { value: write() }
    },
    now: () => Date.parse('2026-11-06T10:00:00+08:00'), newId: () => 'p1',
  })
  schedules.act({ op: 'schedule_create', title: '周报', prompt: '起草周报', rule: weekly }, 'c1', '/work')
  assert.throws(() => schedules.accept('p1'), /database is locked/)
  assert.equal(schedules.accept('p1').title, '周报', 'the proposal still there, kept the second time')
  assert.throws(() => schedules.accept('p1'), 'and then gone')
})

test('changed on the card before yes: kept as changed, checked as the model\'s own are; a time gone by is said in words', () => {
  const { schedules } = setup()
  schedules.act({ op: 'schedule_create', title: '周报', prompt: '按模板起草周报', rule: weekly }, 'c1', '/work')
  assert.throws(() => schedules.accept('p1', { title: '  ', prompt: 'x', rule: weekly }), /标题/, 'no name: refused before dsh')
  assert.throws(() => schedules.accept('p1', { title: '月报', prompt: 'x', rule: { kind: 'at', at: { date: '2020-01-01', time: '09:00:00', time_zone: 'Asia/Shanghai' } } }),
    { message: '这个时间已经过了，换一个以后的时间。' })
  assert.throws(() => schedules.accept('p1', { title: '月报', prompt: 'x', rule: { kind: 'daily', daily: { time: '25:00:00', time_zone: 'Asia/Shanghai' } } }),
    { message: '时间没有填对，请检查一下。' })
  const kept = schedules.accept('p1', { title: ' 月报 ', prompt: '起草月报', rule: { kind: 'cron', cron: { expression: '0 9 1 * *', time_zone: 'Asia/Shanghai' } } })
  assert.deepEqual([kept.title, kept.prompt, kept.kind, kept.nextAt], ['月报', '起草月报', 'cron', '2026-12-01T01:00:00.000Z'], 'still there after the refusals, kept as changed')
})

test('changed on the card with its time untouched: the proposal\'s own rule is kept, to the second', () => {
  const { schedules } = setup()
  const soon = { kind: 'at', at: '2026-11-06T10:00:30+08:00' }
  schedules.act({ op: 'schedule_create', title: '提醒', prompt: '交报销单', rule: soon }, null, '/work')
  const kept = schedules.accept('p1', { title: '报销', prompt: '交报销单' })
  assert.deepEqual([kept.title, kept.nextAt], ['报销', '2026-11-06T02:00:30.000Z'], 'due within the minute, not refused as past')
})
