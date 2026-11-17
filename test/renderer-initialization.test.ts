import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInitializationActions } from '../src/renderer/initialization-actions.ts'
import { createRendererStream } from '../src/backend/renderer-stream.ts'
import { createAgentEvents } from '../src/renderer/agent-events.ts'
import { createConversationActions } from '../src/renderer/conversation-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createMemoryActions } from '../src/renderer/memory-actions.ts'
import { createConversationIngress } from '../src/renderer/conversation-ingress.ts'
import type { RendererSnapshot } from '../src/shared/renderer-sync.ts'

const context = { conversationId: 'conversation', sessionId: 'session' }
const info = { mode: 'live', model: 'fixture', cwd: '/workspace', ...context }
const snapshot = (cursor = 0, replay: unknown[] = []): RendererSnapshot => ({ streamGeneration: 'generation', cutoverCursor: cursor, context, info, history: null, replay })
const push = (cursor: number, text = String(cursor), generation = 'generation') => ({ type: 'update', context, streamGeneration: generation, eventCursor: cursor,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }

test('startup installs trusted snapshot then replay and only deltas beyond its cutoff, rejecting old same-conversation pushes', async t => {
  const required = deferred<RendererSnapshot>(), received: unknown[] = [], failures: string[] = []
  const actions = createInitializationActions({ snapshot: () => required.promise, install: value => received.push(value.info),
    deliver: value => received.push(value), pause() {}, initialized() {}, loading() {}, failed: reason => failures.push(reason) })
  t.after(actions.close)
  const initialized = actions.initialize()
  actions.receive(push(1, 'already in replay'))
  actions.receive(push(2, 'after snapshot'))
  required.resolve(snapshot(1, [push(1, 'replayed')]))
  assert.equal(await initialized, true)
  assert.deepEqual(received, [info, push(1, 'replayed'), push(2, 'after snapshot')])
  actions.receive(push(2, 'duplicate')); assert.equal(received.length, 3)
  actions.receive(push(3, 'old owner', 'old-generation'))
  assert.deepEqual(failures, ['boundary'])
  assert.equal(received.length, 3)
})

test('hung required snapshots stop accumulation on count, bytes, age and deadline; retry rejects old asynchronous snapshots', async t => {
  for (const [limits, reason] of [
    [{ maxEvents: 1 }, 'capacity'], [{ maxBytes: 1 }, 'capacity'], [{ maxAgeMs: 5 }, 'age'], [{ budgetMs: 5 }, 'timeout'],
  ] as const) {
    const stale = deferred<RendererSnapshot>(), fresh = deferred<RendererSnapshot>(), installs: RendererSnapshot[] = [], failures: string[] = []
    let calls = 0
    const actions = createInitializationActions({ snapshot: () => ++calls === 1 ? stale.promise : fresh.promise,
      install: view => installs.push(view), deliver() {}, pause() {}, initialized() {}, loading() {}, failed: value => failures.push(value), ...limits })
    t.after(actions.close)
    const first = actions.initialize(); await tick()
    actions.receive(push(1)); actions.receive(push(2))
    await first
    assert.equal(failures[0], reason)
    for (let i = 0; i < 100; i++) actions.receive(push(3 + i))
    assert.deepEqual(actions.state(), { mode: 'failed', heldCount: 0, heldBytes: 0 })
    const retry = actions.initialize()
    stale.resolve(snapshot(999))
    fresh.resolve(snapshot(103))
    assert.equal(await retry, true)
    assert.deepEqual(installs.map(view => view.cutoverCursor), [103])
  }
})

test('backend publication snapshots use saved history cutoffs, bound replay storage and reject invented save watermarks', () => {
  const sent: Array<Record<string, unknown>> = []
  const stream = createRendererStream(event => sent.push(event))
  stream.send({ type: 'update', context, update: { text: 'one' } })
  const first = stream.snapshot(context.conversationId, context)
  stream.save(context.conversationId, { streamGeneration: first.streamGeneration, eventCursor: first.cutoverCursor })
  stream.send({ type: 'update', context, update: { text: 'two' } })
  assert.equal(stream.snapshot(context.conversationId, context).replay.length, 1)
  assert.throws(() => stream.save(context.conversationId, { streamGeneration: 'old', eventCursor: 1 }), /Stale/)
  assert.throws(() => stream.save(context.conversationId, { streamGeneration: first.streamGeneration, eventCursor: 99 }), /Stale/)
  for (let i = 0; i < 1030; i++) stream.send({ type: 'update', context, update: { text: 'bounded' } })
  assert.throws(() => stream.snapshot(context.conversationId, context), /gap/)
  const last = sent.at(-1)!
  stream.save(context.conversationId, { streamGeneration: String(last.streamGeneration), eventCursor: Number(last.eventCursor) })
  assert.deepEqual(stream.snapshot(context.conversationId, context).replay, [])
})

test('initialization retry replaces the stale view without resetting draft ownership, and forbids sends while unsafe', () => {
  let state: State = reduce(initialState, { type: 'ready', info })
  state = reduce(state, { type: 'user_prompt', text: 'old', at: 1 })
  state = reduce(state, { type: 'initialization_status', status: 'failed', reason: 'gap' })
  let sends = 0
  const api = { prompt: async () => { sends++ }, steer: async () => ({ ok: true }), answerQuestion: async () => true, provideSecrets: async () => true }
  const actions = createConversationActions({ api, getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast() {}, errorMessage: String, beforePrompt() {}, keepPicture() {} })
  assert.equal(actions.ask('draft must remain'), false); assert.equal(sends, 0)
  const memory = state.memory, workDir = state.workDir
  state = reduce(state, { type: 'initialization_snapshot', snapshot: snapshot() })
  assert.equal(state.messages.length, 0)
  assert.equal(state.memory, memory); assert.equal(state.workDir, workDir)
  assert.equal(state.initialization.status, 'failed', 'snapshot installation alone does not admit model requests')
})

test('optional memory coalesces only live same-page reads and retries independently after timeout without late overwrite', async () => {
  let state: State = initialState
  const requests: ReturnType<typeof deferred<{ profile: object, onboarding: string, habits: { text: string, samples: number } }>>[] = []
  const api = { getMemory: () => { const request = deferred<{ profile: object, onboarding: string, habits: { text: string, samples: number } }>(); requests.push(request); return request.promise } } as AgentApi
  const actions = createMemoryActions({ api, getState: () => state, dispatch: action => { state = reduce(state, action) },
    errorMessage: String, showToast() {}, ask: () => false, readBudgetMs: 10 })
  const first = actions.loadMemory(), same = actions.loadMemory()
  assert.equal(first, same); assert.equal(await first, false)
  const second = actions.loadMemory(); await tick()
  requests[0]!.resolve({ profile: { stale: true }, onboarding: 'pending', habits: { text: '', samples: 0 } })
  requests[1]!.resolve({ profile: { fresh: true }, onboarding: 'done', habits: { text: '', samples: 0 } })
  assert.equal(await second, true)
  assert.deepEqual(state.memory.profile, { fresh: true })
})

test('required conversation events initialize independently of permanently pending memory reads with a failing logger', async t => {
  let state: State = initialState
  const events = createAgentEvents({ getState: () => state, dispatch: action => { state = reduce(state, action) }, holdTask: () => false,
    afterTurn() {}, clearAfterTurn() {}, ready() {}, refreshWorkDir() {}, refreshFiles() {}, refreshFeed() {}, memoryChanged() {}, filesChanged() {} })
  const actions = createInitializationActions({ snapshot: async () => snapshot(), install: view => { state = reduce(state, { type: 'initialization_snapshot', snapshot: view }) },
    deliver: events.receive, pause: events.pause, initialized: events.initialize, failed() { assert.fail('should initialize') }, loading() {}, observe() { throw new Error('broken logger') } })
  t.after(actions.close)
  assert.equal(await actions.initialize(), true)
  actions.receive(push(1, 'works without memory'))
  assert.equal(state.messages.at(-1)?.text, 'works without memory')
})

test('selection buffering has count, retained-content and oldest-age bounds without stopping task events', async () => {
  for (const limits of [{ maxEvents: 1 }, { maxBytes: 100 }, { maxAgeMs: 5 }]) {
    const failed: string[] = [], delivered: string[] = []
    const ingress = createConversationIngress({ current: () => ({ pending: true, context }),
      deliver: (value: { type: string, context?: typeof context }) => delivered.push(value.type), overflow: reason => failed.push(reason), ...limits })
    ingress.receive({ type: 'update', context }); ingress.receive({ type: 'update', context })
    if ('maxAgeMs' in limits) await new Promise(resolve => setTimeout(resolve, 12))
    assert.equal(failed.length, 1)
    ingress.receive({ type: 'update', context })
    ingress.receive({ type: 'task_update' })
    assert.deepEqual(delivered, ['task_update'])
    ingress.pause()
  }
})

test('snapshot identity, retired generations and missing publication cursors cannot overwrite the current conversation', async t => {
  for (const view of [
    { ...snapshot(), context: { ...context, sessionId: 'wrong-session' } },
    { ...snapshot(), streamGeneration: 'obsolete-generation' },
  ]) {
    let installed = 0
    const failures: string[] = []
    const required = deferred<RendererSnapshot>()
    const actions = createInitializationActions({ snapshot: () => required.promise, install: () => { installed++ }, deliver() {},
      pause() {}, initialized() {}, loading() {}, failed: reason => failures.push(reason) })
    t.after(actions.close)
    const pending = actions.initialize(); actions.receive(push(1)); required.resolve(view)
    assert.equal(await pending, false)
    assert.equal(installed, 0); assert.deepEqual(failures, ['boundary'])
  }
})

test('withdrawn generated content is never available from the backend replay cache', () => {
  const stream = createRendererStream(() => {})
  stream.send({ type: 'update', context, update: { text: 'withdrawn thought' } })
  stream.send({ type: 'memory_changed', traceSessions: [context.sessionId] })
  assert.throws(() => stream.snapshot(context.conversationId, context), /gap/)
  const reports = createRendererStream(() => {})
  reports.send({ type: 'report_delivered', context, reportId: 'withdrawn-report', text: 'withdrawn' })
  reports.send({ type: 'reports_removed', reportIds: ['withdrawn-report'] })
  assert.throws(() => reports.snapshot(context.conversationId, context), /gap/)
})

test('a withdrawal arriving before an older snapshot response prevents installation of that snapshot', async t => {
  for (const event of [{ type: 'memory_changed', traceSessions: [context.sessionId] }, { type: 'reports_removed', reportIds: ['report'] }]) {
    const required = deferred<RendererSnapshot>(), installed: RendererSnapshot[] = [], failed: string[] = []
    const actions = createInitializationActions({ snapshot: () => required.promise, install: value => installed.push(value), deliver() {},
      pause() {}, initialized() {}, loading() {}, failed: reason => failed.push(reason) })
    t.after(actions.close)
    const pending = actions.initialize()
    actions.receive({ ...event, streamGeneration: 'generation', eventCursor: 1 })
    actions.receive({ ...event, streamGeneration: 'generation', eventCursor: 0 })
    required.resolve(snapshot(0))
    assert.equal(await pending, false)
    assert.deepEqual(installed, []); assert.deepEqual(failed, ['boundary'])
  }
})
