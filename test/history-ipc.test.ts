import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb, type Conversation } from '../src/backend/history-db.ts'
import { registerHistoryIpc, UNDO_WINDOW_MS } from '../src/backend/history-ipc.ts'
import type { Channel, ChannelArgs, IpcRegistry } from '../src/shared/ipc-contract.ts'
import type { StoredMessage } from '../src/backend/history-schema.ts'

const question = (text: string): StoredMessage => ({ role: 'user', text, receipt: null })
type HistoryDb = ReturnType<typeof openHistoryDb>
type Replies = {
  'history:save': Pick<Conversation, 'id' | 'title' | 'updatedAt'>,
  'history:load': { messages: StoredMessage[], folds: ReturnType<HistoryDb['foldsOf']> },
  'history:read': ReturnType<HistoryDb['read']>,
  'history:list': ReturnType<HistoryDb['list']>,
  'history:delete': ReturnType<HistoryDb['softDelete']>,
  'history:restore': ReturnType<HistoryDb['restore']>,
  'history:rename': ReturnType<HistoryDb['rename']>,
  'history:pin': ReturnType<HistoryDb['setPinned']>,
  'history:search': ReturnType<HistoryDb['search']>,
  'history:export': { saved: false } | { saved: true, file: string },
  'history:trace': Awaited<ReturnType<typeof import('../src/backend/dsh-log.ts').readSessionTrace>>,
  'history:model-request': import('../src/shared/trace.ts').ModelCallDetail | null,
}

/** Wires the handlers to a real database and a fake agent; `call` invokes a channel like the renderer would. */
function setup(t: TestContext, { exportPath = null, traceDb, readNativeTrace }: { exportPath?: string | null, traceDb?: Parameters<typeof registerHistoryIpc>[1]['traceDb'], readNativeTrace?: Parameters<typeof registerHistoryIpc>[1]['readNativeTrace'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-ipc-'))
  const db = openHistoryDb({ file: path.join(dir, 'history.db') })
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const handlers = new Map<Channel, (...args: unknown[]) => unknown>()
  const scheduled: Array<{ fn: () => void, ms: number }> = []
  const switches: Array<string | null> = []
  let conversation = db.create({ sessionId: 'live-1' })
  let info = { mode: 'live', model: 'V4', sessionId: 'live-1', resumed: false }
  const ipc: Pick<IpcRegistry, 'handle'> = { handle(channel, listener) {
    handlers.set(channel, (...args) => listener({}, ...(args as ChannelArgs<typeof channel>)))
  } }
  registerHistoryIpc(ipc, {
    db,
    dshHome: path.join(dir, 'no-dsh'),
    traceDb, readNativeTrace,
    current: () => conversation,
    setCurrent: (next) => { conversation = next },
    agentInfo: () => info,
    selectSession: async work => work({ select: next => { conversation = next }, switchAgent: async (sessionId) => {
      switches.push(sessionId)
      info = { ...info, sessionId: sessionId ?? 'live-new', resumed: sessionId !== null }
      return info
    } }),
    chooseExportPath: async () => (exportPath ? path.join(dir, exportPath) : null),
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  })
  // Like ipcMain.handle, a handler that throws becomes a rejected promise.
  const call = async <C extends keyof Replies>(channel: C, ...args: ChannelArgs<C>): Promise<Replies[C]> => await handlers.get(channel)!(...args) as Replies[C]
  return { db, dir, call, scheduled, switches, current: () => conversation, startNew: (sessionId: string) => { conversation = db.create({ sessionId }) } }
}

test('saving the conversation on screen records the model and returns its title', async t => {
  const { call, db } = setup(t)

  const summary = await call('history:save', [{ ...question('第一个问题') }])
  const loaded = await call('history:load')

  assert.equal(summary.title, '第一个问题')
  assert.deepEqual(loaded.messages, [question('第一个问题')])
  assert.deepEqual(loaded.folds, [], 'no path folded off it yet')
  assert.equal(db.get(summary.id)!.conversation.model, 'V4')
})

test('reading an older topic leaves the agent and selected conversation unchanged', async t => {
  const { call, db, switches, startNew, current } = setup(t)
  const older = db.save(db.create({ sessionId: 'old-1' }), [question('旧的')])
  startNew('live-1')
  const here = current().id
  const read = await call('history:read', `t:${older.topicId}`)
  assert.deepEqual(read!.messages.map(message => message.text), ['旧的'])
  assert.deepEqual([current().id, current().sessionId, switches], [here, 'live-1', []])
  assert.equal(await call('history:read', 't:missing'), null)
})

test('delete hides at once and purges after the undo window; restore brings it back', async t => {
  const { call, db, scheduled } = setup(t)
  const doomed = db.save(db.create({}), [question('要删的')])

  await call('history:delete', doomed.id)
  const afterDelete = (await call('history:list')).items.length
  await call('history:restore', doomed.id)
  const afterRestore = (await call('history:list')).items.length

  assert.deepEqual([afterDelete, afterRestore], [0, 1])
  assert.equal(scheduled[0].ms > UNDO_WINDOW_MS, true)
  scheduled[0].fn()
  assert.notEqual(db.get(doomed.id), null, 'a restored conversation survives the scheduled purge')
})

test('rename, pin, search and export go through to the database', async t => {
  const { call, db, dir } = setup(t, { exportPath: 'out.md' })
  const notes = db.save(db.create({}), [question('整理接口联调的待办')])

  await call('history:rename', notes.id, '联调待办')
  await call('history:pin', notes.id, true)
  const results = await call('history:search', '接口联调')
  const exported = await call('history:export', notes.id)

  assert.deepEqual(results.map((r) => [r.title, r.pinned]), [['联调待办', true]])
  assert.deepEqual(exported, { saved: true, file: path.join(dir, 'out.md') })
  assert.match(fs.readFileSync(exported.file, 'utf8'), /^# 联调待办\n/)
  // @ts-expect-error Exercise the handler's refusal of malformed input as well as its static contract.
  await assert.rejects(call('history:search', 42), /invalid/)
})

test('export can be cancelled, and the trace is unavailable without dsh logs', async t => {
  const { call, db } = setup(t)
  const demo = db.save(db.create({ sessionId: 'missing-session-1' }), [question('日志已被清理的对话')])

  assert.deepEqual(await call('history:export', demo.id), { saved: false })
  const trace = await call('history:trace', demo.id, Date.now())
  assert.deepEqual([trace.available, trace.trace.timeline], [false, []])
})

test('export reads history again after the save dialog yields', async t => {
  const { call, db, dir } = setup(t, { exportPath: 'forgotten.md' })
  const sourceId = '69152b68-ec79-440e-838b-b40225a916cb'
  const notes = db.save(db.create({}), [{ ...question('Erased while the save dialog was open'), sourceId }, question('Retained question')])
  const pending = call('history:export', notes.id)
  db.eraseMemoryCopies([sourceId])
  assert.deepEqual(await pending, { saved: true, file: path.join(dir, 'forgotten.md') })
  const exported = fs.readFileSync(path.join(dir, 'forgotten.md'), 'utf8')
  assert.doesNotMatch(exported, /Erased while/)
  assert.match(exported, /Retained question/)
})


test('model detail IPC reads only a session belonging to the named conversation', async t => {
  const { openTraceDb } = await import('../plugins/trace/lib/store.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ipc-'))
  const trace = openTraceDb({ file: path.join(dir, 'trace.db') })
  t.after(() => { trace.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  let allowed = true
  const { db, call } = setup(t, { traceDb: () => trace, readNativeTrace: async (sessions, read) => read(allowed ? sessions : []) })
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const owner = db.save(db.create({ sessionId }), [question('查看这次调用')])
  const other = db.save(db.create({ sessionId: '99999999-2222-3333-4444-555555555555' }), [question('另一个话题')])
  trace.recordCall({ sessionId, turn: 1, step: 1, at: 1, status: 'completed', provider: 'deepseek', model: 'v4', attempts: 1,
    inputTokens: 10, outputTokens: 5, durationMs: 20 }, { provider: 'deepseek', model: 'v4', config: {}, messages: [{ role: 'user', content: '查看这次调用' }], tools: [] })

  const detail = await call('history:model-request', owner.id, sessionId, 1, 1)
  assert.equal(detail?.request?.model, 'v4')
  allowed = false
  assert.equal(await call('history:model-request', owner.id, sessionId, 1, 1), null)
  allowed = true
  assert.equal(await call('history:model-request', other.id, sessionId, 1, 1), null)
  assert.equal(await call('history:model-request', owner.id, '99999999-2222-3333-4444-555555555555', 1, 1), null)
})
