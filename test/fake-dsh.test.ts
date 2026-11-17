import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createBackend } from '../src/backend/compose.ts'
import type { HostCapabilities } from '../src/backend/host.ts'
import type { AgentInfo } from '../src/shared/agent-info.ts'
import type { IpcRegistry } from '../src/shared/ipc-contract.ts'
import { objectOf } from '../src/shared/unknown-value.ts'
import { scratch } from './fixtures/scratch.js'
import { eventually } from './fixtures/eventually.ts'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { testRequests } from './fixtures/request-routing.ts'

/**
 * End-to-end through the real ACP bridge and a real child process: the fake dsh fixture.
 * This is the same path the app takes with the real dsh, minus the model.
 */
const FAKE_DSH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dsh.ts')

/** What the window got: the stream contract's pieces (text or reasoning as it streams, then each settled), or ACP's. */
type CapturedEvent = Parameters<Parameters<typeof createAcpBridge>[0]['emit']>[0]
const updateOf = (event: CapturedEvent) => objectOf(event.update) ?? {}
const kindOf = (event: CapturedEvent) => {
  const update = updateOf(event)
  if (update?.sessionUpdate !== 'viva_stream') return update?.sessionUpdate ?? event.type
  return update.kind === 'delta' ? update.blockType : update.kind
}
const collapse = (kinds: unknown[]) => kinds.filter((kind, i) => kind !== kinds[i - 1])
const lastToolStatus = (events: CapturedEvent[]) => updateOf(events.filter((e) => kindOf(e) === 'tool_call_update').at(-1)!).status
const texts = (events: CapturedEvent[], kind: string) => events.filter((e) => kindOf(e) === kind).map((e) => String(updateOf(e).text ?? ''))

/** The text of the last answer settled before the turn ended. */
const trailingMessage = (events: CapturedEvent[]) => {
  const blocks = updateOf(events.filter((e) => kindOf(e) === 'settle').at(-1)!).blocks
  assert.ok(Array.isArray(blocks))
  return blocks.map(block => objectOf(block)?.text ?? '').join('')
}

/** A bridge on the fake dsh that answers permission requests with `answer` (or never, when null). */
function fakeBridge(t: TestContext, answer: string | null = 'allow-once') {
  const events: CapturedEvent[] = []
  const bridge = createAcpBridge({ routing: testRequests(),
    dshBin: FAKE_DSH, profile: 'viva',
    nodeBin: 'node',
    cwd: os.tmpdir(),
    env: { ...process.env, FAKE_DSH_DELAY_MS: '0', ELECTRON_RUN_AS_NODE: '' },
    emit: (event) => {
      events.push(event)
      if (event.type === 'permission' && answer) setImmediate(() => bridge.respondPermission(String(event.requestId), answer))
    },
  })
  t.after(() => bridge.dispose())
  return { events, bridge }
}

test('fake dsh plays the full script through the real bridge and honours an allow decision', async t => {
  const { events, bridge } = fakeBridge(t, 'allow-once')
  const info = await bridge.start()

  await bridge.prompt('整理一下')

  assert.deepEqual([info.mode, info.model, info.effort, info.resumed], ['live', 'Fake Flash', 'high', false])
  assert.match(info.sessionId!, /^fake-session-/)
  assert.deepEqual(collapse(events.map(kindOf)), [
    'reasoning', 'settle', 'tool_call', 'tool_call_update', 'tool_call', 'tool_call_update',
    'text', 'settle', 'tool_call', 'permission', 'tool_call_update', 'text', 'settle', 'turn_end',
  ])
  assert.ok(texts(events, 'text').length > 10, 'text arrives in many pieces')
  assert.equal(events.some((e) => kindOf(e) === 'agent_message_chunk'), false, 'never ACP\'s copy of it')
  assert.equal(lastToolStatus(events), 'completed')
  assert.equal(trailingMessage(events), '已写入 summary.md（假 dsh，没有真正写入磁盘）。')
  assert.equal(events.at(-1)!.stopReason, 'end_turn')
  assert.deepEqual(Object.keys(objectOf(events.find((e) => e.type === 'permission')?.toolCall) ?? {}), ['toolCallId'], 'like real dsh, the request names only the tool call')
  bridge.dispose()
})

test('fake dsh honours a reject decision', async t => {
  const { events, bridge } = fakeBridge(t, 'reject-once')
  await bridge.start()

  await bridge.prompt('整理一下')

  assert.equal(lastToolStatus(events), 'failed')
  assert.equal(trailingMessage(events), '好的，没有写入。')
  bridge.dispose()
})

test('cancelling while the agent waits for permission ends the turn as cancelled', async t => {
  const { events, bridge } = fakeBridge(t, null)
  await bridge.start()

  const turn = bridge.prompt('整理一下')
  while (!events.some((e) => e.type === 'permission')) await new Promise((resolve) => setTimeout(resolve, 5))
  await bridge.cancel()
  await turn

  assert.deepEqual(events.at(-1), { type: 'turn_end', stopReason: 'cancelled' })
  bridge.dispose()
})

test('fake dsh plays a long task: many tool calls, then a long answer', async t => {
  const { events, bridge } = fakeBridge(t)
  await bridge.start()

  await bridge.prompt('演示一个长任务')

  assert.equal(events.filter((e) => kindOf(e) === 'tool_call').length, 16)
  assert.ok(texts(events, 'text').join('').length > 1000)
  assert.equal(events.some((e) => e.type === 'permission'), false)
  bridge.dispose()
})

test('model and reasoning effort switch through session/set_config_option; unknown values are rejected', async t => {
  const { bridge } = fakeBridge(t)
  const initial = await bridge.start()
  const pro = initial.models.find((m) => m.name === 'Fake Pro')

  const afterModel = await bridge.setConfig('model', pro!.value)
  const afterEffort = await bridge.setConfig('reasoning_effort', 'max')

  assert.deepEqual([afterModel.model, afterEffort.effort], ['Fake Pro', 'max'])
  await assert.rejects(bridge.setConfig('model', 'gpt'), /unknown model option/)
  bridge.dispose()
})

test('a later process resumes an earlier session; switching to null opens a fresh one', async t => {
  const first = fakeBridge(t)
  const { sessionId } = await first.bridge.start()
  first.bridge.dispose()
  const second = fakeBridge(t)

  const resumed = await second.bridge.start({ resumeSessionId: sessionId })
  const fresh = await second.bridge.switchSession(null)
  const foreign = await second.bridge.switchSession('not-a-fake-session')

  assert.deepEqual([resumed.sessionId, resumed.resumed], [sessionId, true])
  assert.deepEqual([fresh.resumed, fresh.sessionId === sessionId], [false, false])
  assert.equal(foreign.resumed, false)
  second.bridge.dispose()
})


test('the fake stream authenticates its final reply through the production owner and history gate', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'viva-fake-output-proof-')
  const workspace = path.join(dir, 'workspace')
  mkdirSync(workspace)
  const original = { AGENT_CWD: process.env.AGENT_CWD, DSH_BIN: process.env.DSH_BIN, DSH_NODE: process.env.DSH_NODE,
    FAKE_DSH_DELAY_MS: process.env.FAKE_DSH_DELAY_MS, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }
  Object.assign(process.env, { AGENT_CWD: workspace, DSH_BIN: FAKE_DSH, FAKE_DSH_DELAY_MS: '0', DEEPSEEK_API_KEY: '' })
  // The default Electron runtime adds ELECTRON_RUN_AS_NODE; a plain Node override
  // deliberately does not. Never pass the Electron executable as that override.
  if (process.versions.electron) delete process.env.DSH_NODE
  else process.env.DSH_NODE = process.execPath
  const events: CapturedEvent[] = [], handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const register: IpcRegistry['handle'] = (channel, listener) => handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
  function call<T>(channel: string, ...args: unknown[]): T {
    const handler = handlers.get(channel)
    assert.ok(handler, channel)
    return handler({}, ...args) as T
  }
  const noop = () => {}
  const host: HostCapabilities = {
    paths: { userData: dir, documents: dir, home: dir }, packaged: false, automation: true, locale: () => 'zh-CN',
    secrets: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: value => value.toString() },
    dialogs: { chooseFolder: async () => null, chooseFiles: async () => null, saveFile: async () => null },
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop, trash: async () => {} },
    notify: noop, power: { idleSeconds: () => 0 },
    window: { send: event => events.push(event), broadcastLanguage: noop, inFront: () => true, setPending: noop, refreshNative: noop },
    loginItem: { set: noop }, shellSettings: () => ({ shortcut: null, openAtLogin: { available: false } }),
  }
  const backend = createBackend({ host, ipc: { handle: register, on: register }, dailyNotes: false })
  defer(async () => {
    backend.markQuitting()
    try { await backend.stop() } finally {
      backend.close()
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  backend.open()
  await call('models:add', { name: 'Scripted fixture', api: 'anthropic-messages', baseURL: 'http://127.0.0.1:1',
    models: [{ id: 'fake-flash' }], key: 'test-scripted-key' })
  assert.ok(await eventually(() => call<AgentInfo>('agent:info').sessionId))
  const sourceId = randomUUID(), question = '格式演示'
  await call<Promise<void>>('agent:prompt', question, [], sourceId)
  const reply = events.filter(event => event.type === 'update' && kindOf(event) === 'settle')
    .findLast(event => {
      const blocks = updateOf(event).blocks
      return Array.isArray(blocks) && blocks.some(block => objectOf(block)?.type === 'text' && String(objectOf(block)?.text).includes('本周进展'))
    })
  assert.ok(reply, 'the production recordOutputs gate accepts the actual owner-archived scripted reply')
  // This driver does not commit routing decisions; its existing unrouted notice is
  // independent of the owner-authenticated assistant stream checked here.
  const blocks = updateOf(reply).blocks
  assert.ok(Array.isArray(blocks))
  const text = blocks.filter(block => objectOf(block)?.type === 'text').map(block => objectOf(block)?.text).join('')
  const key = updateOf(reply).key
  assert.equal(typeof key, 'string')
  await call('history:save', [{ role: 'user', text: question, sourceId, receipt: null },
    { role: 'assistant', text, key, receipt: null },
    { role: 'assistant', text: 'An unpublished scripted reply', key: 'unknown-scripted-reply', receipt: null }])
  const history = JSON.stringify(call('history:load'))
  assert.ok(history.includes('本周进展'), 'the authenticated reply survives history persistence')
  assert.ok(!history.includes('An unpublished scripted reply'), 'unknown reply identities still fail the unchanged production history gate')
  const db = new DatabaseSync(path.join(dir, 'memory', 'memory.db'), { readOnly: true })
  try {
    const rows = db.prepare("SELECT a.identity,a.result,r.evidence FROM owner_native_output_attempts a JOIN owner_native_output_reads r ON r.attempt=a.id").all()
    assert.ok(rows.length)
    assert.ok(rows.some(row => JSON.parse(String(row.evidence)).sources.includes(sourceId)), 'the output proof includes the actual admitted human source')
    assert.ok(rows.every(row => !JSON.stringify(row).includes(text)), 'native output receipts retain identities and ranges without reply bodies')
  } finally { db.close() }
})
