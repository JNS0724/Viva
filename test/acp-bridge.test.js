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

test('a new topic without MCP does not wait for old cleanup; late updates and permissions stay detached', { timeout: 5000 }, async t => {
  let releaseClose, serverConnection, runtime, created = 0, cancelled = 0
  const events = [], timings = []
  const closeGate = new Promise(resolve => { releaseClose = resolve })
  const bridge = createAcpBridge({ dshBin: '/fake/dsh', cwd: '/work', emit: e => events.push(e), onTiming: s => timings.push(s),
    spawnFn: () => runtime = fakeDsh(conn => {
      serverConnection = conn
      return { ...scriptedAgent([])(conn),
        async newSession() { return { sessionId: `topic-${++created}`, configOptions: MODEL_OPTIONS } },
        async closeSession() { await closeGate; return {} },
        async cancel() { cancelled++ },
      }
    }),
  })
  t.after(() => { releaseClose(); bridge.dispose() })
  const old = await bridge.start()
  const next = await bridge.newSession()
  assert.notEqual(old.sessionId, next.sessionId)
  assert.equal(cancelled, 0, 'idle sessions need no redundant cancellation notification')
  await serverConnection.sessionUpdate({ sessionId: old.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } })
  const decision = await serverConnection.requestPermission({ sessionId: old.sessionId, toolCall: { toolCallId: 'old', title: 'old' }, options: [] })
  assert.equal(decision.outcome.outcome, 'cancelled')
  const proposal = { title: 'later', ask: 'prepare a draft', remindAt: 'tomorrow' }
  runtime.emit('message', { type: 'followup_propose', id: 'stale', sessionId: old.sessionId, proposal })
  assert.equal(events.length, 0)
  runtime.emit('message', { type: 'followup_propose', id: 'current', sessionId: next.sessionId, proposal })
  assert.equal(events[0]?.proposalId, 'current')
  assert.ok(timings.some(s => s.stage === 'session.switch' && s.ok))
  assert.equal(timings.some(s => s.stage === 'session.close'), false, 'switch finished before cleanup')
})

test('cold MCP topics wait for old resources and reject overlapping switches', { timeout: 5000 }, async t => {
  let created = 0, releaseClose
  const closeGate = new Promise(resolve => { releaseClose = resolve })
  const bridge = createAcpBridge({ dshBin: '/fake/dsh', cwd: '/work', emit: () => {},
    mcpServers: () => [{ name: 'exclusive', command: 'exclusive', args: [], env: [] }],
    spawnFn: () => fakeDsh(conn => ({ ...scriptedAgent([])(conn),
      async newSession() { return { sessionId: `topic-${++created}`, configOptions: MODEL_OPTIONS } },
      async closeSession() { await closeGate; return {} },
    })),
  })
  t.after(() => { releaseClose(); bridge.dispose() })
  await bridge.start()
  const switching = bridge.newSession()
  await assert.rejects(bridge.newSession(), /正在准备/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(created, 1)
  releaseClose()
  assert.equal((await switching).sessionId, 'topic-2')
})

test('a ready spare bypasses a slow old close while preserving MCP status', { timeout: 5000 }, async t => {
  let created = 0, releaseClose, prepared
  const closeGate = new Promise(resolve => { releaseClose = resolve })
  const ready = new Promise(resolve => { prepared = resolve })
  const bridge = createAcpBridge({ dshBin: '/fake/dsh', cwd: '/work', emit: () => {}, prewarmSessions: true,
    mcpServers: () => [{ name: 'safe', command: 'safe', args: [], env: [] }],
    spawnFn: () => fakeDsh(conn => ({ ...scriptedAgent([])(conn),
      async newSession() { const sessionId = `topic-${++created}`; if (created === 2) prepared(); return { sessionId, configOptions: MODEL_OPTIONS } },
      async closeSession() { await closeGate; return {} },
    })),
  })
  t.after(() => { releaseClose(); bridge.dispose() })
  await bridge.start(); await ready; await new Promise(resolve => setImmediate(resolve))
  const next = await bridge.newSession()
  assert.equal(next.sessionId, 'topic-2')
  assert.deepEqual(next.mcp, { active: ['safe'], dropped: [] })
  assert.equal(created, 2, 'do not accumulate new spares while old cleanup is outstanding')
})

test('setting an already selected model does not make a protocol call', async t => {
  const { bridge, log } = bridgeWith(l => scriptedAgent(l))
  t.after(() => { bridge.dispose() })
  await bridge.start()
  assert.equal((await bridge.setConfig('model', 'v4-flash')).modelValue, 'v4-flash')
  assert.equal(log.some(entry => entry[0] === 'setConfig'), false)
})

test('a failed old close blocks cold MCP initialization once and can be retried', async t => {
  let closes = 0, created = 0
  const bridge = createAcpBridge({ dshBin: '/fake/dsh', cwd: '/work', emit: () => {},
    mcpServers: () => [{ name: 'exclusive', command: 'exclusive', args: [], env: [] }],
    spawnFn: () => fakeDsh(conn => ({ ...scriptedAgent([])(conn),
      async newSession() { return { sessionId: `topic-${++created}`, configOptions: MODEL_OPTIONS } },
      async closeSession() { if (++closes === 1) throw Error('temporary close failure'); return {} },
    })),
  })
  t.after(() => { bridge.dispose() })
  await bridge.start()
  await assert.rejects(bridge.newSession(), /temporary close failure/)
  assert.equal(created, 1, 'never silently drop the exclusive MCP while the old session might still own it')
  assert.equal((await bridge.newSession()).sessionId, 'topic-2')
  assert.equal(closes, 2)
})

test('retrying a failed topic switch does not cancel a background task permission', async t => {
  let conn, closes = 0, created = 0
  const events = []
  const bridge = createAcpBridge({ dshBin: '/fake/dsh', cwd: '/work', emit: event => events.push(event),
    mcpServers: () => [{ name: 'safe', command: 'safe', args: [], env: [] }],
    spawnFn: () => fakeDsh(connection => {
      conn = connection
      return { ...scriptedAgent([])(connection),
        async newSession() { return { sessionId: `topic-${++created}`, configOptions: MODEL_OPTIONS } },
        async closeSession() { if (++closes === 1) throw Error('retry close'); return {} },
      }
    }),
  })
  t.after(() => { bridge.dispose() })
  await bridge.start()
  assert.equal((await bridge.resumeTask({ taskId: OLDER_SESSION })).ok, true)
  let answered = false
  const permission = conn.requestPermission({ sessionId: OLDER_SESSION, toolCall: { toolCallId: 'background', title: 'Background tool' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  }).then(result => { answered = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  const request = events.find(event => event.type === 'permission')
  await assert.rejects(bridge.newSession(), /retry close/)
  await bridge.newSession()
  assert.equal(answered, false)
  assert.equal(bridge.respondPermission(request.requestId, 'yes'), true)
  assert.equal((await permission).outcome.outcome, 'selected')
})

test('a singleton MCP refusing a speculative second instance does not poison the next real session or its status', async () => {
  const server = { name: 'singleton', command: 'singleton', args: [], env: [] }
  const opened = new Set(), requests = []
  let created = 0, speculativeAttempt
  const attempted = new Promise(resolve => { speculativeAttempt = resolve })
  const bridge = createAcpBridge({ dshBin: '/fake/dsh', cwd: '/work', prewarmSessions: true, mcpServers: () => [server], emit: () => {},
    spawnFn: () => fakeDsh(conn => ({ ...scriptedAgent([])(conn),
      async newSession(params) {
        requests.push(params.mcpServers.map(server => server.name))
        if (opened.size && params.mcpServers.length) { speculativeAttempt(); throw Error('mcp-client(singleton): database is locked by the active instance') }
        const sessionId = created++ ? `session-${created}` : SESSION
        opened.add(sessionId)
        return { sessionId, configOptions: MODEL_OPTIONS }
      },
      async closeSession({ sessionId }) { opened.delete(sessionId); return {} },
    })),
  })
  try {
    await bridge.start(); await attempted; await new Promise(resolve => setImmediate(resolve))
    const before = await bridge.setConfig('model', 'v4-pro')
    assert.deepEqual(before.mcp, { active: ['singleton'], dropped: [] })
    const next = await bridge.newSession()
    assert.deepEqual(next.mcp, { active: ['singleton'], dropped: [] })
    assert.ok(requests.length >= 3)
    assert.ok(requests.every(names => names.includes('singleton')), 'never cache or consume a spare that silently dropped the MCP')
  } finally { bridge.dispose() }
})

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

/** Waits until `check` holds, looking again every few ms, or gives up after `ms` (a slow machine takes longer). */
async function eventually(check, { ms = 2000, every = 5 } = {}) {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, every))
}

test('acp bridge explains a launch failure: missing Node.js versus a missing working directory', async () => {
  const messages = []
  const failingSpawn = () => {
    const child = fakeDsh(scriptedAgent([]))
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })))
    return child
  }
  const launch = (cwd) => createAcpBridge({ dshBin: '/x/bin.js', cwd, spawnFn: failingSpawn, emit: (e) => messages.push(e.message) })

  launch(process.cwd()).start().catch(() => {})
  launch('/definitely/not/here').start().catch(() => {})

  const missingNode = () => messages.some((m) => /找不到 Node\.js/.test(m))
  const missingDir = () => messages.some((m) => m === '工作目录不存在：/definitely/not/here')
  // Both failures are reported asynchronously; wait for them rather than for a fixed time.
  await eventually(() => missingNode() && missingDir())
  assert.ok(missingNode(), JSON.stringify(messages))
  assert.ok(missingDir(), JSON.stringify(messages))
})
