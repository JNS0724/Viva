import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createConversationSession, type ConversationInfo, type StartedConversation } from '../src/backend/conversation-session.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { ResumeError } from '../src/backend/resume-failure.ts'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEffects, type Outcome } from '../src/backend/effects.ts'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import { registerHistoryIpc } from '../src/backend/history-ipc.ts'
import { registerRewindIpc } from '../src/backend/rewind-ipc.ts'

type Runtime = NonNullable<ReturnType<Parameters<typeof createConversationSession>[0]['agent']>>
const started = (sessionId = 'new', cwd = '/work'): StartedConversation => ({ mode: 'live', model: 'local', cwd, sessionId, resumed: false })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(t: TestContext, overrides: Partial<Runtime> = {}, saved = false) {
  const db = openHistoryDb({ file: ':memory:' })
  t.after(() => db.close())
  const seed = db.create({ sessionId: 'old', cwd: '/work' })
  if (saved) db.save(seed, [{ role: 'user', text: 'saved words', receipt: null }])
  const calls: string[] = []
  const runtime: Runtime = {
    newSession: async () => { calls.push('new'); return started() },
    setConfig: async (_id, value) => { calls.push(`config:${value}`); return { ...started(), model: value, modelValue: value } },
    switchSession: async (id, cwd) => { calls.push(`switch:${id}`); return { ...started(id ?? 'fresh', cwd), resumed: Boolean(id) } },
    fork: async request => { calls.push('fork'); return { ok: true, info: started('forked', request.cwd) } },
    ...overrides,
  }
  let live: Runtime | null = runtime, view: ConversationInfo = started('old'), busy = false, changed = 0
  let onChanged = () => {}
  let selectedModel: string | null = null
  const sessions = createConversationSession({
    history: () => db, agent: () => live, info: () => view, setInfo: value => { view = value },
    isBusy: () => busy, folderExists: dir => dir !== '/gone', selectedModel: () => selectedModel, changed: () => { changed++; onChanged() },
  })
  sessions.open('/work')
  if (!saved) sessions.select(seed)
  return { db, sessions, calls, runtime, view: () => view, changed: () => changed,
    busy: (value: boolean) => { busy = value }, live: (value: Runtime | null) => { live = value },
    model: (value: string | null) => { selectedModel = value }, onChanged: (run: () => void) => { onChanged = run },
    switchAgent: (id: string | null, cwd?: string | null, options?: { exactly?: boolean }) => sessions.withSelection(ops => ops.switchAgent(id, cwd, options)),
    forkBack: (request: { words: string, occurrence: number }) => sessions.withSelection(ops => ops.forkAgent(request)),
    reconcile: (value: StartedConversation, cwd: string) => { view = sessions.ready(value, cwd) },
  }
}

test('startup selects stored history and falls back only when its directory is gone', t => {
  const h = harness(t, {}, true)
  assert.equal(h.sessions.current().sessionId, 'old')
  assert.deepEqual(h.sessions.startingIn('/default'), { cwd: '/work', resumeSessionId: 'old' })
  h.sessions.select({ ...h.sessions.current(), cwd: '/gone' })
  assert.deepEqual(h.sessions.startingIn('/default'), { cwd: '/default', resumeSessionId: 'old' })
  assert.equal(h.sessions.cwd(), '/default')
})

test('readiness reconciles the same segment with the actual session and its remembered state', t => {
  const h = harness(t, {}, true), before = h.sessions.current()
  const info = h.sessions.ready(started('replacement'), '/next')
  assert.equal(h.sessions.current().id, before.id)
  assert.equal(h.sessions.current().sessionId, 'replacement')
  assert.equal(h.sessions.cwd(), '/next')
  assert.equal(info.remembersHistory, false, 'saved history is not automatically context in a fresh session')
  assert.equal(h.sessions.ready({ ...started('resumed'), resumed: true }, '/next').remembersHistory, true)
})

test('concurrent new topics share acquisition and commit only after model matching', async t => {
  const gate = deferred<StartedConversation>(), h = harness(t, { newSession: () => gate.promise }, true)
  const previous = h.sessions.current()
  h.model('selected-model')
  const first = h.sessions.newTopic(), second = h.sessions.newTopic()
  assert.equal(first, second); assert.equal(h.sessions.isChanging(), true)
  assert.equal(h.sessions.current(), previous)
  gate.resolve({ ...started(), models: [{ value: 'selected-model' }] })
  assert.equal((await first).model, 'selected-model')
  assert.notEqual(h.sessions.current().id, previous.id)
  assert.equal(h.sessions.current().sessionId, 'new')
  assert.equal(h.sessions.isChanging(), false)
  assert.equal(h.db.get(previous.id)?.messages[0]?.text, 'saved words')
})

test('failed topic preparation releases admission for a retry without replacing saved history', async t => {
  const gate = deferred<StartedConversation>(), h = harness(t, { newSession: () => gate.promise }, true)
  const previous = h.sessions.current(), first = h.sessions.newTopic()
  gate.reject(new Error('transport failed'))
  await assert.rejects(first, /transport failed/)
  assert.equal(h.sessions.current(), previous); assert.equal(h.sessions.isChanging(), true, 'keep admission closed until the retry reconciles the runtime')
  h.live({ ...h.runtime, newSession: async () => started('retry') })
  await h.sessions.newTopic()
  assert.equal(h.sessions.current().sessionId, 'retry')
})

test('a model failure after acquisition keeps prompts and reports gated until a successful retry', async t => {
  let actualSession = 'old'
  const h = harness(t, {
    newSession: async () => { actualSession = 'new'; return { ...started(), models: [{ value: 'chosen' }] } },
    setConfig: async () => { throw new Error('model unavailable') },
  }, true), previous = h.sessions.current()
  h.model('chosen')
  await assert.rejects(h.sessions.newTopic(), /model unavailable/)
  assert.equal(h.sessions.current(), previous)
  assert.equal(actualSession, 'new'); assert.equal(h.view().sessionId, 'old')
  assert.equal(h.sessions.isChanging(), true, 'cached info cannot prove which session the runtime already opened')
  h.sessions.select(h.db.save(previous, [{ role: 'user', text: 'saved while preparing', receipt: null }]))
  assert.equal(h.sessions.isChanging(), true, 'a metadata save cannot commit a failed runtime transition')
  assert.throws(() => h.sessions.switchDirectory('/other'), 'cannot fork an uncommitted runtime as a child of the old segment')
  await assert.rejects(h.forkBack({ words: 'saved words', occurrence: 0 }))
  h.model(null); await h.sessions.newTopic()
  assert.notEqual(h.sessions.current().id, previous.id)
  assert.equal(h.sessions.isChanging(), false)
})

test('foreground work rejects every destructive session transition', t => {
  const h = harness(t); h.busy(true)
  assert.throws(() => h.sessions.newTopic())
  assert.throws(() => h.switchAgent('other', '/other'))
  assert.throws(() => h.sessions.switchDirectory('/other'))
  assert.throws(() => h.forkBack({ words: 'old', occurrence: 0 }))
  assert.deepEqual(h.calls, [])
})

test('offline reading keeps recorded sessions; exact resume reports why it cannot proceed', async t => {
  const h = harness(t); h.live(null)
  const previous = h.sessions.current()
  const read = await h.switchAgent('recorded', '/other')
  assert.equal(read.sessionId, 'recorded'); assert.equal(read.resumed, false)
  assert.equal(h.sessions.current(), previous, 'the history operation selects its own stored segment')
  await assert.rejects(h.switchAgent('recorded', '/gone', { exactly: true }), (e: unknown) => e instanceof ResumeError && e.reason === 'missing-dir')
  await assert.rejects(h.switchAgent('recorded', '/other', { exactly: true }), (e: unknown) => e instanceof ResumeError && e.reason === 'unavailable')
})

test('resume failure preserves the segment and follows an explicit recovered session', async t => {
  const h = harness(t, { switchSession: async () => { throw new ResumeError('gone', 'gone', { sessionId: 'recovered', resumed: false }) } }, true)
  const previous = h.sessions.current()
  await assert.rejects(h.switchAgent('lost', '/other', { exactly: true }), ResumeError)
  assert.equal(h.sessions.current().id, previous.id)
  assert.equal(h.sessions.current().sessionId, 'recovered')
  assert.equal(h.sessions.cwd(), '/work')
  assert.equal(h.view().remembersHistory, false)
  assert.equal(h.sessions.isChanging(), false)
})

test('failed directory forks do not create a segment or change the directory or agent view', async t => {
  const h = harness(t, { fork: async () => ({ ok: false, reason: 'missing' }) }, true)
  const previous = h.sessions.current(), view = h.view()
  await assert.rejects(async () => h.sessions.switchDirectory('/other'))
  assert.equal(h.sessions.current(), previous); assert.equal(h.sessions.cwd(), '/work')
  assert.equal(h.view(), view); assert.equal(h.sessions.isChanging(), false)
})

test('a directory fork becomes a child only when its predecessor was saved', async t => {
  for (const saved of [true, false]) {
    const h = harness(t, {}, saved), previous = h.sessions.current()
    const info = await h.sessions.switchDirectory('/other')
    assert.equal(info.remembersHistory, true)
    assert.equal(h.sessions.current().parentId, saved ? previous.id : null)
    assert.equal(h.sessions.current().sessionId, 'forked')
    assert.equal(h.sessions.current().cwd, '/other')
    assert.equal(h.sessions.cwd(), '/other')
  }
})

test('offline directory changes preserve the saved parent without fabricating a live session', async t => {
  const h = harness(t, {}, true), previous = h.sessions.current(); h.live(null)
  await h.sessions.switchDirectory('/other')
  assert.equal(h.sessions.current().parentId, previous.id)
  assert.equal(h.sessions.current().sessionId, null)
  assert.equal(h.sessions.cwd(), '/other')
  await h.sessions.newTopic()
  assert.equal(h.sessions.current().parentId, null)
})

test('different transitions cannot overlap with a pending new topic', async t => {
  const gate = deferred<StartedConversation>(), h = harness(t, { newSession: () => gate.promise })
  const pending = h.sessions.newTopic()
  await assert.rejects(async () => h.sessions.switchDirectory('/other'))
  await assert.rejects(h.switchAgent('other', '/other'))
  await assert.rejects(h.forkBack({ words: 'old', occurrence: 0 }))
  assert.deepEqual(h.calls, [])
  gate.resolve(started()); await pending
  await h.sessions.switchDirectory('/other')
  assert.deepEqual(h.calls, ['fork'])
})

test('a retired runtime cannot publish a late new topic or model result', async t => {
  const gate = deferred<StartedConversation>(), h = harness(t, { newSession: () => gate.promise }, true)
  const previous = h.sessions.current(), pending = h.sessions.newTopic()
  h.live({ ...h.runtime }); gate.resolve(started('stale'))
  await assert.rejects(pending)
  assert.equal(h.sessions.current(), previous); assert.equal(h.view().sessionId, 'old')
  assert.equal(h.sessions.isChanging(), true)
  h.sessions.ready(started('reconnected'), '/work')
  assert.equal(h.sessions.isChanging(), false)
})

test('a late directory fork from a replaced process cannot change the selected topic', async t => {
  const gate = deferred<Awaited<ReturnType<Runtime['fork']>>>(), h = harness(t, { fork: () => gate.promise }, true)
  const previous = h.sessions.current(), pending = h.sessions.switchDirectory('/other')
  h.live({ ...h.runtime }); gate.resolve({ ok: true, info: started('stale', '/other') })
  await assert.rejects(pending)
  assert.equal(h.sessions.current(), previous); assert.equal(h.sessions.cwd(), '/work')
})

test('records are carried once, for the selected conversation only', t => {
  const h = harness(t), previous = h.sessions.current()
  h.sessions.carryNext(previous.id, 'saved context')
  assert.equal(h.sessions.takeCarried(), 'saved context'); assert.equal(h.sessions.takeCarried(), null)
  h.sessions.carryNext(previous.id, 'stale context'); h.live(null); h.sessions.reset()
  assert.equal(h.sessions.takeCarried(), null)
})

test('saving the selected conversation keeps its directory and one-time records', t => {
  const h = harness(t), before = h.sessions.current(), changed = h.changed()
  h.sessions.carryNext(before.id, 'context')
  h.sessions.select(h.db.save(before, [{ role: 'user', text: 'words', receipt: null }]))
  assert.equal(h.sessions.current().id, before.id); assert.equal(h.sessions.cwd(), '/work')
  assert.equal(h.sessions.takeCarried(), 'context'); assert.equal(h.changed(), changed + 1)
})

test('waiting effects resume after a committed new topic; a failed preparation waits for its retry', async t => {
  for (const fail of [false, true]) {
    const gate = deferred<StartedConversation>(), h = harness(t, { newSession: () => gate.promise }, true)
    const app = openAppDb({ file: ':memory:' }), effects = createEffects({ db: app.db })
    t.after(() => { app.close() })
    const sent: string[] = []
    effects.runs('report', async entries => new Map(entries.map(entry => {
      const outcome: Outcome = h.sessions.isChanging() ? 'wait' : 'done'
      if (outcome === 'done') sent.push(h.sessions.current().id)
      return [entry.key, outcome]
    })))
    h.onChanged(() => { void effects.wake() })
    const pending = h.sessions.newTopic()
    effects.queue('report', 'task:run', {})
    await effects.wake(); assert.equal(effects.list().length, 1)
    if (fail) {
      gate.reject(new Error('unavailable')); await assert.rejects(pending)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(effects.list().length, 1); assert.deepEqual(sent, [])
      h.live({ ...h.runtime, newSession: async () => started('retry') })
      await h.sessions.newTopic()
    }
    else { gate.resolve(started()); await pending }
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(effects.list().length, 0)
    assert.deepEqual(sent, [h.sessions.current().id])
  }
})

test('history commit keeps effects away between the runtime switch and selecting its segment', async t => {
  const h = harness(t, {}, true), previous = h.sessions.current()
  const app = openAppDb({ file: ':memory:' }), effects = createEffects({ db: app.db })
  t.after(() => { app.close() })
  const sent: string[] = []
  effects.runs('report', async entries => new Map(entries.map(entry => {
    const outcome: Outcome = h.sessions.isChanging() ? 'wait' : 'done'
    if (outcome === 'done') sent.push(h.sessions.current().id)
    return [entry.key, outcome]
  })))
  h.onChanged(() => { void effects.wake() })
  effects.queue('report', 'task:run', {})
  const switched = deferred<void>(), commit = deferred<void>()
  const pending = h.sessions.withSelection(async ({ switchAgent, select }) => {
    // A resumed topic may use the very same runtime session but still create a different segment.
    const result = await switchAgent('old', '/work', { exactly: true })
    switched.resolve(); await commit.promise
    const next = h.db.create({ sessionId: result.sessionId, cwd: result.cwd, parentId: previous.id })
    select(next)
    return next
  })
  await switched.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.sessions.current(), previous)
  assert.equal(h.sessions.isChanging(), true, 'runtime and selected segment must agree before admitting prompts/reports')
  assert.deepEqual(sent, []); assert.equal(effects.list().length, 1)
  await assert.rejects(h.sessions.newTopic(), /./, 'a second transition cannot bypass the outstanding history commit')
  commit.resolve(); const next = await pending
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.sessions.isChanging(), false)
  assert.deepEqual(sent, [next.id]); assert.equal(effects.list().length, 0)
})

test('a rejected directory fork wakes waiting effects on the unchanged conversation', async t => {
  const gate = deferred<Awaited<ReturnType<Runtime['fork']>>>(), h = harness(t, { fork: () => gate.promise }, true)
  const app = openAppDb({ file: ':memory:' }), effects = createEffects({ db: app.db })
  t.after(() => app.close())
  const sent: string[] = []
  effects.runs('report', async entries => new Map(entries.map(entry => {
    const outcome: Outcome = h.sessions.isChanging() ? 'wait' : 'done'
    if (outcome === 'done') sent.push(h.sessions.current().id)
    return [entry.key, outcome]
  })))
  h.onChanged(() => { void effects.wake() })
  const previous = h.sessions.current(), pending = h.sessions.switchDirectory('/other')
  effects.queue('report', 'task:run', {}); await effects.wake()
  gate.resolve({ ok: false, reason: 'missing' }); await assert.rejects(pending)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(sent, [previous.id]); assert.equal(effects.list().length, 0)
})

test('real history and rewind handlers hold selection admission through their database commits', async t => {
  const h = harness(t, {}, true)
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = checkedIpc({ handle: (channel, listener) => { handlers.set(channel, listener) }, on: () => {} })
  const deps = {
    db: h.db, current: h.sessions.current, setCurrent: h.sessions.select,
    agentInfo: h.view, isBusy: () => false, selectSession: h.sessions.withSelection,
  }
  registerHistoryIpc(ipc, { ...deps, dshHome: '/unused-test-home', chooseExportPath: async () => null })
  registerRewindIpc(ipc, deps)
  const seen: string[] = []
  h.onChanged(() => { if (!h.sessions.isChanging()) seen.push(h.sessions.current().id) })
  const original = h.sessions.current()
  await handlers.get('history:resume-topic')?.({}, original.id)
  const resumed = h.sessions.current()
  assert.notEqual(resumed.id, original.id); assert.equal(resumed.sessionId, original.sessionId)
  assert.deepEqual(seen, [resumed.id], 'same-session segment selection must finish before reports may wake')
  h.sessions.select(h.db.save(resumed, [{ role: 'user', text: 'rewind these words', receipt: null }]))
  seen.length = 0
  await handlers.get('timeline:rewind')?.({}, { words: 'rewind these words', occurrence: 0, keep: 0, text: 'revised words' })
  assert.notEqual(h.sessions.current().id, resumed.id)
  assert.equal(h.sessions.current().sessionId, 'forked')
  assert.deepEqual(seen, [h.sessions.current().id])
  assert.equal(h.sessions.isChanging(), false)
})

test('a selection callback retired by readiness cannot commit, even on the same runtime instance', async t => {
  for (const replacement of [false, true]) {
  const h = harness(t, {}, true), switched = deferred<void>(), commit = deferred<void>()
  const pending = h.sessions.withSelection(async ({ switchAgent, select }) => {
    const result = await switchAgent('older', '/other', { exactly: true })
    switched.resolve(); await commit.promise
    select(h.db.create({ sessionId: result.sessionId, cwd: result.cwd }))
  })
  await switched.promise
  if (replacement) h.live({ ...h.runtime })
  h.reconcile(started('replacement'), '/work')
  const current = h.sessions.current()
  commit.resolve(); await assert.rejects(pending)
  assert.equal(h.sessions.current(), current)
  assert.equal(h.sessions.current().sessionId, 'replacement')
  assert.equal(h.view().sessionId, 'replacement')
  assert.equal(h.sessions.isChanging(), false)
  }
})
