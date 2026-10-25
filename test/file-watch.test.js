import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFileWatch, SETTLE_MS } from '../src/main/file-watch.ts'
import { openFollowupStore } from '../src/main/followup-store.ts'
import { registerFollowupsIpc } from '../src/main/followups-ipc.ts'
import { materialsFor } from '../src/main/prepare-materials.ts'
import { checkSchedule, DEFAULT_SCHEDULE } from '../src/main/prepare-schedule.ts'

const MINUTE = 60_000

/** A store on a temporary folder with a file in it to watch; closed before the folder goes (Windows). */
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'))
  const clock = { now: new Date(2026, 9, 26, 9).getTime() }
  const store = openFollowupStore({ file: path.join(dir, 'followups.db'), now: () => clock.now })
  const design = path.join(dir, 'design-v3.md')
  fs.writeFileSync(design, 'v1')
  t.after(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, clock, store, design }
}

test('a watched file prepares its follow-up once it changed and then stayed as it is for 10 minutes', (t) => {
  const { store, clock, design } = setup(t)
  const mtimes = { [design]: 1 }
  const changed = []
  const watch = createFileWatch({
    store, onChanged: (f) => changed.push(f.id), mtimeOf: (file) => mtimes[file] ?? null, now: () => clock.now,
    setRepeat: () => 0, clearRepeat: () => {},
  })
  const followup = store.add({ title: '设计稿改动', ask: '写改动摘要', origin: { kind: 'chat' }, watchPath: design })
  watch.check()
  assert.equal(store.get(followup.id).watchMtime, 1, 'the first look takes the file as it is')

  mtimes[design] = 2
  watch.check()
  clock.now += 5 * MINUTE
  mtimes[design] = 3
  watch.check()
  clock.now += SETTLE_MS - MINUTE
  watch.check()
  assert.deepEqual(changed, [], 'still being edited: changed again 9 minutes ago')
  clock.now += MINUTE
  watch.check()
  assert.deepEqual(changed, [followup.id])
  assert.equal(store.get(followup.id).watchMtime, 3)
  watch.check()
  assert.equal(changed.length, 1, 'once per change')

  mtimes[design] = 4
  store.setStatus(followup.id, 'dismissed')
  watch.check()
  clock.now += SETTLE_MS
  watch.check()
  assert.equal(changed.length, 1, 'dismissed: watched no more')
  watch.stop()
})

test('IPC: a file to watch is checked and its time taken at once; 接着做 leaves it watching; materials read it', async (t) => {
  const { dir, clock, store, design } = setup(t)
  const handlers = new Map()
  registerFollowupsIpc({ handle: (channel, fn) => handlers.set(channel, async (...args) => fn({}, ...args)) }, {
    store, scheduler: { refresh: () => {}, prepareNow: () => {}, wakeUp: () => {}, state: () => ({}) }, changed: () => {},
    schedule: () => checkSchedule({ ...DEFAULT_SCHEDULE, chosen: true }), saveSchedule: () => {}, workDir: () => dir, conversationExists: () => false,
    now: () => clock.now,
  })
  const call = (channel, ...args) => handlers.get(channel)(...args)
  await assert.rejects(call('followups:accept', { title: '设计稿', ask: '写摘要', watchFile: 'missing.md' }), /找不到要看的文件/)
  const made = await call('followups:accept', { title: '设计稿', ask: '写改动摘要', watchFile: 'design-v3.md' })
  const followup = store.get(made.accepted.id)
  assert.deepEqual([followup.watchPath, followup.watchMtime], [design, fs.statSync(design).mtimeMs])
  assert.equal(made.accepted.watching, 'design-v3.md')

  const { input, readFiles } = materialsFor(followup, { conversation: () => null, profile: () => null })
  assert.match(input, /【材料：文件 .*design-v3\.md】\nv1/)
  assert.deepEqual(readFiles.map((file) => file.path), [design])

  store.rearm(followup.id, clock.now + MINUTE)
  store.saveDraft(followup.id, '改动摘要', readFiles)
  await call('followups:continue', followup.id)
  assert.deepEqual([store.get(followup.id).status, store.get(followup.id).prepareBy], ['scheduled', null], 'waits for the next change')
})

test('a followups.db from before learns the watched file\'s time, and keeps its follow-ups', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-old-'))
  const file = path.join(dir, 'followups.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE followups (id TEXT PRIMARY KEY, title TEXT NOT NULL, ask TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL,
    remind_at INTEGER, prepare_by INTEGER, files TEXT, watch_path TEXT, status TEXT NOT NULL, draft TEXT, draft_at INTEGER, read_files TEXT,
    reminded_at INTEGER, late_from INTEGER, cue TEXT)`)
  old.prepare(`INSERT INTO followups (id, title, ask, origin, created_at, remind_at, status) VALUES ('f1', '周报', 'x', '{"kind":"chat"}', 1, 2, 'scheduled')`).run()
  old.close()
  const store = openFollowupStore({ file })
  t.after(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  assert.deepEqual([store.get('f1').title, store.get('f1').watchMtime], ['周报', null])
  store.setWatchMtime('f1', 5)
  assert.equal(store.get('f1').watchMtime, 5)
})
