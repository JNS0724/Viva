import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { createAcpBridge, MCP_RETRY_MS } from '../src/main/acp-bridge.ts'
import pkg from '../package.json' with { type: 'json' }

const APP_VERSION = pkg.version
/** What the app told the fake dsh it is, at the last initialize. */
let lastClientInfo = null

const SESSION = 'session-1'
const OLDER_SESSION = 'session-0'
const modelOptions = (currentValue) => [{
  id: 'model', name: 'Model', type: 'select', currentValue,
  options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [
    { value: 'v4-flash', name: 'DeepSeek V4 Flash' },
    { value: 'v4-pro', name: 'DeepSeek V4 Pro' },
  ] }],
}]
const MODEL_OPTIONS = modelOptions('v4-flash')

test('a failing MCP configuration cools down across sessions, retries after expiry, and changed settings retry immediately', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  let servers = [{ name: 'broken', command: 'missing', args: [], env: [] }]
  let attempts = 0
  const bridge = createAcpBridge({ dshBin: '/fake/dsh', cwd: '/work', mcpServers: () => servers, emit: () => {},
    spawnFn: () => fakeDsh(conn => ({ ...scriptedAgent([])(conn),
      async newSession(params) {
        if (params.mcpServers.length) { attempts++; throw Error('mcp-client(broken): initial connection failed') }
        return { sessionId: SESSION, configOptions: MODEL_OPTIONS }
      },
    })),
  })
  await bridge.start(); assert.equal(attempts, 1)
  await bridge.newSession(); assert.equal(attempts, 1)
  t.mock.timers.tick(MCP_RETRY_MS)
  await bridge.newSession(); assert.equal(attempts, 2)
  servers = [{ ...servers[0], command: 'changed' }]
  await bridge.newSession(); assert.equal(attempts, 3)
  bridge.dispose()
})

/** A fake `dsh --profile acp` child process whose stdio is served by a real ACP agent connection. */
function fakeDsh(agentFactory) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  const stream = ndJsonStream(Writable.toWeb(child.stdout), Readable.toWeb(child.stdin))
  new AgentSideConnection((conn) => agentFactory(conn), stream)
  return child
}

function scriptedAgent(log, { resumable = true } = {}) {
  return (conn) => ({
    async initialize(params) {
      log.push(['initialize', params.protocolVersion, params.clientInfo?.name])
      lastClientInfo = params.clientInfo
      const agentCapabilities = resumable ? { sessionCapabilities: { resume: {} } } : {}
      return { protocolVersion: params.protocolVersion, agentCapabilities, authMethods: [] }
    },
    async resumeSession(params) {
      log.push(['resumeSession', params.sessionId, params.cwd])
      if (![SESSION, OLDER_SESSION].includes(params.sessionId)) throw new Error(`session is not resumable: ${params.sessionId}`)
      return { configOptions: MODEL_OPTIONS }
    },
    async authenticate() {
      return {}
    },
    async newSession(params) {
      log.push(['newSession', params.cwd])
      return { sessionId: SESSION, configOptions: MODEL_OPTIONS }
    },
    async prompt(params) {
      log.push(['prompt', params.prompt[0].text])
      await conn.sessionUpdate({ sessionId: SESSION, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想' } } })
      await conn.sessionUpdate({ sessionId: 'other-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignored' } } })
      const decision = await conn.requestPermission({
        sessionId: SESSION,
        toolCall: { toolCallId: 't1', title: '写入 notes.md', kind: 'edit' },
        options: [{ optionId: 'yes', name: '允许', kind: 'allow_once' }],
      })
      log.push(['decision', decision.outcome])
      await conn.sessionUpdate({ sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好了' } } })
      return { stopReason: 'end_turn' }
    },
    async cancel(params) {
      log.push(['cancel', params.sessionId])
    },
    async closeSession(params) {
      log.push(['closeSession', params.sessionId])
      return {}
    },
    async setSessionConfigOption(params) {
      log.push(['setConfig', params.configId, params.value])
      if (params.value !== 'v4-pro') throw new Error(`unknown model option: ${params.value}`)
      const configOptions = modelOptions(params.value)
      await conn.sessionUpdate({ sessionId: SESSION, update: { sessionUpdate: 'config_option_update', configOptions } })
      return { configOptions }
    },
  })
}

test('acp bridge initializes, opens a session, relays updates and answers permission requests', async () => {
  // Arrange
  const log = []
  const events = []
  let child = null
  const bridge = createAcpBridge({
    dshBin: '/fake/dsh',
    cwd: '/work',
    env: {},
    spawnFn: (bin, args, options) => {
      log.push(['spawn', bin, args.join(' '), options.cwd])
      child = fakeDsh(scriptedAgent(log))
      return child
    },
    emit: (event) => {
      events.push(event)
      if (event.type === 'permission') setImmediate(() => bridge.respondPermission(event.requestId, 'yes'))
    },
  })

  // Act
  const info = await bridge.start()
  await bridge.prompt('写个笔记')
  await bridge.cancel()

  // Assert
  assert.deepEqual([info.mode, info.model, info.modelValue, info.cwd], ['live', 'DeepSeek V4 Flash', 'v4-flash', '/work'])
  assert.deepEqual(info.models.map((m) => [m.name, m.group]), [['DeepSeek V4 Flash', 'DeepSeek'], ['DeepSeek V4 Pro', 'DeepSeek']])
  assert.deepEqual(log, [
    ['spawn', '/fake/dsh', '--profile viva', '/work'],
    ['initialize', 1, 'viva'],
    ['newSession', '/work'],
    ['prompt', '写个笔记'],
    ['decision', { outcome: 'selected', optionId: 'yes' }],
    ['cancel', SESSION],
  ])
  assert.equal(lastClientInfo?.version, APP_VERSION, 'dsh is told the version the app was built as')
  assert.deepEqual(events.map((e) => e.update?.sessionUpdate ?? e.type), ['agent_thought_chunk', 'permission', 'agent_message_chunk', 'turn_end'])
  assert.equal(events[1].toolCall.title, '写入 notes.md')
  assert.equal(events.at(-1).stopReason, 'end_turn')

  bridge.dispose()
  assert.equal(child.stdin.writableEnded, true)
})

test('acp bridge reports an unexpected dsh exit with its stderr tail', async () => {
  const events = []
  let child = null
  const bridge = createAcpBridge({
    dshBin: '/fake/dsh',
    cwd: '/work',
    spawnFn: () => {
      child = fakeDsh(scriptedAgent([]))
      return child
    },
    emit: (event) => events.push(event),
  })
  await bridge.start()

  child.stderr.write('Error: DEEPSEEK_API_KEY rejected\n')
  await new Promise((resolve) => setImmediate(resolve))
  child.emit('exit', 1, null)

  assert.equal(events.at(-1).type, 'error')
  assert.match(events.at(-1).message, /dsh 已退出（1）.*DEEPSEEK_API_KEY rejected/)
})

test('acp bridge switches the model via session/set_config_option and relays config updates', async () => {
  // Arrange
  const log = []
  const events = []
  const bridge = createAcpBridge({
    dshBin: '/fake/dsh',
    cwd: '/work',
    spawnFn: () => fakeDsh(scriptedAgent(log)),
    emit: (event) => events.push(event),
  })
  await bridge.start()

  // Act
  const info = await bridge.setConfig('model', 'v4-pro')

  // Assert
  assert.deepEqual([info.model, info.modelValue], ['DeepSeek V4 Pro', 'v4-pro'])
  assert.deepEqual(log.at(-1), ['setConfig', 'model', 'v4-pro'])
  assert.equal(events.at(-1).type, 'config')
  assert.equal(events.at(-1).info.model, 'DeepSeek V4 Pro')
  await assert.rejects(bridge.setConfig('model', 'nope'), /unknown model option/)
  bridge.dispose()
})

function bridgeWith(agent) {
  const log = []
  const bridge = createAcpBridge({
    dshBin: '/fake/dsh',
    cwd: '/work',
    spawnFn: () => fakeDsh(agent(log)),
    emit: () => {},
  })
  return { log, bridge }
}

test('acp bridge resumes the saved session so dsh keeps the earlier context', async () => {
  const { log, bridge } = bridgeWith((l) => scriptedAgent(l))

  const info = await bridge.start({ resumeSessionId: SESSION })

  assert.deepEqual([info.sessionId, info.resumed, info.model], [SESSION, true, 'DeepSeek V4 Flash'])
  assert.deepEqual(log.slice(1), [['resumeSession', SESSION, '/work']])
  bridge.dispose()
})

test('acp bridge falls back to a new session when the saved one cannot be resumed', async () => {
  const unknown = bridgeWith((l) => scriptedAgent(l))
  const unsupported = bridgeWith((l) => scriptedAgent(l, { resumable: false }))

  const afterUnknown = await unknown.bridge.start({ resumeSessionId: 'gone' })
  const afterUnsupported = await unsupported.bridge.start({ resumeSessionId: SESSION })

  assert.deepEqual([afterUnknown.sessionId, afterUnknown.resumed], [SESSION, false])
  assert.deepEqual(unknown.log.slice(1).map((entry) => entry[0]), ['resumeSession', 'newSession'])
  assert.deepEqual([afterUnsupported.resumed, unsupported.log.slice(1).map((entry) => entry[0])], [false, ['newSession']])
  unknown.bridge.dispose()
  unsupported.bridge.dispose()
})

test('acp bridge switches to an older session for a reopened conversation, or to a fresh one', async () => {
  const { log, bridge } = bridgeWith((l) => scriptedAgent(l))
  await bridge.start()

  const reopened = await bridge.switchSession(OLDER_SESSION)
  const fresh = await bridge.switchSession(null)

  assert.deepEqual([reopened.sessionId, reopened.resumed], [OLDER_SESSION, true])
  assert.deepEqual([fresh.sessionId, fresh.resumed], [SESSION, false])
  assert.deepEqual(log.slice(1).filter((entry) => entry[0] !== 'cancel'), [
    ['newSession', '/work'],
    ['closeSession', SESSION],
    ['resumeSession', OLDER_SESSION, '/work'],
    ['closeSession', OLDER_SESSION],
    ['newSession', '/work'],
  ])
  bridge.dispose()
})

test('acp bridge explains a launch failure: missing Node.js versus a missing working directory', () => {
  const messages = []
  const failingSpawn = () => {
    const child = fakeDsh(scriptedAgent([]))
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })))
    return child
  }
  const launch = (cwd) => createAcpBridge({ dshBin: '/x/bin.js', cwd, spawnFn: failingSpawn, emit: (e) => messages.push(e.message) })

  launch(process.cwd()).start().catch(() => {})
  launch('/definitely/not/here').start().catch(() => {})

  return new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
    assert.ok(messages.some((m) => /找不到 Node\.js/.test(m)))
    assert.ok(messages.some((m) => m === '工作目录不存在：/definitely/not/here'))
  })
})
