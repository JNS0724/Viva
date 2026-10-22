import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NO_PLUGIN, createSteerDesk } from '../src/main/steer-channel.ts'
import { createSteerChannel, REASONS } from '../plugins/steer/lib/channel.ts'

/** Both ends of the steer contract, joined as the IPC channel joins them. */
function joined(steer) {
  const listeners = new Set()
  const toPlugin = { send: () => {}, on: (_event, fn) => listeners.add(fn), off: (_event, fn) => listeners.delete(fn) }
  let desk = null
  toPlugin.send = (message) => desk.receive(message)
  createSteerChannel(toPlugin, steer, () => {})
  desk = createSteerDesk({ send: (message) => listeners.forEach((fn) => fn(message)), sessionId: () => 'sess-1' })
  return desk
}

test('words sent while the agent works reach its session; the plugin says why when they cannot', async () => {
  const got = []
  const desk = joined((sessionId, text) => {
    got.push([sessionId, text])
    return text === '晚了' ? REASONS.idle : null
  })
  assert.deepEqual(await desk.steer('改成英文'), { ok: true })
  assert.deepEqual(await desk.steer('晚了'), { ok: false, reason: 'idle' })
  assert.deepEqual(got, [['sess-1', '改成英文'], ['sess-1', '晚了']])
})

test('a plugin that throws answers failed; one that never answers times out as unavailable', async (t) => {
  const throwing = joined(() => { throw new Error('closing') })
  assert.deepEqual(await throwing.steer('x'), { ok: false, reason: REASONS.failed })

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const silent = createSteerDesk({ send: () => {}, sessionId: () => 'sess-1', timeoutMs: 100 })
  const pending = silent.steer('x')
  t.mock.timers.tick(100)
  assert.deepEqual(await pending, { ok: false, reason: NO_PLUGIN })
})

test('no session, or a switched one, answers at once', async () => {
  const none = createSteerDesk({ send: () => assert.fail('nothing is sent without a session'), sessionId: () => null })
  assert.deepEqual(await none.steer('x'), { ok: false, reason: NO_PLUGIN })
  const desk = createSteerDesk({ send: () => {}, sessionId: () => 's' })
  const pending = desk.steer('x')
  desk.closeAll()
  assert.deepEqual(await pending, { ok: false, reason: NO_PLUGIN })
})

test('the plugin answers a malformed request as failed and ignores one without an id', () => {
  const sent = []
  const listeners = []
  createSteerChannel({ send: (m) => sent.push(m), on: (_e, fn) => listeners.push(fn), off: () => {} }, () => null, () => {})
  listeners[0]({ type: 'steer', id: 'a', sessionId: 's', text: '' })
  listeners[0]({ type: 'steer', sessionId: 's', text: 'x' })
  listeners[0]({ type: 'other', id: 'b' })
  assert.deepEqual(sent, [{ type: 'steer_result', id: 'a', ok: false, reason: 'failed' }])
})
