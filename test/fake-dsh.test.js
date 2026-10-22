import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpBridge } from '../src/main/acp-bridge.ts'

/**
 * End-to-end through the real ACP bridge and a real child process: the fake dsh fixture.
 * This is the same path the app takes with the real dsh, minus the model.
 */
const FAKE_DSH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dsh.js')

const kindOf = (event) => event.update?.sessionUpdate ?? event.type
const collapse = (kinds) => kinds.filter((kind, i) => kind !== kinds[i - 1])
const lastToolStatus = (events) => events.filter((e) => kindOf(e) === 'tool_call_update').at(-1).update.status
const texts = (events, kind) => events.filter((e) => kindOf(e) === kind).map((e) => e.update.content.text)

/** Text of the final run of message chunks before the turn ended. */
function trailingMessage(events) {
  const kinds = events.map(kindOf)
  const end = kinds.lastIndexOf('agent_message_chunk') + 1
  const start = kinds.slice(0, end).lastIndexOf('tool_call_update') + 1
  return events.slice(start, end).map((e) => e.update.content.text).join('')
}

/** A bridge on the fake dsh that answers permission requests with `answer` (or never, when null). */
function fakeBridge(answer = 'allow-once') {
  const events = []
  const bridge = createAcpBridge({
    dshBin: FAKE_DSH,
    nodeBin: 'node',
    cwd: os.tmpdir(),
    env: { ...process.env, FAKE_DSH_DELAY_MS: '0', ELECTRON_RUN_AS_NODE: '' },
    emit: (event) => {
      events.push(event)
      if (event.type === 'permission' && answer) setImmediate(() => bridge.respondPermission(event.requestId, answer))
    },
  })
  return { events, bridge }
}

test('fake dsh plays the full script through the real bridge and honours an allow decision', async () => {
  const { events, bridge } = fakeBridge('allow-once')
  const info = await bridge.start()

  await bridge.prompt('整理一下')

  assert.deepEqual([info.mode, info.model, info.effort, info.resumed], ['live', 'Fake Flash', 'high', false])
  assert.match(info.sessionId, /^fake-session-/)
  assert.deepEqual(collapse(events.map(kindOf)), [
    'agent_thought_chunk', 'tool_call', 'tool_call_update', 'tool_call', 'tool_call_update',
    'agent_message_chunk', 'tool_call', 'permission', 'tool_call_update', 'agent_message_chunk', 'turn_end',
  ])
  assert.ok(texts(events, 'agent_message_chunk').length > 10, 'text arrives in many pieces')
  assert.equal(lastToolStatus(events), 'completed')
  assert.equal(trailingMessage(events), '已写入 summary.md（假 dsh，没有真正写入磁盘）。')
  assert.equal(events.at(-1).stopReason, 'end_turn')
  assert.deepEqual(Object.keys(events.find((e) => e.type === 'permission').toolCall), ['toolCallId'], 'like real dsh, the request names only the tool call')
  bridge.dispose()
})

test('fake dsh honours a reject decision', async () => {
  const { events, bridge } = fakeBridge('reject-once')
  await bridge.start()

  await bridge.prompt('整理一下')

  assert.equal(lastToolStatus(events), 'failed')
  assert.equal(trailingMessage(events), '好的，没有写入。')
  bridge.dispose()
})

test('cancelling while the agent waits for permission ends the turn as cancelled', async () => {
  const { events, bridge } = fakeBridge(null)
  await bridge.start()

  const turn = bridge.prompt('整理一下')
  while (!events.some((e) => e.type === 'permission')) await new Promise((resolve) => setTimeout(resolve, 5))
  await bridge.cancel()
  await turn

  assert.deepEqual(events.at(-1), { type: 'turn_end', stopReason: 'cancelled' })
  bridge.dispose()
})

test('fake dsh plays a long task: many tool calls, then a long answer', async () => {
  const { events, bridge } = fakeBridge()
  await bridge.start()

  await bridge.prompt('演示一个长任务')

  assert.equal(events.filter((e) => kindOf(e) === 'tool_call').length, 16)
  assert.ok(texts(events, 'agent_message_chunk').join('').length > 1000)
  assert.equal(events.some((e) => e.type === 'permission'), false)
  bridge.dispose()
})

test('model and reasoning effort switch through session/set_config_option; unknown values are rejected', async () => {
  const { bridge } = fakeBridge()
  const initial = await bridge.start()
  const pro = initial.models.find((m) => m.name === 'Fake Pro')

  const afterModel = await bridge.setConfig('model', pro.value)
  const afterEffort = await bridge.setConfig('reasoning_effort', 'max')

  assert.deepEqual([afterModel.model, afterEffort.effort], ['Fake Pro', 'max'])
  await assert.rejects(bridge.setConfig('model', 'gpt'), /unknown model option/)
  bridge.dispose()
})

test('a later process resumes an earlier session; switching to null opens a fresh one', async () => {
  const first = fakeBridge()
  const { sessionId } = await first.bridge.start()
  first.bridge.dispose()
  const second = fakeBridge()

  const resumed = await second.bridge.start({ resumeSessionId: sessionId })
  const fresh = await second.bridge.switchSession(null)
  const foreign = await second.bridge.switchSession('not-a-fake-session')

  assert.deepEqual([resumed.sessionId, resumed.resumed], [sessionId, true])
  assert.deepEqual([fresh.resumed, fresh.sessionId === sessionId], [false, false])
  assert.equal(foreign.resumed, false)
  second.bridge.dispose()
})
