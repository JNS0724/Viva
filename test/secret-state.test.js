import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { islandView } from '../src/renderer/island-view.js'
import { traceItems } from '../src/renderer/selectors.js'

const T0 = 1_000
const run = (actions) => actions.reduce(reduce, initialState)
const asked = [
  { type: 'ready', info: { mode: 'live', model: 'm', cwd: '/w' } },
  { type: 'user_prompt', text: '帮我接入 GitHub', at: T0 },
  { type: 'secret_request', requestId: 'c1', server: 'github', names: ['GITHUB_TOKEN'], at: T0 + 10 },
]

test('a key request waits on the user, and the island says so', () => {
  const waiting = run(asked)
  assert.equal(waiting.phase, 'asking')
  assert.deepEqual(waiting.secret, { requestId: 'c1', server: 'github', names: ['GITHUB_TOKEN'] })
  const view = islandView(waiting)
  assert.deepEqual([view.form, view.label, view.question.text, view.question.options], ['asking', '需要你填写', '接入「github」需要你填写密钥', []])
})

test('filling in or declining goes back to work; the trace keeps that it happened, never the key', () => {
  const filled = reduce(run(asked), { type: 'secret_resolved', requestId: 'c1', provided: true, at: T0 + 20 })
  assert.deepEqual([filled.phase, filled.secret], ['working', null])
  assert.deepEqual(traceItems(filled).slice(-2).map((row) => [row.title, row.detail]), [['请你填写密钥', 'github：GITHUB_TOKEN'], ['你填写了密钥', 'github']])
  const declined = reduce(run(asked), { type: 'secret_resolved', requestId: 'c1', provided: false, at: T0 + 20 })
  assert.equal(traceItems(declined).at(-1).title, '没有填写密钥')
  assert.equal(reduce(run(asked), { type: 'secret_resolved', requestId: 'old', provided: true, at: 1 }).secret.requestId, 'c1', 'a stale answer changes nothing')
})

test('a stopped turn or a closed request takes the card away', () => {
  assert.equal(reduce(run(asked), { type: 'secret_closed', requestId: 'c1' }).secret, null)
  assert.equal(reduce(run(asked), { type: 'turn_end', stopReason: 'cancelled', at: T0 + 30 }).secret, null)
  assert.equal(reduce(run(asked), { type: 'error', message: 'x' }).secret, null)
})
