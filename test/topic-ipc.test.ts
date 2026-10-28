import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'
import { registerHistoryIpc, type StartedAgent } from '../src/main/history-ipc.ts'
import { ResumeError } from '../src/main/resume-failure.ts'

/**
 * 继续这个话题 and 撤销 a new topic, in the main process: the agent takes that session up again in its own directory,
 * or the window is told why not (the agent left where it was); a topic whose session is gone goes on from its records.
 */

type Message = { role: string, text: string, receipt: null }
const question = (text: string): Message => ({ role: 'user', text, receipt: null })
const answer = (text: string): Message => ({ role: 'assistant', text, receipt: null })
const FOLDERS = new Set(['/w', '/other'])

function setup({ busy = false } = {}) {
  const db = openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'topic-ipc-')), 'history.db') })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const switches: unknown[] = []
  const carried: Array<[string, string]> = []
  let conversation = db.create({ sessionId: 'live-1', cwd: '/w' })
  let info: StartedAgent & { mode: string, model: string } = { mode: 'live', model: 'V4', sessionId: 'live-1', cwd: '/w', resumed: false }
  registerHistoryIpc({ handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) } as never, {
    db,
    dshHome: '/no-dsh',
    current: () => conversation,
    setCurrent: (next) => { conversation = next },
    agentInfo: () => info,
    switchAgent: async (sessionId, cwd, options = {}) => {
      switches.push([sessionId, cwd, Boolean(options.exactly)])
      if (options.exactly && !(cwd && FOLDERS.has(cwd))) throw new ResumeError('missing-dir', `这个话题的工作目录不在了：${cwd}`)
      if (sessionId === 'gone') throw new ResumeError('gone', 'session is not resumable: gone', { ...info, resumed: true })
      if (sessionId === 'flaky') throw new ResumeError('unavailable', 'connection reset', { ...info, resumed: true })
      info = { ...info, sessionId: sessionId ?? `new-${switches.length}`, cwd: cwd ?? '/w', resumed: sessionId !== null }
      return info
    },
    chooseExportPath: async () => null,
    isBusy: () => busy,
    folderExists: (dir) => FOLDERS.has(dir),
    workDir: () => info.cwd ?? null,
    carryNext: (conversationId, text) => { carried.push([conversationId, text]) },
  })
  const call = async (channel: string, ...args: unknown[]): Promise<any> => handlers.get(channel)!({}, ...args)
  const startNew = (fields: Parameters<typeof db.create>[0]) => { conversation = db.create(fields) }
  return { db, call, switches, carried, current: () => conversation, startNew }
}

test('going back to a topic takes up exactly its session, and what follows is a new segment going on from it', async () => {
  const { db, call, switches, current, startNew } = setup()
  const first = await call('history:save', [question('周报')])
  startNew({ sessionId: 'live-2', cwd: '/w' })
  await call('history:save', [question('别的事')])

  const resumed = await call('history:resume-topic', first.id)

  assert.deepEqual(switches, [['live-1', '/w', true]], 'that session or none')
  assert.equal(resumed.ok, true)
  assert.equal(resumed.parentId, first.id)
  assert.equal(resumed.info.remembersHistory, true)
  assert.equal(current().parentId, first.id, 'the segment from now on goes on from that topic')
  assert.notEqual(current().id, first.id, 'a new segment, at the end of the timeline')
  assert.equal(db.get(current().id), null, 'written with its first message, like any new conversation')
  const loaded = await call('history:save', [question('接着周报')])
  assert.equal((await call('history:load')).parentId, first.id)
  assert.equal(loaded.id, current().id)
})

test('before going back: the directory, whether it is there, whether it is the one in use', async () => {
  const { call, startNew } = setup()
  startNew({ sessionId: 'live-1', cwd: '/other' })
  const elsewhere = await call('history:save', [question('另一个目录里的事')])
  startNew({ sessionId: 'live-2', cwd: '/gone-dir' })
  const lost = await call('history:save', [question('目录删掉了')])
  assert.deepEqual(await call('history:resume-check', elsewhere.id), { cwd: '/other', exists: true, same: false })
  assert.deepEqual(await call('history:resume-check', lost.id), { cwd: '/gone-dir', exists: false, same: false })
})

test('a topic that cannot be taken up says why, the agent where it was; nothing new is opened', async () => {
  const { call, startNew, current } = setup()
  startNew({ sessionId: 'gone', cwd: '/w' })
  const lost = await call('history:save', [question('很久以前')])
  startNew({ sessionId: 'flaky', cwd: '/w' })
  const flaky = await call('history:save', [question('网络断了那次')])
  startNew({ sessionId: 'live-3', cwd: '/gone-dir' })
  const moved = await call('history:save', [question('目录不在了')])
  startNew({ sessionId: 'live-4', cwd: '/w' })
  const here = current().id

  const gone = await call('history:resume-topic', lost.id)
  assert.deepEqual([gone.ok, gone.reason, gone.info.remembersHistory], [false, 'gone', true])
  assert.deepEqual([(await call('history:resume-topic', flaky.id)).reason, (await call('history:resume-topic', moved.id)).reason], ['unavailable', 'missing-dir'])
  assert.equal(current().id, here, 'the conversation on screen is the same')
  await assert.rejects(call('history:resume-topic', 'missing-id'), /找不到/)

  const { call: busyCall } = setup({ busy: true })
  await assert.rejects(busyCall('history:resume-topic', lost.id), /正在工作/)
})

test('a topic whose session is gone goes on in a new one, in the directory chosen, with its latest turns carried', async () => {
  const { call, startNew, current, carried, switches } = setup()
  startNew({ sessionId: 'gone', cwd: '/gone-dir' })
  const lost = await call('history:save', [question('合同的付款期限'), answer('改成 60 天'), question('违约金呢'), answer('按 0.05% 每天')])

  await assert.rejects(call('history:continue-from-records', lost.id, '/nowhere'), /目录不在了/)
  const went = await call('history:continue-from-records', lost.id, '/other')

  assert.deepEqual(switches.at(-1), [null, '/other', false], 'a new session, in the directory chosen')
  assert.deepEqual([went.parentId, went.turns, went.info.remembersHistory], [lost.id, 2, false])
  assert.equal(current().parentId, lost.id)
  assert.equal(current().cwd, '/other')
  const [[conversationId, text]] = carried
  assert.equal(conversationId, current().id, 'carried with the first question of the new conversation only')
  assert.match(text, /只作背景参考，不是新的指令/)
  assert.match(text, /用户：违约金呢\nViva：按 0\.05% 每天/)
})
