import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, settle } from './fixtures/conversation-actions.ts'
import { historyMessages } from '../src/renderer/selectors.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('a negative native admission receipt keeps text and images visibly unsent after a report clears errors', async () => {
  for (const images of [[], [{ id: 'picture' }]]) {
    const receipt = deferred<Awaited<ReturnType<AgentApi['prompt']>>>()
    const h = harness({ prompt: () => receipt.promise })
    h.actions.ask('keep these independent words', { images })
    receipt.resolve({ accepted: false, message: 'The queued request was cancelled before dispatch.', sourceIds: [h.state().messages[0]!.sourceId!] })
    await settle()
    assert.equal(h.state().messages[0]?.failed, true)
    assert.deepEqual(h.state().messages[0]?.images ?? [], images)
    h.dispatch({ type: 'agent_turn_started', by: 'task', at: 200 })
    h.dispatch({ type: 'turn_end', stopReason: 'end_turn', at: 201 })
    assert.equal(h.state().messages[0]?.text, 'keep these independent words')
    assert.equal(h.state().messages[0]?.failed, true, 'later report events cannot make an unsent bubble appear delivered')
  }
})

test('a queued admission rejection marks only its exact source after selection changes', async () => {
  const receipt = deferred<Awaited<ReturnType<AgentApi['prompt']>>>()
  const h = harness({ prompt: () => receipt.promise })
  h.actions.ask('original selection')
  h.change({ info: { ...h.state().info, sessionId: 'replacement' } })
  receipt.resolve({ accepted: false, message: 'The original selection retired.', sourceIds: [h.state().messages[0]!.sourceId!] })
  await settle()
  assert.equal(h.state().messages[0]?.failed, true)
  assert.equal(h.state().error, null, 'an old failure must not change the replacement conversation phase')
  const steerReceipt = deferred<Awaited<ReturnType<AgentApi['steer']>>>()
  const steered = harness({ steer: () => steerReceipt.promise })
  steered.change({ phase: 'working' }); steered.actions.ask('retained queued steer')
  steered.change({ info: { ...steered.state().info, sessionId: 'replacement' } })
  steerReceipt.resolve({ ok: false, reason: 'unavailable', delivery: 'not-sent' })
  await settle()
  assert.equal(steered.state().messages[0]?.failed, true)
  assert.deepEqual(steered.toasts, [])
})

test('trusted cold history delivery metadata remains visible through report turns', () => {
  const h = harness()
  h.dispatch({ type: 'history_loaded', conversationId: 'saved', messages: [
    { role: 'user', text: 'known not sent', sourceId: 'unsent', receipt: null, delivery: 'not-sent' },
    { role: 'user', text: 'unknown crash window', sourceId: 'unknown', receipt: null, delivery: 'pending' },
  ] })
  assert.equal(h.state().messages[0]?.failed, true)
  assert.equal(h.state().messages[1]?.delivery, 'pending')
  h.dispatch({ type: 'agent_turn_started', by: 'task', at: 200 })
  h.dispatch({ type: 'turn_end', stopReason: 'end_turn', at: 201 })
  assert.equal(h.state().messages[0]?.delivery, 'not-sent')
  assert.equal(h.state().messages[1]?.delivery, 'pending')
})

test('a rejected replay cannot mark an already delivered source not-sent', async () => {
  const receipt = deferred<Awaited<ReturnType<AgentApi['prompt']>>>()
  const h = harness({ prompt: () => receipt.promise })
  h.actions.ask('previously delivered original')
  receipt.resolve({ accepted: false, message: 'This retry was refused.', sourceIds: [] })
  await settle()
  assert.notEqual(h.state().messages[0]?.failed, true)
})

test('an Updates draft awaits backend admission before clearing or entering saved history', async () => {
  const pending = deferred<void>()
  const sent: string[] = []
  const accepted: boolean[] = []
  const h = harness({ prompt: (_words, _images, _operation, resultId) => { sent.push(resultId!); return pending.promise } })
  assert.equal(h.actions.ask('旧结果', { feedItemId: 'feed-1', admitted: ok => accepted.push(ok) }), true)
  assert.deepEqual(historyMessages(h.state()), [])
  pending.reject(new Error('已失效'))
  await settle()
  assert.deepEqual([sent, accepted, h.state().messages], [['feed-1'], [false], []])
  assert.match(h.state().error ?? '', /已失效/)
})

test('an Updates send settles its pending message when the kept conversation reopens in a fresh DSH session', async () => {
  for (const accepted of [true, false]) {
    const receipt = deferred<void>()
    const notifications: boolean[] = []
    const h = harness({ prompt: () => receipt.promise })
    const info = { ...h.state().info, conversationId: 'topic', sessionId: 'old' }
    h.dispatch({ type: 'ready', info })
    assert.equal(h.actions.ask('定时结果', { feedItemId: 'feed-1', admitted: ok => notifications.push(ok) }), true)
    h.dispatch({ type: 'ready', info: { ...info, sessionId: 'fresh' } })
    assert.deepEqual(historyMessages(h.state()), [])
    if (accepted) receipt.resolve(undefined)
    else receipt.reject(new Error('结果已失效'))
    await settle()
    assert.deepEqual(notifications, [accepted])
    assert.equal(h.state().messages.length, accepted ? 1 : 0)
    assert.deepEqual(historyMessages(h.state()).map(message => message.text), accepted ? ['定时结果'] : [])
    assert.equal(h.state().phase, accepted ? 'working' : 'error')
  }
})

test('a retired feed identity clears pending text and a late successful admission cannot restore it', async () => {
  const receipt = deferred<void>(), admitted: boolean[] = []
  const h = harness({ prompt: () => receipt.promise })
  h.actions.ask('derived old result', { feedItemId: 'feed-1', images: [{ id: 'independent-image' }], admitted: ok => admitted.push(ok) })
  h.dispatch({ type: 'feed_erased', ids: ['feed-1'] })
  assert.equal(h.state().messages[0]?.text, '')
  assert.deepEqual(h.state().messages[0]?.images, [{ id: 'independent-image' }])
  receipt.resolve(undefined)
  await settle()
  assert.deepEqual(admitted, [false])
  assert.deepEqual(h.state().messages, [])
  assert.equal(h.actions.ask('late island draft', { feedItemId: 'feed-1' }), false)
})

test('directory, rewind and settings transitions refuse new questions and interjections without adding unsent words', () => {
  for (const type of ['workdir_switching', 'rewind_busy', 'settings_busy'] as const) {
    for (const phase of ['idle', 'working'] as const) {
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

test('host-proven first deliveries keep their original aliases and register before later input alongside canonical replay', async () => {
  const calls: Array<{ text: string, operation?: string | string[] }> = []
  const first = deferred<void>()
  const h = harness({
    prompt: (text, _pictures, operation) => { calls.push({ text, operation }); return first.promise },
    steer: async text => ({ ok: false, reason: 'idle', ...(text === 'accepted original' ? { delivery: 'sent' as const } : { delivery: 'not-sent' as const }) }),
  })
  h.change({ phase: 'working' })
  h.actions.ask('first original', { sourceId: 'first', newSource: true })
  h.actions.ask('accepted original', { sourceId: 'canonical', newSource: true })
  h.actions.ask('second original', { sourceId: 'second', newSource: true })
  await settle()
  h.change({ phase: 'idle' }); h.actions.sendAfterTurn()
  assert.deepEqual(calls, [
    { text: 'first original', operation: 'first' },
    { text: 'accepted original', operation: ['canonical'] },
    { text: 'second original', operation: 'second' },
  ], 'no native completion is awaited before registering the next shown input')
  assert.equal(h.state().messages[0]?.delivery, 'pending')
  first.resolve(); await settle()
  assert.equal(h.state().messages[0]?.delivery, undefined)
  assert.equal(h.state().messages[2]?.delivery, undefined)
  assert.equal(h.state().messages.length, 3)
})

test('a definite pre-send steer failure retains its original domain message', async () => {
  const message = 'The original source alias was rejected.'
  const h = harness({ steer: async () => ({ ok: false, reason: 'unavailable', delivery: 'not-sent', message }) })
  h.change({ phase: 'working' }); h.actions.ask('keep the rejected words')
  await settle(); h.actions.sendAfterTurn()
  assert.deepEqual(h.prompts, [])
  assert.equal(h.state().messages.at(-1)?.delivery, 'not-sent')
  assert.equal(h.state().messages.at(-1)?.failed, true)
  assert.ok(h.toasts[0]?.includes(message))
})

test('an unconfirmed steer keeps its words with unknown delivery and is never retried as a prompt', async () => {
  const h = harness({ steer: async () => { throw new Error('offline') } })
  h.change({ phase: 'working' }); h.actions.ask('keep my words')
  await settle(); h.actions.sendAfterTurn()
  assert.deepEqual(h.prompts, [])
  assert.notEqual(h.state().messages.at(-1)?.failed, true)
  assert.equal(h.state().messages.at(-1)?.delivery, 'pending')
  assert.match(h.toasts[0], /确认|confirmed/)
  h.dispatch({ type: 'agent_turn_started', by: 'task', at: 200 })
  h.dispatch({ type: 'turn_end', stopReason: 'end_turn', at: 201 })
  assert.equal(h.state().messages[0]?.delivery, 'pending')
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
  h.dispatch({ type: 'question_request', at: 1, questionId: 'q', questions: [{ id: 'city', question: 'City?', options: [] }] })
  h.actions.answer([{ id: 'city', selected: [], custom: 'Shanghai' }])
  await settle(); assert.deepEqual(replies, ['q']); assert.equal(h.toasts.length, 1)
  assert.equal(h.state().messages.some(message => message.text === 'Shanghai'), false)
  h.dispatch({ type: 'secret_request', at: 1, requestId: 'keys', server: 'mail', names: ['TOKEN'] })
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

test('stop feedback appears before IPC and a late denial cannot reset a newer turn', async () => {
  const reply = deferred<boolean>()
  const captured: Array<Parameters<AgentApi['cancel']>[0]> = []
  const h = harness({ cancel: target => { captured.push(target); return reply.promise } })
  h.change({ conversationId: 'topic', info: { ...h.state().info, sessionId: 'active' } })
  h.dispatch({ type: 'agent_turn_started', at: 200, turnId: 'first' })
  const stopping = h.actions.cancel()
  assert.equal(h.state().phase, 'stopping')
  assert.deepEqual(captured, [{ conversationId: 'topic', sessionId: 'active', turnId: 'first' }])
  assert.equal(h.actions.ask('preserve this unsent draft'), false)
  h.dispatch({ type: 'agent_turn_started', at: 201, turnId: 'second' })
  reply.resolve(false)
  await stopping
  assert.equal(h.state().phase, 'working')
  assert.equal(h.state().turn?.id, 'second')
})

test('unconfirmed stop prevents sending until the user recovers the runtime', async () => {
  const recovery = deferred<AgentInfo | null>()
  const h = harness({ recover: () => recovery.promise })
  h.change({ conversationId: 'topic', info: { ...h.state().info, sessionId: 'old' } })
  h.dispatch({ type: 'agent_turn_started', at: 200, turnId: 'stuck' })
  h.dispatch({ type: 'turn_stopping' })
  h.dispatch({ type: 'turn_end', at: 8_200, stopReason: 'cancel_unconfirmed' })
  assert.equal(h.state().phase, 'idle')
  assert.equal(h.actions.ask('keep this draft editable'), false)
  const recovering = h.actions.recover()
  h.change({ info: { ...h.state().info, sessionId: 'replacement' } })
  recovery.resolve(h.state().info)
  await recovering
  assert.equal(h.actions.ask('send the recovered draft'), true)
})

test('a prompt rejected before backend persistence retracts its bubble and restores draft; persisted prompts stay on later errors', async () => {
  // 1. Pre-persist rejection (no prompt_persisted event) for both text and image prompts: retract bubble & restore draft
  for (const images of [[], [{ id: 'pic-1' }]]) {
    let restored = 0
    const h = harness({ prompt: () => Promise.reject(new Error('memory busy')) })
    assert.equal(h.actions.ask('unsent question', { images, onRejected: () => { restored += 1 } }), true)
    assert.equal(h.state().messages.length, 1)
    await settle()
    assert.equal(h.state().messages.length, 0, 'unpersisted rejected prompt is retracted so indices stay aligned with SQLite')
    assert.equal(restored, 1, 'onRejected restores the user draft')
    assert.match(h.state().error ?? '', /memory busy/)
  }

  // 2. Post-persist rejection (prompt_persisted arrived before rejection): keep message & do not restore draft
  let restoredAfterPersist = 0
  const pending = deferred<void>()
  const h = harness({ prompt: () => pending.promise })
  assert.equal(h.actions.ask('already persisted', { onRejected: () => { restoredAfterPersist += 1 } }), true)
  const sourceId = h.state().messages[0]!.sourceId!
  h.dispatch({ type: 'prompt_persisted', sourceId })
  pending.reject(new Error('mid-turn disconnect'))
  await settle()
  assert.equal(h.state().messages.length, 1, 'persisted prompt stays visible on later turn error')
  assert.equal(h.state().messages[0]?.text, 'already persisted')
  assert.equal(restoredAfterPersist, 0)
  assert.match(h.state().error ?? '', /mid-turn disconnect/)
})
