import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createInitializationActions } from '../src/renderer/initialization-actions.ts'
import { createTimelineActions } from '../src/renderer/timeline-actions.ts'
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

test('startup and a scroll cannot load past the recent timeline boundary', async () => {
  let state: State = reduce(initialState, { type: 'initialization_status', status: 'loading' })
  let reads = 0
  const actions = createTimelineActions({ getState: () => state, dispatch: action => { state = reduce(state, action) },
    scroll: Object.assign(Object.create(null) as HTMLElement, { scrollTop: 0, scrollHeight: 100 }),
    api: { earlierSegments: async () => { reads++; return { segments: [{ id: 'older', createdAt: 1, messages: [] }], hasMore: true } } } })
  actions.onScroll()
  assert.equal(reads, 0)
  state = reduce(state, { type: 'initialization_status', status: 'ready' })
  await actions.loadEarlier()
  actions.onScroll()
  await actions.loadEarlier()
  assert.equal(reads, 1)
  assert.equal(state.earlier.hasMore, true)
})
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }

function backendStream(t: TestContext, publish: Parameters<typeof createRendererStream>[0] = () => {}) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  return createRendererStream(publish, db)
}

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

test('initialization rejects a missing first delta instead of silently advancing the snapshot watermark', async t => {
  const required = deferred<RendererSnapshot>(), installed: RendererSnapshot[] = [], received: unknown[] = [], failures: string[] = []
  const actions = createInitializationActions({ snapshot: () => required.promise, install: view => installed.push(view),
    deliver: event => received.push(event), pause() {}, initialized() {}, loading() {}, failed: reason => failures.push(reason) })
  t.after(actions.close)
  const pending = actions.initialize()
  actions.receive(push(3))
  required.resolve(snapshot(0))
  assert.equal(await pending, false)
  assert.deepEqual(installed, [])
  assert.deepEqual(received, [])
  assert.deepEqual(failures, ['gap'])
})

test('a snapshot may cover missing early deltas; duplicate buffered pushes are applied once', async t => {
  const required = deferred<RendererSnapshot>(), received: unknown[] = []
  const actions = createInitializationActions({ snapshot: () => required.promise, install() {},
    deliver: event => received.push(event), pause() {}, initialized() {}, loading() {}, failed() { assert.fail('snapshot covers the gap') } })
  t.after(actions.close)
  const pending = actions.initialize()
  actions.receive(push(3))
  actions.receive(push(3, 'duplicate'))
  actions.receive(push(4))
  required.resolve(snapshot(2))
  assert.equal(await pending, true)
  assert.deepEqual(received, [push(3), push(4)])
  assert.equal(actions.watermark()?.eventCursor, 4)
})

test('a retry cannot install a snapshot older than events discarded by the failed initialization', async t => {
  const required = deferred<RendererSnapshot>(), installed: RendererSnapshot[] = [], failures: string[] = []
  const actions = createInitializationActions({ snapshot: () => required.promise, install: view => installed.push(view),
    deliver() {}, pause() {}, initialized() {}, loading() {}, failed: reason => failures.push(reason), maxEvents: 1 })
  t.after(actions.close)
  const first = actions.initialize()
  actions.receive(push(1)); actions.receive(push(2))
  assert.equal(await first, false)
  actions.receive(push(3))
  const retry = actions.initialize()
  required.resolve(snapshot(2))
  assert.equal(await retry, false)
  assert.deepEqual(installed, [])
  assert.deepEqual(failures, ['capacity', 'gap'])
})

test('a replacement stream validates its own first delta and does not inherit the previous stream gap', async t => {
  for (const firstCursor of [1, 3]) {
    const required = deferred<RendererSnapshot>(), received: unknown[] = [], failures: string[] = []
    const actions = createInitializationActions({ snapshot: () => required.promise, install() {},
      deliver: event => received.push(event), pause() {}, initialized() {}, loading() {}, failed: reason => failures.push(reason) })
    t.after(actions.close)
    const pending = actions.initialize()
    actions.receive(push(1, 'obsolete', 'old-generation'))
    actions.receive(push(99, 'obsolete gap', 'old-generation'))
    actions.receive(push(firstCursor))
    required.resolve(snapshot(0))
    assert.equal(await pending, firstCursor === 1)
    assert.deepEqual(received, firstCursor === 1 ? [push(1)] : [])
    assert.deepEqual(failures, firstCursor === 1 ? [] : ['gap'])
  }
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

test('backend publication snapshots use backend-owned history cutoffs, bound replay storage and annotate mid-turn persisted questions', t => {
  const sent: Array<Record<string, unknown>> = []
  const stream = backendStream(t, event => sent.push(event))
  stream.send({ type: 'update', context, update: { text: 'one' } })
  assert.equal(stream.snapshot(context.conversationId, context).replay.length, 1)
  stream.checkpoint(context.conversationId)
  stream.send({ type: 'question_answered', context, questionId: 'q1', answers: [] })
  stream.markLatestPersisted(context.conversationId, 'question_answered')
  stream.send({ type: 'update', context, update: { text: 'two' } })
  const replayed = stream.snapshot(context.conversationId, context).replay as Array<Record<string, unknown>>
  assert.equal(replayed.length, 2)
  assert.equal(replayed[0]?.inHistory, true, 'replayed persisted question answers signal reload dedup')
  assert.equal(sent.find(event => event.type === 'question_answered')?.inHistory, undefined, 'live publication stays unflagged')
  for (let i = 0; i < 1030; i++) stream.send({ type: 'update', context, update: { text: 'bounded' } })
  assert.throws(() => stream.snapshot(context.conversationId, context), /gap/)
  stream.checkpoint(context.conversationId)
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

test('withdrawn generated content is never available from the backend replay cache', t => {
  const stream = backendStream(t)
  stream.send({ type: 'update', context, update: { text: 'withdrawn thought' } })
  stream.send({ type: 'memory_changed', traceSessions: [context.sessionId] })
  assert.throws(() => stream.snapshot(context.conversationId, context), /gap/)
  const reports = backendStream(t)
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

test('a cutover inside a missing range cannot release the foreground', async t => {
  for (const cutover of [2, 3, 4]) {
    const required = deferred<RendererSnapshot>(), delivered: unknown[] = [], failures: string[] = []
    const actions = createInitializationActions({ snapshot: () => required.promise, install() {}, deliver: event => delivered.push(event),
      pause() {}, initialized() {}, loading() {}, failed: reason => failures.push(reason) })
    t.after(actions.close)
    const pending = actions.initialize()
    actions.receive(push(1)); actions.receive(push(5))
    required.resolve(snapshot(cutover))
    assert.equal(await pending, cutover === 4)
    assert.deepEqual(failures, cutover === 4 ? [] : ['gap'])
    assert.deepEqual(delivered, cutover === 4 ? [push(5)] : [])
    assert.equal(actions.watermark()?.eventCursor, cutover === 4 ? 5 : undefined)
  }
})

test('an unfamiliar push only suspends the handoff; a fresh snapshot chooses the live owner', async t => {
  for (const replacement of [false, true]) {
    let view = snapshot(7)
    const delivered: unknown[] = [], failures: string[] = []
    const actions = createInitializationActions({ snapshot: async () => view, install() {}, deliver: event => delivered.push(event),
      pause() {}, initialized() {}, loading() {}, failed: reason => failures.push(reason) })
    t.after(actions.close)
    assert.equal(await actions.initialize(), true)
    actions.receive(push(1, 'unconfirmed', 'other'))
    assert.deepEqual(failures, ['boundary'])
    assert.equal(actions.watermark(), undefined)
    const current = replacement ? 'other' : 'generation', obsolete = replacement ? 'generation' : 'other'
    view = { ...snapshot(replacement ? 2 : 7), streamGeneration: current }
    assert.equal(await actions.initialize(), true)
    actions.receive(push(10, 'obsolete', obsolete))
    const next = push(view.cutoverCursor + 1, 'live', current)
    actions.receive(next)
    assert.deepEqual(delivered, [next])
    assert.deepEqual(failures, ['boundary'])
    assert.equal(actions.watermark()?.streamGeneration, current)
  }
})

test('replay loss is scoped to the segment and session-wide configuration only blocks its own session', t => {
  const stream = backendStream(t), sibling = { ...context, conversationId: 'sibling' }, other = { conversationId: 'other', sessionId: 'other' }
  for (let i = 0; i < 1025; i++) stream.send({ type: 'update', context })
  assert.throws(() => stream.snapshot(context.conversationId, context), /gap/)
  for (const target of [sibling, other]) assert.deepEqual(stream.snapshot(target.conversationId, target).replay, [])

  stream.send({ type: 'config', context: { ...context, conversationId: null } })
  for (let i = 0; i < 1024; i++) stream.send({ type: 'update', context: other })
  assert.throws(() => stream.snapshot(sibling.conversationId, sibling), /gap/)
  assert.equal(stream.snapshot(other.conversationId, other).replay.length, 1024)
  stream.checkpoint(sibling.conversationId)
  assert.deepEqual(stream.snapshot(sibling.conversationId, sibling).replay, [])
})

test('withdrawals discard affected session or report copies without invalidating unrelated segments', t => {
  for (const invalidation of [{ type: 'reports_removed', reportIds: ['withdrawn'] },
    { type: 'memory_changed', traceSessions: [context.sessionId] }, { type: 'memory_changed', erasedOutputs: [{ session: context.sessionId, key: 'output' }] }]) {
    const stream = backendStream(t), other = { conversationId: 'other', sessionId: 'other' }
    stream.send({ type: 'report_delivered', context, reportId: 'withdrawn' })
    stream.send({ type: 'report_delivered', context: other, reportId: 'keep' })
    stream.send(invalidation)
    assert.throws(() => stream.snapshot(context.conversationId, context), /gap/)
    assert.equal(stream.snapshot(other.conversationId, other).replay.length, 1)
  }
})

test('an old snapshot and an interleaved late old push cannot retire a live replacement', async t => {
  let required = deferred<RendererSnapshot>()
  const deliveries: unknown[] = []
  const actions = createInitializationActions({ snapshot: () => required.promise, install() {}, deliver: event => deliveries.push(event),
    pause() {}, initialized() {}, loading() {}, failed() {} })
  t.after(actions.close)
  const start = actions.initialize()
  required.resolve(snapshot(4))
  assert.equal(await start, true)
  actions.receive(push(1, 'new owner', 'new'))
  required = deferred<RendererSnapshot>()
  const raced = actions.initialize()
  actions.receive(push(2, 'new owner', 'new'))
  actions.receive(push(5, 'late old'))
  required.resolve(snapshot(5))
  assert.equal(await raced, false)
  required = deferred<RendererSnapshot>()
  const fresh = actions.initialize()
  required.resolve({ ...snapshot(2), streamGeneration: 'new' })
  assert.equal(await fresh, true)
  const next = push(3, 'live', 'new')
  actions.receive(push(6, 'late old')); actions.receive(next)
  assert.deepEqual(deliveries, [next])
})

test('an inactive saved segment still has its cutoff after other segments have been saved', t => {
  const stream = backendStream(t)
  stream.send({ type: 'update', context })
  stream.checkpoint(context.conversationId)
  for (let i = 0; i < 130; i++) stream.checkpoint('other-' + i)
  assert.deepEqual(stream.snapshot(context.conversationId, context).replay, [])
})

test('a stopped conversation with an evicted unsaved tail can recover from its durable checkpoint', t => {
  const stream = backendStream(t)
  for (let i = 0; i < 1025; i++) stream.send({ type: 'update', context, chunk: i })
  stream.send({ type: 'turn_end', context, stopReason: 'cancel_unconfirmed' })
  assert.throws(() => stream.snapshot(context.conversationId, context), /unreplayable gap/)
  const view = stream.snapshot(context.conversationId, context, true)
  assert.deepEqual(view.replay, [])
  assert.equal(view.stoppedReplayLost, true)
  const state = reduce(initialState, { type: 'initialization_snapshot', snapshot: { ...snapshot(), ...view, stopUnconfirmed: true } })
  assert.equal(state.stoppedReplayLost, true)
  assert.equal(state.stopUnconfirmed, true)
})

test('a checkpointed waiting turn remains cancellable after reload and later buffered events win', async t => {
  const activeTurn = { id: 'checkpointed-turn', by: 'user', startedAt: 100, stopping: false }
  const history = { id: context.conversationId, updatedAt: 200, createdAt: 1, parentId: null,
    messages: [{ role: 'user', text: 'ask a question' }], folds: [] }
  let state: State = initialState
  let ended = false
  const pushEnd = { ...push(1), type: 'turn_end' }
  const coordinator = createInitializationActions({
    snapshot: async () => ({ ...snapshot(), activeTurn, history }),
    install: view => { state = reduce(state, { type: 'initialization_snapshot', snapshot: view }) },
    restoreTurn: turn => { state = reduce(state, { type: 'initialization_turn', turn }) },
    deliver: value => {
      if ((value as { type: string }).type === 'turn_end') {
        ended = true
        state = reduce(state, { type: 'turn_end', stopReason: 'cancelled', at: 300 })
      }
    },
    pause() {}, initialized() {}, loading() {}, failed(reason) { assert.fail(reason) },
  })
  t.after(coordinator.close)
  assert.ok(await coordinator.initialize())
  state = reduce(state, { type: 'waits_restored', at: 210, questions: [{
    questionId: 'q', questions: [{ id: 'city', question: 'Which city?', options: [] }],
  }] })
  assert.equal(state.phase, 'asking')
  assert.equal(state.turn?.startedAt, 100)
  let cancelled: unknown
  const actions = createConversationActions({ api: { cancel: async target => { cancelled = target; return true },
    prompt: async () => {}, steer: async () => ({ ok: true }), answerQuestion: async () => true, provideSecrets: async () => true },
    getState: () => state, dispatch: action => { state = reduce(state, action) },
    showToast() {}, errorMessage: String, beforePrompt() {}, keepPicture() {} })
  await actions.cancel()
  assert.deepEqual(cancelled, { ...context, turnId: activeTurn.id })
  const reloaded = coordinator.initialize()
  coordinator.receive(pushEnd)
  assert.ok(await reloaded)
  assert.equal(ended, true)
  assert.equal(state.turn, null)
})
