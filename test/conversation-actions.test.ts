import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConversationActions } from '../src/renderer/conversation-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { MAX_MESSAGE_CHARS } from '../src/shared/text-limits.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

function harness(overrides: Partial<Parameters<typeof createConversationActions>[0]['api']> = {}) {
  let state: State = { ...initialState, info: { mode: 'live', model: '', cwd: '/work' } }
  const prompts: Array<{ text: string, images?: Array<{ id: string }> }> = []
  const steers: string[] = [], toasts: string[] = [], pictures: string[] = []
  let resets = 0
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const actions = createConversationActions({
    api: {
      prompt: async (text, images) => { prompts.push({ text, images }) },
      steer: async text => { steers.push(text); return { ok: true } },
      answerQuestion: async () => true, provideSecrets: async () => true,
      ...overrides,
    },
    getState: () => state, dispatch, errorMessage: String, showToast: text => { toasts.push(text) },
    beforePrompt: () => { resets++ }, keepPicture: id => { pictures.push(id) }, now: () => 123,
  })
  return { actions, prompts, steers, toasts, pictures, dispatch, state: () => state, resets: () => resets,
    change: (change: Partial<State>) => { state = { ...state, ...change } } }
}

test('normal and image questions keep their visible message and send once', async () => {
  const h = harness()
  assert.equal(h.actions.ask('hello', { via: 'island', images: [{ id: 'pic' }] }), true)
  await settle()
  assert.deepEqual(h.prompts, [{ text: 'hello', images: [{ id: 'pic' }] }])
  assert.deepEqual(h.pictures, ['pic'])
  assert.equal(h.resets(), 1)
  assert.equal(h.state().messages.at(-1)?.text, 'hello')
  assert.equal(h.state().messages.at(-1)?.via, 'island')
})

test('setup, topic switches, empty and oversized questions do not reach the agent', () => {
  const h = harness()
  assert.equal(h.actions.ask(''), false)
  assert.equal(h.actions.ask('x'.repeat(MAX_MESSAGE_CHARS + 1)), false)
  h.change({ switching: true }); assert.equal(h.actions.ask('switching'), false)
  h.change({ switching: false, newTopicPending: true }); assert.equal(h.actions.ask('new'), false)
  h.change({ newTopicPending: false, info: { mode: 'setup', reason: 'no-key', model: '', cwd: '' } })
  assert.equal(h.actions.ask('setup'), false)
  assert.deepEqual(h.prompts, [])
})

test('directory, rewind and settings transitions refuse new questions and interjections without adding unsent words', () => {
  for (const type of ['workdir_switching', 'rewind_busy', 'settings_busy']) {
    for (const phase of ['idle', 'working']) {
      const h = harness(); h.change({ phase }); h.dispatch({ type })
      assert.equal(h.actions.ask('wait for selection', { via: 'island' }), false, `${type}/${phase}`)
      assert.equal(h.actions.ask('picture', { images: [{ id: 'p' }] }), false)
      assert.deepEqual(h.prompts, []); assert.deepEqual(h.steers, [])
      assert.deepEqual(h.state().messages, [])
    }
  }
})

test('busy questions steer; images stay unsent until the turn has ended', async () => {
  const h = harness(); h.change({ phase: 'working' })
  assert.equal(h.actions.ask('also this'), true)
  assert.equal(h.actions.ask('picture', { images: [{ id: 'p' }] }), false)
  await settle()
  assert.deepEqual(h.steers, ['also this']); assert.deepEqual(h.prompts, [])
  assert.deepEqual(h.pictures, [])
  assert.equal(h.toasts.length, 1)
})

test('a turn-end race batches rejected steers into exactly one following question', async () => {
  const h = harness({ steer: async () => ({ ok: false, reason: 'idle' }) })
  h.change({ phase: 'working' }); h.actions.ask('first'); h.actions.ask('second')
  await settle()
  assert.deepEqual(h.prompts, [], 'wait for the visible turn to finish')
  h.change({ phase: 'idle' }); h.actions.sendAfterTurn(); h.actions.sendAfterTurn()
  await settle()
  assert.deepEqual(h.prompts, [{ text: 'first\n\nsecond', images: undefined }])
  assert.equal(h.state().messages.filter(m => m.role === 'user').length, 2, 'resend must not duplicate visible words')
})

test('a steer refused after the visible turn ends is sent immediately as the next question', async () => {
  const receipt = deferred<{ ok: boolean, reason?: string }>()
  const h = harness({ steer: () => receipt.promise })
  h.change({ phase: 'working' }); h.actions.ask('late words')
  h.change({ phase: 'idle' }); receipt.resolve({ ok: false, reason: 'idle' })
  await settle(); h.actions.sendAfterTurn()
  assert.deepEqual(h.prompts.map(p => p.text), ['late words'])
})

test('a failed steer stays marked unsent and is never retried as a prompt', async () => {
  const h = harness({ steer: async () => { throw new Error('offline') } })
  h.change({ phase: 'working' }); h.actions.ask('keep my words')
  await settle(); h.actions.sendAfterTurn()
  assert.deepEqual(h.prompts, [])
  assert.equal(h.state().messages.at(-1)?.failed, true)
  assert.match(h.toasts[0], /offline/)
})

test('an error clears queued turn-end words instead of resending them into a later turn', async () => {
  const h = harness({ steer: async () => ({ ok: false, reason: 'idle' }) })
  h.change({ phase: 'working' }); h.actions.ask('queued'); await settle()
  h.actions.clearAfterTurn(); h.change({ phase: 'idle' }); h.actions.sendAfterTurn()
  assert.deepEqual(h.prompts, [])
  assert.equal(h.state().messages.at(-1)?.failed, true)
})

test('a cancelled turn does not resend queued words to a retiring instance or a later turn', async () => {
  const h = harness({ steer: async () => ({ ok: false, reason: 'idle' }) })
  h.change({ phase: 'working' }); h.actions.ask('queued'); await settle()
  h.change({ phase: 'idle' }); h.actions.sendAfterTurn('cancelled'); h.actions.sendAfterTurn()
  await settle()
  assert.deepEqual(h.prompts, [])
  assert.equal(h.state().messages.at(-1)?.text, 'queued', 'retain the words on screen')
  assert.equal(h.state().messages.at(-1)?.failed, true, 'known-undelivered words must not appear delivered')
})

test('a late idle steer receipt cannot resend after cancellation or an error', async () => {
  for (const reason of ['cancelled', 'error']) {
    const receipt = deferred<{ ok: boolean, reason?: string }>()
    const h = harness({ steer: () => receipt.promise })
    h.change({ phase: 'working' }); h.actions.ask('pending')
    h.change({ phase: 'idle' })
    if (reason === 'cancelled') h.actions.sendAfterTurn('cancelled')
    else h.actions.clearAfterTurn()
    receipt.resolve({ ok: false, reason: 'idle' })
    await settle(); h.actions.sendAfterTurn()
    assert.deepEqual(h.prompts, [])
    assert.equal(h.state().messages.at(-1)?.failed, true)
  }
})

test('question and credential replies use their request ids and never save credential values in state', async () => {
  const replies: string[] = []
  const h = harness({
    answerQuestion: async id => { replies.push(id); return false },
    provideSecrets: async (id, values) => { replies.push(id); assert.deepEqual(values, { TOKEN: 'test-only' }); return true },
  })
  h.dispatch({ type: 'question_request', questionId: 'q', questions: [{ id: 'city', question: 'City?', options: [] }] })
  h.actions.answer([{ id: 'city', selected: [], custom: 'Shanghai' }])
  await settle(); assert.deepEqual(replies, ['q']); assert.equal(h.toasts.length, 1)
  h.dispatch({ type: 'secret_request', requestId: 'keys', server: 'mail', names: ['TOKEN'] })
  await h.actions.provideSecrets({ TOKEN: 'test-only' })
  assert.deepEqual(replies, ['q', 'keys']); assert.equal(h.state().secret, null)
  assert.equal(JSON.stringify(h.state()).includes('test-only'), false)
})

test('an old prompt RPC cannot fail a new selected topic or an in-progress new-topic preparation', async () => {
  for (const committed of [false, true]) {
    const receipt = deferred<void>(), h = harness({ prompt: () => receipt.promise })
    h.change({ conversationId: 'c-old', info: { mode: 'live', model: '', cwd: '/w', sessionId: 's-old', conversationId: 'c-old' } })
    h.actions.ask('old question')
    if (committed) h.change({ conversationId: 'c-new', info: { mode: 'live', model: '', cwd: '/w', sessionId: 's-new', conversationId: 'c-new' }, phase: 'working', error: null })
    else h.change({ newTopicPending: true, phase: 'idle', error: null })
    receipt.reject(new Error('late old failure')); await settle()
    assert.equal(h.state().error, null)
    assert.equal(h.state().phase, committed ? 'working' : 'idle')
  }
})

test('cancellation and a newer prompt invalidate an older RPC even when the session is resumed unchanged', async () => {
  const receipt = deferred<void>(); let asked = 0
  const h = harness({ prompt: () => ++asked === 1 ? receipt.promise : Promise.resolve() })
  h.actions.ask('old question'); h.actions.sendAfterTurn('cancelled'); h.change({ phase: 'idle' })
  h.actions.ask('new question')
  receipt.reject(new Error('old process closed')); await settle()
  assert.equal(h.state().error, null); assert.equal(h.state().phase, 'working')
})

test('an old steer receipt cannot resend words or mark a reused message id in the new topic', async () => {
  const receipt = deferred<{ ok: boolean, reason?: string }>(), h = harness({ steer: () => receipt.promise })
  h.change({ conversationId: 'c-old', info: { mode: 'live', model: '', cwd: '/w', sessionId: 's-old', conversationId: 'c-old' }, phase: 'working' })
  h.actions.ask('old interjection')
  const id = h.state().messages.at(-1)!.id
  h.change({ conversationId: 'c-new', info: { mode: 'live', model: '', cwd: '/w', sessionId: 's-new', conversationId: 'c-new' }, messages: [{ id, role: 'user', text: 'new question' }] })
  receipt.resolve({ ok: false, reason: 'idle' }); await settle()
  assert.deepEqual(h.prompts, [])
  assert.equal(h.state().messages[0]?.failed, undefined)
  assert.deepEqual(h.toasts, [])
})
