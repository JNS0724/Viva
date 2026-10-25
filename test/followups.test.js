import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFollowupNotifier, createGapWatch } from '../src/main/followup-notifier.ts'
import { dayOf, openFollowupStore } from '../src/main/followup-store.ts'
import { clock as hhmm, DAILY_CAP, LATE_MS, nextReminderAt, planNotices } from '../src/main/notice-plan.ts'

const MINUTE = 60_000
const NOON = new Date(2026, 9, 26, 12, 0).getTime()

/** A store on a temporary file with its clock in the test's hands; closed before the folder goes (Windows). */
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'followups-'))
  const clock = { now: NOON }
  const store = openFollowupStore({ file: path.join(dir, 'followups.db'), now: () => clock.now })
  t.after(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { store, clock }
}

const chat = { kind: 'chat', conversationId: 'c1' }
const followup = (extra = {}) => ({
  id: 'f1', title: '周报', ask: '起草周报', origin: chat, createdAt: 0, remindAt: null, prepareBy: null, files: [], watchPath: null, watchMtime: null,
  status: 'scheduled', draft: null, draftAt: null, readFiles: [], remindedAt: null, lateFrom: null, cue: null, ...extra,
})
const plan = (followups, extra = {}) => planNotices({ now: NOON, followups, interruptionsToday: 0, atGap: false, windowInFront: false, toldReady: new Set(), ...extra })

test('a follow-up needs words and a time or a file; it is kept with where it came from', (t) => {
  const { store } = setup(t)
  assert.throws(() => store.add({ title: '周报', ask: '起草', origin: chat }), /提醒时间、准备时间或要看的文件/)
  assert.throws(() => store.add({ title: ' ', ask: '起草', origin: chat, remindAt: NOON }), /标题/)
  const added = store.add({ title: '周报', ask: '周五下班前起草周报', origin: chat, remindAt: NOON + 60 * MINUTE, prepareBy: NOON })
  assert.deepEqual([added.status, added.origin, added.remindAt], ['scheduled', chat, NOON + 60 * MINUTE])
  const ready = store.saveDraft(added.id, '草稿', [{ path: '/x/a.md', mtimeMs: 5 }])
  assert.deepEqual([ready.status, ready.draft, ready.draftAt, ready.readFiles], ['ready', '草稿', NOON, [{ path: '/x/a.md', mtimeMs: 5 }]])
  store.markReminded(added.id, NOON - MINUTE)
  assert.deepEqual([store.get(added.id).remindedAt, store.get(added.id).lateFrom], [NOON, NOON - MINUTE])
  const moved = store.reschedule(added.id, { remindAt: NOON + 120 * MINUTE })
  assert.deepEqual([moved.remindAt, moved.prepareBy, moved.remindedAt], [NOON + 120 * MINUTE, NOON, null], 'rescheduled, it may remind again')
})

test('open follow-ups come soonest first, ended ones after, and ended ones a month old are let go', (t) => {
  const { store, clock } = setup(t)
  const later = store.add({ title: '晚的', ask: 'x', origin: chat, remindAt: NOON + 2 * MINUTE })
  const sooner = store.add({ title: '早的', ask: 'x', origin: chat, prepareBy: NOON + MINUTE })
  const old = store.add({ title: '做完的', ask: 'x', origin: chat, remindAt: NOON })
  store.setStatus(old.id, 'done')
  assert.deepEqual(store.list().map((f) => f.title), ['早的', '晚的', '做完的'])
  clock.now = NOON + 31 * 24 * 60 * MINUTE
  assert.deepEqual(store.list().map((f) => f.id), [sooner.id, later.id])
})

test('notices count the day\'s interruptions, and when each follow-up was last told of', (t) => {
  const { store, clock } = setup(t)
  store.logNotice('ready', ['a', 'b'], true)
  store.logNotice('reminder', ['c'], false)
  assert.equal(store.interruptionsOn(), 1)
  assert.equal(store.noticedOn('ready'), true)
  assert.equal(store.lastToldAt('b'), NOON)
  assert.equal(store.lastToldAt('z'), null)
  clock.now = NOON + 24 * 60 * MINUTE
  assert.equal(store.interruptionsOn(), 0, 'a new day starts from none')
  assert.equal(dayOf(NOON), '2026-10-26')
  store.logEvent('suggest_shown')
  assert.equal(store.countEvents('suggest_shown', NOON), 1)
})

test('a reminder goes out at its time, once, whatever the cap; it says whether its draft is ready', () => {
  const due = followup({ remindAt: NOON - MINUTE })
  const [notice] = plan([due], { interruptionsToday: DAILY_CAP + 5 })
  assert.deepEqual([notice.kind, notice.title, notice.body, notice.interrupts, notice.system], ['reminder', '周报', '起草周报', false, true])
  assert.deepEqual(plan([{ ...due, remindedAt: NOON - 1 }]), [], 'once only')
  assert.deepEqual(plan([followup({ remindAt: NOON + MINUTE })]), [], 'not before its time')

  const notReady = plan([followup({ remindAt: NOON, prepareBy: NOON - 60 * MINUTE })])[0]
  assert.equal(notReady.body, '还没准备好（你一直在忙），要现在准备吗？')
  const ready = plan([followup({ remindAt: NOON, status: 'ready' })])[0]
  assert.equal(ready.body, '准备好了，点开看')
})

test('reminders missed while the computer slept go out together as one, with the time they were due', () => {
  const at = new Date(2026, 9, 26, 9, 5).getTime()
  const notices = plan([
    followup({ id: 'a', title: '周报', remindAt: at }),
    followup({ id: 'b', title: '合同', remindAt: at + 30 * MINUTE }),
    followup({ id: 'c', title: '刚到点', remindAt: NOON - LATE_MS + MINUTE }),
  ])
  assert.deepEqual(notices.map((n) => [n.kind, n.followupIds]), [['reminder', ['c']], ['missed', ['a', 'b']]])
  assert.deepEqual([notices[1].title, notices[1].body], ['错过的提醒 · 2 件', '原定于 09:05：周报、合同'])
})

test('what is ready is told only in a gap, once, under the cap; with the window in front, the window shows it', () => {
  const ready = [followup({ id: 'a', status: 'ready', title: '周报' }), followup({ id: 'b', status: 'ready', title: '合同' })]
  assert.deepEqual(plan(ready), [], 'not outside a gap')
  const [told] = plan(ready, { atGap: true })
  assert.deepEqual([told.kind, told.title, told.body, told.interrupts, told.system], ['ready', '准备好 2 件，等你看', '周报、合同 · 都还没动，等你点头', true, true])
  assert.deepEqual(plan(ready, { atGap: true, toldReady: new Set(['a', 'b']) }), [], 'once per follow-up')
  assert.deepEqual(plan(ready, { atGap: true, interruptionsToday: DAILY_CAP }), [], 'not past the day\'s cap')
  const inFront = plan(ready, { atGap: true, interruptionsToday: DAILY_CAP, windowInFront: true })[0]
  assert.deepEqual([inFront.system, inFront.interrupts], [false, false], 'the window shows it, no interruption')
  assert.equal(nextReminderAt([followup({ remindAt: NOON + 5 }), followup({ remindAt: NOON + 9 }), followup({ remindAt: NOON - 1 })], NOON), NOON + 5)
})

test('the notifier sends at a reminder\'s time and in gaps, marks what it told, and keeps the tray\'s count', (t) => {
  const { store, clock } = setup(t)
  const timers = []
  const sent = []
  const pending = []
  const notifier = createFollowupNotifier({
    store,
    notify: (notice) => sent.push(notice),
    windowInFront: () => false,
    onPending: (count) => pending.push(count),
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock.now + ms, done: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { timer.done = true },
  })
  const report = store.add({ title: '周报', ask: '起草周报', origin: chat, remindAt: NOON + 30 * MINUTE, prepareBy: NOON + 20 * MINUTE })
  notifier.refresh()
  assert.equal(timers.find((item) => !item.done).at, NOON + 30 * MINUTE, 'waits for the reminder')

  store.saveDraft(report.id, '草稿', [])
  notifier.refresh()
  assert.equal(pending.at(-1), 1)
  notifier.gap()
  assert.deepEqual(sent.map((n) => [n.kind, n.title, n.body]), [['today', '今天', '准备好 1 件：周报']], 'the day\'s first gap: 今天')
  notifier.gap()
  assert.equal(sent.length, 1, 'told once')

  clock.now = NOON + 30 * MINUTE
  timers.find((item) => !item.done).fn()
  assert.deepEqual(sent.map((n) => [n.kind, n.body]), [['today', '准备好 1 件：周报'], ['reminder', '准备好了，点开看']])
  assert.equal(store.get(report.id).remindedAt, NOON + 30 * MINUTE)
  assert.equal(store.interruptionsOn(), 1, 'the reminder did not count')

  store.add({ title: '合同', ask: '回复合同', origin: chat, remindAt: NOON + 40 * MINUTE })
  clock.now = NOON + 5 * 60 * MINUTE
  notifier.wake()
  assert.deepEqual([sent.at(-1).kind, sent.at(-1).body], ['missed', `原定于 ${hhmm(NOON + 40 * MINUTE)}：合同`])
  notifier.stop()
})

test('back at the computer after 15 minutes away is a gap; a short pause is not', () => {
  const idle = [0, 600, 0, 950, 30]
  let tick = null
  const gaps = []
  const watch = createGapWatch({ idleSeconds: () => idle.shift(), onGap: () => gaps.push('back'), setRepeat: (fn) => { tick = fn; return 1 }, clearRepeat: () => {} })
  for (let i = 0; i < 5; i += 1) tick()
  assert.deepEqual(gaps, ['back'])
  watch.stop()
})

test('今天: the day\'s first gap with something says it all at once, once; a day with nothing says nothing', () => {
  const base = { now: NOON, interruptionsToday: 0, atGap: true, windowInFront: false, toldReady: new Set(), todayTold: false }
  const later = followup({ id: 'b', title: '合同', remindAt: NOON + 60 * MINUTE })
  const [today] = planNotices({ ...base, followups: [followup({ id: 'a', status: 'ready' }), later], suggestions: [{ id: 's', title: '续签' }] })
  assert.deepEqual([today.kind, today.body, today.followupIds], ['today', '准备好 1 件 · 1 条消息要你看看 · 今天要提醒 1 件：周报、续签、合同', ['a', 's']])
  assert.deepEqual(planNotices({ ...base, followups: [] }), [], 'nothing to say: no 今天')
  assert.deepEqual(planNotices({ ...base, followups: [later], todayTold: true }), [], 'once a day')
  assert.deepEqual(planNotices({ ...base, followups: [later], atGap: false }), [], 'only in a gap')
})
