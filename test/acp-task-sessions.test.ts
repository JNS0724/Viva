import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NewSessionResponse, ResumeSessionResponse, SessionConfigOption, SetSessionConfigOptionRequest } from '@agentclientprotocol/sdk'
import { createAcpTaskSessions } from '../src/backend/acp-task-sessions.ts'

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const select = (value: string): SessionConfigOption => ({ id: 'model', name: 'Model', type: 'select', currentValue: value, options: [{ value, name: value }] })
const toggle = (value: boolean): SessionConfigOption => ({ id: 'flag', name: 'Flag', type: 'boolean', currentValue: value })
function harness(overrides: Partial<Parameters<typeof createAcpTaskSessions>[0]> = {}) {
  const closed: string[] = [], configured: SetSessionConfigOptionRequest[] = [], events: object[] = []
  let returnedFlag = false
  let source: readonly SessionConfigOption[] = [select('chosen'), toggle(true)], prepares = 0
  const sessions = createAcpTaskSessions({
    connection: () => ({ closeSession: async request => { closed.push(request.sessionId); return {} }, setSessionConfigOption: async request => { configured.push(request); if ('type' in request && request.type === 'boolean') returnedFlag = request.value; return { configOptions: [select('chosen'), toggle(returnedFlag)] } } }),
    acquire: { fresh: async () => ({ sessionId: 'task', configOptions: [select('default'), toggle(false)] }), resume: async () => ({ configOptions: [select('default')] }) },
    foreground: () => ({ sessionId: 'main', cwd: '/origin', config: source }), canResume: () => true, prepareFresh: () => { prepares++ },
    operations: { run: async () => {}, cancelInTime: async () => {}, count: () => 0 },
    permissions: { pendingFor: () => [], waitingSessions: () => new Set() }, questions: { declineTask: () => {}, pendingOf: () => [] },
    steer: async () => ({ ok: true }), markReadOnly: async () => true, emit: event => { events.push(event) }, describeError: String, goneMessage: () => 'gone', stoppedMessage: () => 'stopped',
    ...overrides,
  })
  return { sessions, closed, configured, events, prepares: () => prepares, source: (value: readonly SessionConfigOption[]) => { source = value } }
}

test('task configuration and directory are captured before its fresh session arrives, including boolean options', async () => {
  const fresh = deferred<NewSessionResponse>(), dirs: string[] = []
  const h = harness({ acquire: { fresh: cwd => { dirs.push(cwd); return fresh.promise }, resume: async () => ({}) } })
  const original = select('chosen'); h.source([original, toggle(true)])
  const pending = h.sessions.startTask(); original.currentValue = 'mutated'; h.source([select('later'), toggle(false)])
  fresh.resolve({ sessionId: 'task', configOptions: [select('default'), toggle(false)] })
  assert.deepEqual(await pending, { ok: true, taskId: 'task' })
  assert.deepEqual(dirs, ['/origin'])
  assert.deepEqual(h.configured, [{ sessionId: 'task', configId: 'model', value: 'chosen' }, { sessionId: 'task', configId: 'flag', type: 'boolean', value: true }])
  assert.equal(h.sessions.has('task'), true)
})

for (const mode of ['fresh', 'resume'] as const) test(`disposal revokes in-flight ${mode} acquisition and releases its late native session`, async () => {
  const gate = deferred<NewSessionResponse>(), h = harness({ acquire: { fresh: () => gate.promise, resume: () => gate.promise } })
  const pending = mode === 'fresh' ? h.sessions.startTask() : h.sessions.resumeTask({ taskId: 'task' })
  await new Promise<void>(resolve => setImmediate(resolve))
  h.sessions.dispose(); gate.resolve({ sessionId: 'task' })
  assert.equal((await pending).ok, false)
  assert.equal(h.sessions.has('task'), false); assert.deepEqual(h.closed, ['task']); assert.equal(h.prepares(), 0)
})

test('failed unattended permission marking closes the acquired session before returning refusal', async () => {
  const mark = deferred<boolean>(), h = harness({ markReadOnly: () => mark.promise })
  const pending = h.sessions.startReadOnlyTask({ cwd: '/scheduled' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.sessions.isUnattended('task'), true)
  mark.resolve(false)
  assert.deepEqual(await pending, { ok: false, reason: 'unavailable' })
  assert.equal(h.sessions.has('task'), false); assert.equal(h.sessions.isUnattended('task'), false); assert.deepEqual(h.closed, ['task'])
})

test('failed model matching retires the unreported session instead of keeping a native attachment', async t => {
  t.mock.method(console, 'error', () => {})
  const closed: string[] = [], h = harness({ connection: () => ({ closeSession: async request => { closed.push(request.sessionId); return {} }, setSessionConfigOption: async () => { throw new Error('no such option') } }) })
  assert.equal((await h.sessions.startTask()).ok, false)
  assert.deepEqual(closed, ['task']); assert.equal(h.sessions.has('task'), false); assert.deepEqual(h.events, [])
})

test('closing a saved task revokes its pending native resume instead of attaching after the user closed it', async () => {
  const resume = deferred<ResumeSessionResponse>(), h = harness({ acquire: { fresh: async () => ({ sessionId: 'unused' }), resume: () => resume.promise } })
  const pending = h.sessions.resumeTask({ taskId: 'saved' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.sessions.has('saved'), false)
  await h.sessions.closeTask('saved'); resume.resolve({})
  assert.equal((await pending).ok, false)
  assert.equal(h.sessions.has('saved'), false)
  assert.deepEqual(h.closed, ['saved'])
})

test('an old configuration rejection cannot delete or close a newer attachment of the same native id', async t => {
  t.mock.method(console, 'error', () => {})
  const config = deferred<{ configOptions: SessionConfigOption[] }>(), closed: string[] = []
  const h = harness({ connection: () => ({ setSessionConfigOption: () => config.promise, closeSession: async request => { closed.push(request.sessionId); return {} } }) })
  const pending = h.sessions.startTask()
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.sessions.closeTask('task')
  assert.equal((await h.sessions.resumeTask({ taskId: 'task' })).ok, true)
  config.reject(new Error('old configuration failed'))
  assert.equal((await pending).ok, false)
  assert.equal(h.sessions.has('task'), true)
  assert.deepEqual(closed, ['task'])
})

test('a reattachment waits for the previous native close and cannot have its permissions cancelled by old cleanup', async () => {
  const close = deferred<object>(), log: string[] = []
  const h = harness({
    connection: () => ({ setSessionConfigOption: async () => ({ configOptions: [select('chosen'), toggle(true)] }), closeSession: async () => { log.push('closing'); await close.promise; log.push('closed'); return {} } }),
    acquire: { fresh: async () => ({ sessionId: 'task' }), resume: async () => { log.push('resume'); return {} } },
    questions: { declineTask: () => { log.push('decline-old') }, pendingOf: () => [] },
  })
  await h.sessions.startTask()
  const closing = h.sessions.closeTask('task'), pending = h.sessions.resumeTask({ taskId: 'task' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(log, ['decline-old', 'closing'])
  close.resolve({}); await closing
  assert.equal((await pending).ok, true)
  assert.deepEqual(log, ['decline-old', 'closing', 'closed', 'resume'])
})

test('an old unattended acknowledgement cannot close a newer attachment of the same native id', async () => {
  const mark = deferred<boolean>(), h = harness({ markReadOnly: () => mark.promise })
  const pending = h.sessions.startReadOnlyTask({ cwd: '/scheduled' })
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.sessions.closeTask('task')
  await h.sessions.resumeTask({ taskId: 'task' })
  mark.resolve(false)
  assert.equal((await pending).ok, false)
  assert.equal(h.sessions.has('task'), true)
  assert.equal(h.sessions.isUnattended('task'), false)
  assert.deepEqual(h.closed, ['task'])
})
