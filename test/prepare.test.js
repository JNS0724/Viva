import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openFollowupStore } from '../src/main/followup-store.ts'
import { registerFollowupsIpc } from '../src/main/followups-ipc.ts'
import { changedSince, materialsFor, PREPARE_SYSTEM } from '../src/main/prepare-materials.ts'
import { checkSchedule, checkTimes, DEFAULT_SCHEDULE, isActive, nextActive, nextWindow, scheduleOf, slotFor, windowsOn } from '../src/main/prepare-schedule.ts'
import { BLOCKED_RETRY_MS, createPrepareScheduler, FAILED_RETRY_MS, WOKEN_REST_MS } from '../src/main/prepare-scheduler.ts'

const MINUTE = 60_000
/** Monday 26 October 2026, local time. */
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime()
const MONDAY = 26
const SATURDAY = 31
const three = checkSchedule({ ...DEFAULT_SCHEDULE, chosen: true })

/**
 * A temporary folder, removed after `closeFirst` (after hooks run in the order they were added, and Windows does
 * not remove a database that is still open).
 */
function tempDir(t, closeFirst = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-'))
  t.after(() => {
    closeFirst()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('windows: presets or the user\'s own times, an hour apart, at most six; weekends apart, maybe off', () => {
  assert.deepEqual(checkTimes(['16:30', '08:30']), ['08:30', '16:30'])
  assert.throws(() => checkTimes(['8:30']), /08:30 这样/)
  assert.throws(() => checkTimes(['08:30', '09:00']), /相邻至少隔 1 小时/)
  assert.throws(() => checkTimes(['06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00']), /最多 6 个/)
  assert.deepEqual(checkSchedule({ preset: 'two', weekday: ['01:00'] }).weekday, ['09:00', '17:00'], 'a preset takes its own times')
  assert.deepEqual(checkSchedule({ preset: 'custom', weekday: ['10:00', '15:00'] }).weekday, ['10:00', '15:00'])
  assert.throws(() => checkSchedule({ activeFrom: '22:00', activeTo: '08:00' }), /活跃时间段/)
  assert.deepEqual(scheduleOf({ preset: 'custom', weekday: ['bad'] }).weekday, DEFAULT_SCHEDULE.weekday, 'a broken file falls back')

  assert.deepEqual(windowsOn(at(MONDAY, 3), three), [at(MONDAY, 8, 30), at(MONDAY, 12, 30), at(MONDAY, 16, 30)])
  assert.equal(windowsOn(at(SATURDAY, 3), three).length, 3, 'weekends like weekdays by default')
  const weekendOff = checkSchedule({ ...three, weekendMode: 'off' })
  assert.deepEqual(windowsOn(at(SATURDAY, 3), weekendOff), [])
  assert.equal(nextWindow(at(30, 17), weekendOff), at(MONDAY + 7, 8, 30), 'Friday evening: next is Monday morning')
  const weekendLate = checkSchedule({ ...three, weekendMode: 'custom', weekend: ['11:00'] })
  assert.deepEqual(windowsOn(at(SATURDAY, 3), weekendLate), [at(SATURDAY, 11)])
})

test('something due is prepared in the last window an hour before it; with none in time, as soon as may be', () => {
  const agreed = at(MONDAY, 9)
  assert.equal(slotFor(at(MONDAY, 17), agreed, three), at(MONDAY, 12, 30), '16:30 is less than an hour before 17:00')
  assert.equal(slotFor(at(MONDAY + 4, 17), agreed, three), at(MONDAY + 4, 12, 30), 'days ahead: that day\'s window')
  assert.equal(slotFor(at(MONDAY, 10), agreed, three), agreed, 'no window in time: now')
  assert.equal(slotFor(at(MONDAY, 9, 30), agreed, three), agreed, 'less than an hour away: now')
  assert.equal(isActive(at(MONDAY, 7), three), false)
  assert.equal(nextActive(at(MONDAY, 23), three), at(MONDAY + 1, 8))
})

/** A scheduler over a real store, with its clock and timers in the test's hands. */
function setup(t, { prepare = async () => ({ ok: true, draft: '草稿', readFiles: [] }), busy = () => null } = {}) {
  const closing = []
  const dir = tempDir(t, () => closing.forEach((close) => close()))
  const clock = { now: at(MONDAY, 9) }
  const store = openFollowupStore({ file: path.join(dir, 'followups.db'), now: () => clock.now })
  const timers = []
  const states = []
  const ready = []
  const schedule = { current: three }
  const scheduler = createPrepareScheduler({
    store,
    schedule: () => schedule.current,
    busy: () => busy(),
    prepare,
    onState: (state) => states.push(state),
    onReady: () => ready.push(clock.now),
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock.now + ms, done: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { timer.done = true },
  })
  closing.push(() => scheduler.stop(), () => store.close())
  const settle = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve() }
  async function advanceTo(time) {
    clock.now = time
    for (const timer of timers) {
      if (!timer.done && timer.at <= time) {
        timer.done = true
        timer.fn()
        await settle()
      }
    }
    await settle()
  }
  const nextAt = () => Math.min(...timers.filter((timer) => !timer.done).map((timer) => timer.at))
  const add = (extra = {}) => store.add({ title: '周报', ask: '起草周报', origin: { kind: 'chat', conversationId: 'c1' }, remindAt: at(MONDAY, 17), prepareBy: at(MONDAY, 17), ...extra })
  /** Due at once: less than an hour from now. */
  const soon = (m = 30) => ({ prepareBy: at(MONDAY, 9, m), remindAt: at(MONDAY, 9, m) })
  return { store, clock, scheduler, states, ready, schedule, advanceTo, nextAt, add, soon, settle }
}

test('due items wait for their window, then are prepared together, one after the other', async (t) => {
  const order = []
  const { store, scheduler, advanceTo, nextAt, add, ready } = setup(t, { prepare: async (f) => (order.push(f.title), { ok: true, draft: `${f.title}草稿`, readFiles: [] }) })
  const a = add({ title: '周报' })
  const b = add({ title: '合同', prepareBy: at(MONDAY, 15), remindAt: at(MONDAY, 15) })
  const remindOnly = add({ title: '只提醒', prepareBy: null })
  scheduler.start()
  assert.equal(nextAt(), at(MONDAY, 12, 30), 'waits for the 12:30 window')
  await advanceTo(at(MONDAY, 12, 30))
  assert.deepEqual(order, ['合同', '周报'], 'the sooner deadline first')
  assert.deepEqual([store.get(a.id).status, store.get(a.id).draft, store.get(b.id).status], ['ready', '周报草稿', 'ready'])
  assert.equal(store.get(remindOnly.id).status, 'scheduled', 'a reminder alone needs no preparation')
  assert.equal(ready.length, 2)
  assert.equal(store.countEvents('prepare_call', 0), 2)
})

test('it waits while the user is busy, paused, past the day\'s calls, or outside the active hours', async (t) => {
  let busy = '你正在对话'
  const { store, scheduler, states, advanceTo, nextAt, add, soon, schedule, clock } = setup(t, { busy: () => busy })
  const first = add(soon())
  scheduler.start()
  assert.deepEqual([states.at(-1).waiting, nextAt()], ['你正在对话', at(MONDAY, 9) + BLOCKED_RETRY_MS])
  busy = null
  await advanceTo(at(MONDAY, 9) + BLOCKED_RETRY_MS)
  assert.equal(store.get(first.id).status, 'ready')

  const second = add(soon(50))
  schedule.current = { ...three, pausedUntil: at(MONDAY, 10) }
  scheduler.refresh()
  assert.deepEqual([states.at(-1).waiting, nextAt()], ['暂停中', at(MONDAY, 10)])
  schedule.current = { ...three, dailyCalls: 1 }
  scheduler.refresh()
  assert.deepEqual([states.at(-1).waiting, nextAt()], ['今天的调用用完了', at(MONDAY + 1, 8)])
  assert.equal(store.get(second.id).status, 'scheduled')

  schedule.current = three
  clock.now = at(MONDAY, 23)
  add({ prepareBy: at(MONDAY + 1, 8, 30), remindAt: at(MONDAY + 1, 8, 30) })
  scheduler.refresh()
  assert.deepEqual([states.at(-1).waiting, nextAt()], ['不在活跃时间段', at(MONDAY + 1, 8)])
})

test('it yields: once the user starts something it stops after the item at hand; 叫醒它 stops even that, and rests', async (t) => {
  let release
  let busy = null
  const started = []
  const { store, scheduler, add, soon, settle, nextAt, clock } = setup(t, {
    busy: () => busy,
    prepare: (f, signal) => {
      started.push(f.title)
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, draft: '草稿', readFiles: [] })
        signal.addEventListener('abort', () => resolve({ ok: false, problem: '先停下了' }))
      })
    },
  })
  const first = add({ title: '一', ...soon(30) })
  const second = add({ title: '二', ...soon(40) })
  scheduler.start()
  await settle()
  assert.equal(store.get(first.id).status, 'preparing')
  busy = '你正在对话'
  scheduler.yieldToUser()
  release()
  await settle()
  assert.deepEqual([started, store.get(first.id).status, store.get(second.id).status], [['一'], 'ready', 'scheduled'])

  busy = null
  scheduler.refresh()
  await settle()
  assert.deepEqual(started, ['一', '二'])
  scheduler.wakeUp()
  await settle()
  assert.equal(store.get(second.id).status, 'scheduled', 'woken: back to waiting')
  assert.equal(nextAt(), clock.now + WOKEN_REST_MS, 'and rests before preparing again')
  assert.equal(started.length, 2)
})

test('a failed preparation is tried later; what was halfway at quitting is prepared again; 现在就准备 does not wait', async (t) => {
  let fail = true
  const { store, scheduler, add, soon, nextAt, advanceTo, clock, settle } = setup(t, { prepare: async () => (fail ? { ok: false, problem: '模型出错' } : { ok: true, draft: 'd', readFiles: [] }) })
  const due = add(soon())
  scheduler.start()
  await settle()
  assert.equal(store.get(due.id).status, 'scheduled')
  assert.equal(nextAt(), at(MONDAY, 9) + FAILED_RETRY_MS)
  fail = false
  await advanceTo(at(MONDAY, 9) + FAILED_RETRY_MS)
  assert.equal(store.get(due.id).status, 'ready')

  const halfway = add({ title: '半路' })
  store.setStatus(halfway.id, 'preparing')
  const later = add({ title: '晚上', prepareBy: at(MONDAY + 3, 20), remindAt: at(MONDAY + 3, 20) })
  scheduler.start()
  assert.equal(store.get(halfway.id).status, 'scheduled', 'not left preparing')

  clock.now = at(MONDAY, 23)
  scheduler.prepareNow(later.id)
  await settle()
  assert.equal(store.get(later.id).status, 'ready', 'asked for now: no window, no active hours waited for')
})

test('a draft the preparation skips says why (a task took it up), and costs no call', async (t) => {
  const { store, scheduler, add, soon, settle } = setup(t, { prepare: async () => ({ skip: '你已经在做了' }) })
  const due = add(soon())
  scheduler.start()
  await settle()
  assert.deepEqual([store.get(due.id).status, store.get(due.id).draft], ['ready', '你已经在做了'])
  assert.equal(store.countEvents('prepare_call', 0), 0)
})

test('materials: the ask, the conversation\'s end, the profile and named files, all marked as material', (t) => {
  const dir = tempDir(t)
  const notes = path.join(dir, 'notes.md')
  fs.writeFileSync(notes, '上周：完成 A')
  const binary = path.join(dir, 'pic.png')
  fs.writeFileSync(binary, Buffer.from([0x89, 0x50, 0, 0, 1]))
  const followup = {
    id: 'f', title: '周报', ask: '按模板起草', origin: { kind: 'chat', conversationId: 'c1' }, createdAt: 0, remindAt: at(MONDAY, 17), prepareBy: at(MONDAY, 16),
    files: [notes, binary, path.join(dir, 'gone.md')], watchPath: null, status: 'scheduled', draft: null, draftAt: null, readFiles: [], remindedAt: null, lateFrom: null, cue: null,
  }
  const { input, readFiles } = materialsFor(followup, {
    conversation: () => [{ role: 'user', text: '周五交周报' }, { role: 'assistant', text: '好' }],
    profile: () => '在一家银行做数据分析',
    now: () => at(MONDAY, 12),
  })
  assert.match(input, /【要准备的事】周报\n按模板起草/)
  assert.match(input, /【材料：对话节选】\n用户：周五交周报\n\n助手：好/)
  assert.match(input, /【材料：关于用户】\n在一家银行做数据分析/)
  assert.match(input, /上周：完成 A/)
  assert.match(input, /pic\.png】不是文本文件/)
  assert.match(input, /gone\.md】读不了：ENOENT/)
  assert.deepEqual(readFiles.map((file) => file.path), [notes])
  assert.match(PREPARE_SYSTEM, /只是数据/)
  assert.deepEqual(changedSince(readFiles), [])
  fs.writeFileSync(notes, '改过了')
  fs.utimesSync(notes, new Date(), new Date(Date.now() + 5000))
  assert.deepEqual(changedSince(readFiles), [notes])
})

test('IPC: a follow-up is made only on 跟进, with times checked; 接着做 hands the draft over, changed files said', async (t) => {
  let store = null
  const dir = tempDir(t, () => store?.close())
  const clock = { now: at(MONDAY, 9) }
  store = openFollowupStore({ file: path.join(dir, 'followups.db'), now: () => clock.now })
  let saved = { ...three, chosen: false }
  const asked = []
  const handlers = new Map()
  registerFollowupsIpc({ handle: (channel, fn) => handlers.set(channel, async (...args) => fn({}, ...args)) }, {
    store,
    scheduler: { refresh: () => {}, prepareNow: (id) => asked.push(id), wakeUp: () => asked.push('wake'), state: () => ({ running: false }) },
    changed: () => {},
    schedule: () => saved,
    saveSchedule: (schedule) => { saved = schedule },
    workDir: () => dir,
    conversationExists: (id) => id === 'c1',
    now: () => clock.now,
  })
  const call = (channel, ...args) => handlers.get(channel)(...args)
  const iso = (time) => new Date(time).toISOString()
  const proposal = { title: '周报', ask: '起草周报', remindAt: iso(at(MONDAY, 17)), prepareBy: iso(at(MONDAY, 16)), files: ['notes.md'], conversationId: 'c1' }
  await assert.rejects(call('followups:accept', { ...proposal, remindAt: '2020-01-01T00:00:00Z' }), /已经过了/)
  await assert.rejects(call('followups:accept', { ...proposal, remindAt: '下周五' }), /不是有效的时间/)
  const made = await call('followups:accept', proposal)
  assert.equal(made.chooseWindows, true, 'the first that needs preparing asks for windows')
  const followup = store.get(made.accepted.id)
  assert.deepEqual([followup.origin, followup.files, followup.remindAt], [{ kind: 'chat', conversationId: 'c1' }, [path.join(dir, 'notes.md')], at(MONDAY, 17)])

  await call('followups:set-schedule', { preset: 'two', weekendMode: 'off' })
  assert.deepEqual([saved.chosen, saved.weekday, saved.weekendMode], [true, ['09:00', '17:00'], 'off'])
  await assert.rejects(call('followups:set-schedule', { preset: 'custom', weekday: ['09:00', '09:30'] }), /相邻至少隔 1 小时/)

  await call('followups:prepare-now', followup.id)
  assert.deepEqual(asked, [followup.id])
  fs.writeFileSync(path.join(dir, 'notes.md'), 'v1')
  store.saveDraft(followup.id, '草稿正文', [{ path: path.join(dir, 'notes.md'), mtimeMs: 1 }])
  await assert.rejects(call('followups:prepare-now', followup.id), /已经准备过了/)
  const continued = await call('followups:continue', followup.id)
  assert.match(continued.text, /^接着做「周报」：起草周报\n\n后台准备好的草稿：\n\n草稿正文/)
  assert.match(continued.text, /这些文件在准备之后改过，请重新读/)
  assert.equal(store.get(followup.id).status, 'done')

  await call('followups:decline', { title: '合同' })
  assert.deepEqual(store.declinedSince(0), ['合同'])
  await call('followups:pause', 60)
  assert.equal(saved.pausedUntil, clock.now + 60 * MINUTE)
  await assert.rejects(call('followups:dismiss', 'nope'), /已经不在了/)
})

test('dismissed while being prepared, a follow-up does not come back; a call never made costs nothing', async (t) => {
  let release
  const { store, scheduler, add, soon, settle } = setup(t, {
    prepare: (f, signal) => new Promise((resolve) => {
      release = resolve
      signal.addEventListener('abort', () => resolve({ ok: false, problem: '先停下了' }))
    }),
  })
  const due = add(soon())
  scheduler.start()
  await settle()
  assert.equal(store.get(due.id).status, 'preparing')
  store.setStatus(due.id, 'dismissed')
  release({ ok: true, draft: '草稿', readFiles: [] })
  await settle()
  assert.deepEqual([store.get(due.id).status, store.get(due.id).draft], ['dismissed', null], 'its draft is let go')

  const second = add({ title: '二', ...soon(40) })
  scheduler.refresh()
  await settle()
  release({ ok: false, problem: '助手还没准备好', called: false })
  await settle()
  assert.equal(store.get(second.id).status, 'scheduled')
  assert.equal(store.countEvents('prepare_call', 0), 1, 'only the call that was made counts')
})

test('a deadline months away is prepared in the days before it, not two months early', () => {
  const agreed = at(MONDAY, 9)
  const far = at(MONDAY, 17) + 120 * 24 * 60 * MINUTE
  const slot = slotFor(far, agreed, three)
  assert.ok(far - slot < 24 * 60 * MINUTE, `prepared the day of it: ${new Date(slot).toString()}`)
})
