import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'
import { registerTaskIpc } from '../src/main/task-ipc.ts'
import { createTaskStore } from '../src/main/task-store.ts'
import { checkedIpc, type RawIpc } from '../src/main/ipc-contract.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { cardedTasks, restoredTaskAnchors } from '../src/renderer/view/task-card.ts'
import { dockTasks } from '../src/renderer/tasks-state.ts'

const user = (text: string) => ({ role: 'user', text, receipt: null })
const answer = (text: string) => ({ role: 'assistant', text, receipt: null })
const restored = (id: string, conversationId: string, at: number, order: number) => ({
  task: { id, title: id, host: { conversationId, at, order } }, status: 'done', endedAt: 10,
  messages: [user(`request-${id}`), answer(`result-${id}`)],
})

test('persisted side links restore only retained tasks through the real IPC, at their own original anchors', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-history-restore-'))
  const file = path.join(dir, 'history.db')
  const storeFile = path.join(dir, 'tasks.json')
  let db = openHistoryDb({ file })
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const main = db.save(db.create({ sessionId: 'main' }), [user('front'), answer('front answer')])
  const store = createTaskStore({ file: storeFile })
  for (const [id, at] of [['before', 0], ['middle', 1], ['expired', 2]] as const) {
    const segment = db.save(db.create({ sessionId: id, parentId: main.id }), [user(`request-${id}`), answer(`result-${id}`)])
    db.fold(segment.id, { into: main.id, at, kind: 'side' })
    if (id !== 'expired') store.add({ id, segmentId: segment.id, title: id, words: `request-${id}`, keep: 0, next: main.id, endedAt: 10, status: 'done' })
  }
  db.close()
  db = openHistoryDb({ file })
  const handlers = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const ipc = checkedIpc({ handle: (channel, listener) => { handlers.set(channel, listener) }, on: () => {} })
  const unexpected = () => { throw new Error('restoring history must not contact the agent') }
  registerTaskIpc(ipc, { db, store: createTaskStore({ file: storeFile }), current: () => main,
    setCurrent: unexpected, isBusy: () => false, setBusy: unexpected, agentInfo: () => ({}),
    agent: { spinOff: unexpected, mergeBack: unexpected, closeTask: unexpected, cancelTask: unexpected,
      steerTask: unexpected, resumeTask: unexpected, startTask: unexpected, promptTask: unexpected } })
  const list = await handlers.get('task:finished')!({}) as Array<ReturnType<typeof restored>>
  assert.deepEqual(list.map(item => [item.task.id, item.task.host.conversationId, item.task.host.at]), [['before', main.id, 0], ['middle', main.id, 1]])
  const loaded = reduce(initialState, { type: 'history_loaded', conversationId: main.id, messages: db.get(main.id)!.messages, savedAt: 1 })
  const state = reduce(loaded, { type: 'tasks_restored', list })
  assert.deepEqual(restoredTaskAnchors(state), [{ taskId: 'before', at: 0 }, { taskId: 'middle', at: 1 }])
  assert.deepEqual(cardedTasks(state).map(({ report }) => report?.preview), ['result-before', 'result-middle'])
  assert.deepEqual(state.messages.map(message => message.text), ['front', 'front answer'], 'background requests never become foreground messages')
  db.softDelete(main.id)
  assert.equal(db.sideTaskHost(store.list()[0].segmentId), null, 'a deleted parent cannot restore a card')
})

test('an empty conversation can restore task rows before any foreground question, without a history divider', () => {
  const loaded = reduce(initialState, { type: 'history_loaded', conversationId: 'empty', messages: [], savedAt: 1 })
  const state = reduce(loaded, { type: 'tasks_restored', list: [restored('b', 'empty', 0, 2), restored('a', 'empty', 0, 1)] })
  assert.equal(state.conversationId, 'empty')
  assert.equal(state.restored, null)
  assert.deepEqual(restoredTaskAnchors(state), [{ taskId: 'a', at: 0 }, { taskId: 'b', at: 0 }], 'same-anchor tasks retain creation order')
  assert.equal(state.messages.length, 0)
})

test('后台做 before the first foreground message persists its empty parent instead of creating an orphan link', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-empty-parent-'))
  const db = openHistoryDb({ file: path.join(dir, 'history.db') })
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const main = db.create({ sessionId: 'main' })
  const handlers = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const ipc = checkedIpc({ handle: (channel, listener) => { handlers.set(channel, listener) }, on: () => {} })
  const unexpected = () => { throw new Error('unexpected agent operation') }
  registerTaskIpc(ipc, { db, current: () => main, setCurrent: unexpected, isBusy: () => false, setBusy: unexpected,
    agentInfo: () => ({}), agent: { spinOff: unexpected, mergeBack: unexpected, closeTask: unexpected, cancelTask: unexpected,
      steerTask: unexpected, resumeTask: unexpected, startTask: async () => ({ ok: true, taskId: 'only-background' }), promptTask: () => {} } })
  const result = await handlers.get('task:start')!({}, { text: '只在后台做，不发前台消息' }) as { task: { segmentId: string } }
  assert.deepEqual(db.get(main.id)?.messages, [])
  assert.equal(db.latest()?.conversation.id, main.id)
  assert.equal(db.sideTaskHost(result.task.segmentId)?.conversationId, main.id)
})

test('restored rows stay in their own topic, survive being seen, and do not resurrect closed or expired tasks', () => {
  let state = reduce(initialState, { type: 'history_loaded', conversationId: 'own', messages: [user('front')], savedAt: 1 })
  state = reduce(state, { type: 'tasks_seen_restored', ids: ['a'] })
  state = reduce(state, { type: 'tasks_restored', list: [restored('a', 'own', 1, 1), restored('other', 'elsewhere', 0, 2)] })
  assert.deepEqual(cardedTasks(state).map(({ task }) => task.id), ['a'])
  assert.deepEqual(dockTasks(state).map(({ task }) => task.id), ['other'], 'seen state survives result reconstruction')
  const elsewhere = reduce(state, { type: 'new_session', at: 20 })
  assert.deepEqual(cardedTasks(elsewhere), [])
  const reopened = reduce(elsewhere, { type: 'conversation_opened', conversation: { id: 'own', messages: [user('front')] }, info: {} })
  assert.deepEqual(cardedTasks(reopened).map(({ task }) => task.id), ['a'])
  const closed = reduce(reopened, { type: 'task_closed', taskId: 'a' })
  assert.deepEqual(cardedTasks(closed), [])
})

test('live hosting takes precedence over a restored anchor, so a task is drawn only once', () => {
  let state = reduce(initialState, { type: 'history_loaded', conversationId: 'own', messages: [user('front')], savedAt: 1 })
  state = reduce(state, { type: 'tasks_restored', list: [restored('a', 'own', 0, 1)] })
  const hosted = { ...state, taskCards: ['a'] }
  assert.deepEqual(restoredTaskAnchors(hosted), [])
  assert.deepEqual(cardedTasks(hosted).map(({ task }) => task.id), ['a'])
})
