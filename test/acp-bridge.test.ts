import type { SpawnOptions } from 'node:child_process'
import { appToMcpOf, type AppToMcp, type McpServerEntry } from '../src/shared/mcp-channel.ts'
import { decodeInfo, decodePermission } from '../src/renderer/agent-event-decoder.ts'
import { objectOf } from '../src/shared/unknown-value.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, type Agent, type PromptRequest, type PromptResponse, type SessionConfigOption, type Implementation } from '@agentclientprotocol/sdk'
import { createAcpBridge as createBridge } from '../src/backend/acp-bridge.ts'
import { createMemoryPrefetchManager } from '../src/backend/memory-prefetch.ts'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
import pkg from '../package.json' with { type: 'json' }
import { testRequests, withPluginSide } from './fixtures/request-routing.ts'
import { requestsIn, withoutHeaders } from '../src/shared/request-routing/header.ts'

type Options = Parameters<typeof createBridge>[0]
type BridgeEvent = Parameters<Options['emit']>[0]
type Log = unknown[][]
type Factory = (session: AgentSideConnection) => Agent

// The fake exposes the stdio and IPC subset that the bridge uses.
function createAcpBridge({ spawnFn, ...options }: Omit<Options, 'profile' | 'spawnFn'> & {
  spawnFn: (bin: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof fakeDsh>
}) {
  return createBridge({ ...options, profile: 'viva', spawnFn: spawnFn as unknown as Options['spawnFn'] })
}
function textOf(params: PromptRequest) {
  const block = params.prompt[0]
  assert.ok(block?.type === 'text')
  return block.text
}

const APP_VERSION = pkg.version
/** What the app told the fake dsh it is, at the last initialize. */
let lastClientInfo: Implementation | null | undefined
/** What the app last prompted the fake dsh with, as sent (its request header included). */
let lastPrompt = ''

const SESSION = 'session-1'
const OLDER_SESSION = 'session-0'
const modelOptions = (currentValue: string): SessionConfigOption[] => [{
  id: 'model', name: 'Model', type: 'select', currentValue,
  options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [
    { value: 'v4-flash', name: 'DeepSeek V4 Flash' },
    { value: 'v4-pro', name: 'DeepSeek V4 Pro' },
  ] }],
}]
const MODEL_OPTIONS = modelOptions('v4-flash')

test('a new topic without MCP does not wait for old cleanup; late updates and permissions stay detached', { timeout: 5000 }, async t => {
  let releaseClose!: () => void, serverConnection!: AgentSideConnection, created = 0, cancelled = 0
  const events: BridgeEvent[] = [], timings: Parameters<NonNullable<Options['onTiming']>>[0][] = []
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve })
  const bridge = createAcpBridge({ routing: testRequests(), dshBin: '/fake/dsh', cwd: '/work', emit: e => events.push(e), onTiming: s => timings.push(s),
    spawnFn: () => fakeDsh(conn => {
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
  assert.ok(old.sessionId)
  await serverConnection.sessionUpdate({ sessionId: old.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } })
  const decision = await serverConnection.requestPermission({ sessionId: old.sessionId, toolCall: { toolCallId: 'old', title: 'old' }, options: [] })
  assert.equal(decision.outcome.outcome, 'cancelled')
  assert.equal(events.length, 0, 'what the old session says reaches nothing')
  assert.ok(timings.some(s => s.stage === 'session.switch' && s.ok))
  assert.equal(timings.some(s => s.stage === 'session.close'), false, 'switch finished before cleanup')
})

test('a ready spare bypasses a slow old close', { timeout: 5000 }, async t => {
  let created = 0, releaseClose!: () => void, prepared!: () => void
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve })
  const ready = new Promise<void>(resolve => { prepared = resolve })
  const bridge = createAcpBridge({ routing: testRequests(), dshBin: '/fake/dsh', cwd: '/work', emit: () => {}, prewarmSessions: true,
    mcpServers: () => [{ name: 'safe', entry: { transport: 'stdio', command: 'safe', args: [], env: {} } }],
    spawnFn: () => fakeDsh(conn => ({ ...scriptedAgent([])(conn),
      async newSession() { const sessionId = `topic-${++created}`; if (created === 2) prepared(); return { sessionId, configOptions: MODEL_OPTIONS } },
      async closeSession() { await closeGate; return {} },
    })),
  })
  t.after(() => { releaseClose(); bridge.dispose() })
  await bridge.start(); await ready; await new Promise(resolve => setImmediate(resolve))
  const next = await bridge.newSession()
  assert.equal(next.sessionId, 'topic-2')
  assert.deepEqual(next.mcp, { active: [], connecting: [], dropped: [] }, 'how servers stand comes from viva-mcp, not from opening sessions')
  assert.equal(created, 2, 'do not accumulate new spares while old cleanup is outstanding')
})

test('setting an already selected model does not make a protocol call', async t => {
  const { bridge, log } = bridgeWith(l => scriptedAgent(l))
  t.after(() => { bridge.dispose() })
  await bridge.start()
  assert.equal((await bridge.setConfig('model', 'v4-flash')).modelValue, 'v4-flash')
  assert.equal(log.some(entry => entry[0] === 'setConfig'), false)
})

test('retrying a failed topic switch does not cancel a background task permission', async t => {
  let conn!: AgentSideConnection, closes = 0, created = 0
  const events: BridgeEvent[] = []
  const bridge = createAcpBridge({ routing: testRequests(), dshBin: '/fake/dsh', cwd: '/work', emit: event => events.push(event),
    mcpServers: () => [{ name: 'safe', entry: { transport: 'stdio', command: 'safe', args: [], env: {} } }],
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
  // The first close fails; neither switch waits on it now that sessions have no MCP servers of their own.
  await bridge.newSession()
  await bridge.newSession()
  assert.equal(answered, false)
  assert.ok(request && typeof request.requestId === 'string')
  assert.equal(bridge.respondPermission(request.requestId, 'yes'), true)
  assert.equal((await permission).outcome.outcome, 'selected')
})

/** A fake `dsh --profile acp` child process whose stdio is served by a real ACP agent connection. */
function fakeDsh(agentFactory: Factory) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false, kill() { this.killed = true; return true },
  })
  const stream = ndJsonStream(Writable.toWeb(child.stdout), Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>)
  new AgentSideConnection(agentFactory, stream)
  return withPluginSide(child)
}

function scriptedAgent(log: Log, { resumable = true } = {}): Factory {
  return conn => ({
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
      lastPrompt = textOf(params)
      log.push(['prompt', withoutHeaders(lastPrompt)])
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
  const log: Log = []
  const events: BridgeEvent[] = []
  let child!: ReturnType<typeof fakeDsh>
  const bridge = createAcpBridge({ routing: testRequests(),
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
      if (event.type === 'permission') {
        const permission = decodePermission(event)
        assert.ok(permission)
        setImmediate(() => bridge.respondPermission(permission.requestId, 'yes'))
      }
    },
  })

  // Act
  const info = await bridge.start()
  await bridge.prompt('写个笔记')
  assert.equal(await bridge.cancel(), false, 'an idle stop issues no native cancel')

  // Assert
  assert.deepEqual([info.mode, info.model, info.modelValue, info.cwd], ['live', 'DeepSeek V4 Flash', 'v4-flash', '/work'])
  assert.deepEqual(info.models.map((m) => [m.name, m.group]), [['DeepSeek V4 Flash', 'DeepSeek'], ['DeepSeek V4 Pro', 'DeepSeek']])
  assert.deepEqual(log, [
    ['spawn', '/fake/dsh', '--profile viva', '/work'],
    ['initialize', 1, 'viva'],
    ['newSession', '/work'],
    ['prompt', '写个笔记'],
    ['decision', { outcome: 'selected', optionId: 'yes' }],
  ])
  assert.equal(lastClientInfo?.version, APP_VERSION, 'dsh is told the version the app was built as')
  assert.deepEqual(requestsIn(lastPrompt).map((request) => request.words), ['写个笔记'], 'the words go as a request, under its header')
  // What the turn says reaches the window only through the stream contract (the plugin side here shows nothing).
  assert.deepEqual(events.map((e) => objectOf(e.update)?.sessionUpdate ?? e.type), ['permission', 'turn_end'])
  assert.equal(decodePermission(events[0])?.toolCall.title, '写入 notes.md')
  assert.equal(events.at(-1)?.stopReason, 'end_turn')

  bridge.dispose()
  assert.equal(child.stdin.writableEnded, true)
})

test('acp bridge reports an unexpected dsh exit with its stderr tail', async () => {
  const events: BridgeEvent[] = []
  let child!: ReturnType<typeof fakeDsh>
  const bridge = createAcpBridge({ routing: testRequests(),
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

  assert.equal(events.at(-1)?.type, 'error')
  assert.match(String(events.at(-1)?.message), /dsh 已退出（1）.*DEEPSEEK_API_KEY rejected/)
})

test('acp bridge switches the model via session/set_config_option and relays config updates', async () => {
  // Arrange
  const log: Log = []
  const events: BridgeEvent[] = []
  const bridge = createAcpBridge({ routing: testRequests(),
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
  assert.equal(events.at(-1)?.type, 'config')
  assert.equal(decodeInfo(events.at(-1)?.info)?.model, 'DeepSeek V4 Pro')
  await assert.rejects(bridge.setConfig('model', 'nope'), /unknown model option/)
  bridge.dispose()
})

function bridgeWith(agent: (log: Log) => Factory) {
  const log: Log = []
  const bridge = createAcpBridge({ routing: testRequests(),
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
async function eventually(check: () => boolean, { ms = 2000, every = 5 } = {}) {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, every))
}

test('acp bridge explains a launch failure: missing Node.js versus a missing working directory', async () => {
  const messages: string[] = []
  const failingSpawn = () => {
    const child = fakeDsh(scriptedAgent([]))
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })))
    return child
  }
  const launch = (cwd: string) => createAcpBridge({ routing: testRequests(), dshBin: '/x/bin.js', cwd, spawnFn: failingSpawn, emit: (e) => messages.push(String(e.message)) })

  launch(process.cwd()).start().catch(() => {})
  launch('/definitely/not/here').start().catch(() => {})

  const missingNode = () => messages.some((m) => /找不到 Node\.js/.test(m))
  const missingDir = () => messages.some((m) => m === '工作目录不存在：/definitely/not/here')
  // Both failures are reported asynchronously; wait for them rather than for a fixed time.
  await eventually(() => missingNode() && missingDir())
  assert.ok(missingNode(), JSON.stringify(messages))
  assert.ok(missingDir(), JSON.stringify(messages))
})

test('what the conversation on screen waits on is there to read while it waits, and gone once answered', async () => {
  const log: Log = []
  const seen: ReturnType<ReturnType<typeof createBridge>['sessionWaits']>[] = []
  const bridge = createAcpBridge({ routing: testRequests(),
    dshBin: '/fake/dsh', cwd: '/work', env: {},
    spawnFn: () => fakeDsh(scriptedAgent(log)),
    emit: (event) => {
      if (event.type !== 'permission') return
      const permission = decodePermission(event)
      assert.ok(permission)
      seen.push(bridge.sessionWaits())
      setImmediate(() => bridge.respondPermission(permission.requestId, 'yes'))
    },
  })
  assert.deepEqual(bridge.sessionWaits(), { permissions: [], questions: [], secrets: [] }, 'no session yet: nothing')
  await bridge.start()
  await bridge.prompt('写个笔记')
  assert.deepEqual(seen.map((waits) => [waits.permissions.map((wait) => objectOf(wait.toolCall)?.title), waits.questions]), [[['写入 notes.md'], []]])
  assert.equal(Array.isArray(seen[0].permissions[0].options) && seen[0].permissions[0].options.length > 0, true, 'with the options it was asked with')
  assert.deepEqual(bridge.sessionWaits(), { permissions: [], questions: [], secrets: [] }, 'answered: no longer waiting')
  bridge.dispose()
})

test('a session the bridge leaves ends its turn at the host: what it left undecided fails as cancelled', { timeout: 5000 }, async t => {
  const requests = testRequests()
  let created = 0
  const bridge = createAcpBridge({ routing: requests, dshBin: '/fake/dsh', cwd: '/work', emit: () => {},
    spawnFn: () => fakeDsh(conn => ({ ...scriptedAgent([])(conn),
      async newSession() { return { sessionId: `topic-${++created}`, configOptions: MODEL_OPTIONS } },
      async prompt(params) { lastPrompt = textOf(params); return { stopReason: 'end_turn' } },
    })),
  })
  t.after(() => { bridge.dispose() })
  await bridge.start()
  await bridge.prompt('写个笔记')
  const [asked] = requestsIn(lastPrompt)
  assert.equal(requests.store.get(asked.id)?.status, 'received', 'nothing decided it, and no turn end came through')
  await bridge.newSession()
  assert.deepEqual([requests.store.get(asked.id)?.status, requests.store.get(asked.id)?.failure], ['failed', 'cancelled'])
})

test('stopping the turn ends its requests at once: nothing is decided for it while it winds down', { timeout: 5000 }, async t => {
  const requests = testRequests()
  let entered!: () => void, resolveNative!: (value: PromptResponse) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const native = new Promise<PromptResponse>(resolve => { resolveNative = resolve })
  const bridge = createAcpBridge({ routing: requests, dshBin: '/fake/dsh', cwd: '/work', emit: () => {},
    spawnFn: () => fakeDsh(conn => ({ ...scriptedAgent([])(conn),
      async prompt(params) { lastPrompt = textOf(params); entered(); return native },
      async cancel() { resolveNative({ stopReason: 'cancelled' }) },
    })),
  })
  t.after(() => { bridge.dispose() })
  const { sessionId } = await bridge.start()
  assert.ok(sessionId)
  const running = bridge.prompt('写个笔记')
  await started
  const [asked] = requestsIn(lastPrompt)
  assert.equal(await bridge.cancel(), true)
  await running
  assert.deepEqual([requests.store.get(asked.id)?.status, requests.store.get(asked.id)?.failure], ['failed', 'cancelled'])
  assert.equal((await requests.decide({ requestId: asked.id, sessionId, plan: { goals: [{ goal: '笔记', disposition: 'delegate' }], actions: [{ kind: 'start', brief: '写笔记' }] } })).accepted, false)
})

test('MCP servers go to viva-mcp, not to sessions: sent when it starts and on each change; how they stand comes back', async () => {
  const sent: AppToMcp[] = []
  const events: BridgeEvent[] = []
  const opened: unknown[] = []
  let child!: ReturnType<typeof fakeDsh>
  const servers: McpServerEntry[] = [{ name: 'mail', entry: { transport: 'stdio', command: '/bin/mail-mcp', args: [], env: { MAIL_KEY: 'k' } } }]
  const bridge = createAcpBridge({ routing: testRequests(), dshBin: '/fake/dsh', cwd: '/work', emit: event => events.push(event), mcpServers: () => servers,
    spawnFn: () => {
      child = fakeDsh(conn => ({ ...scriptedAgent([])(conn), async newSession(params) { opened.push(params.mcpServers); return { sessionId: SESSION, configOptions: MODEL_OPTIONS } } }))
      const send = child.send
      child.send = (message, callback) => { const frame = appToMcpOf(message); if (frame) sent.push(frame); return send(message, callback) }
      return child
    },
  })
  await bridge.start()
  assert.deepEqual(opened, [[]], 'a session opens with no servers of its own')

  child.emit('message', { type: 'mcp_ready', version: 1 })
  assert.deepEqual(sent, [{ type: 'mcp_servers', version: 1, servers }], 'the plugin gets them when it starts')
  servers.push({ name: 'docs', entry: { transport: 'streamable-http', url: 'https://mcp.example/mcp', headers: {} } })
  bridge.applyMcp()
  const latest = sent.at(-1)
  assert.ok(latest?.type === 'mcp_servers')
  assert.deepEqual(latest.servers.map(server => server.name), ['mail', 'docs'], 'and again on a change, no session reopened')
  assert.equal(opened.length, 1)
  bridge.restartMcp('mail')
  assert.deepEqual(sent.at(-1), { type: 'mcp_restart', version: 1, name: 'mail' })

  child.emit('message', { type: 'mcp_status', version: 1, servers: [
    { name: 'mail', state: 'connected', error: '', tools: 2 },
    { name: 'docs', state: 'reconnecting', error: 'timed out', tools: 0 },
    { name: 'old', state: 'failed', error: 'gave up', tools: 0 },
  ] })
  child.emit('message', { type: 'mcp_status', version: 1, servers: [{ name: 'bad name!', state: 'connected', error: '', tools: 0 }] })
  assert.deepEqual(events.filter(event => event.type === 'mcp_status').map(event => event.mcp), [
    { active: ['mail'], connecting: [{ name: 'docs', reason: 'timed out' }], dropped: [{ name: 'old', reason: 'gave up' }] },
  ], 'a malformed status is not taken')
  bridge.dispose()
})

test('cancelling a foreground turn while routingDesk.bind() is pending releases its started host prefetch (R3 P2-3)', { timeout: 5000 }, async t => {
  const startedPrefetches: Array<{ sessionId: string, requestId: string }> = []
  const cancelledPrefetches: Array<{ sessionId: string, requestId: string }> = []
  let bindSent = false
  let releaseBind!: () => void
  const bindSeen = new Promise<void>(resolve => { releaseBind = resolve })
  const fakeOwner = {
    channel: { call: async () => { throw new Error('unused') }, readBatch: async () => { throw new Error('unused') }, ready: () => false },
    bindDsh: () => ({ receive: () => false, ready: () => false, waitReady: async () => {} }),
    startPrefetch(input: { sessionId: string, requestId: string }) {
      startedPrefetches.push({ sessionId: input.sessionId, requestId: input.requestId })
    },
    cancelPrefetch(sessionId: string, requestId: string) {
      cancelledPrefetches.push({ sessionId, requestId })
    },
    clearSessionPrefetches() {},
    profileDeletionGen: () => 0,
  }
  const bridge = createAcpBridge({
    routing: testRequests(),
    dshBin: '/fake/dsh',
    cwd: '/work',
    emit: () => {},
    memoryOwner: fakeOwner as unknown as Options['memoryOwner'],
    spawnFn: () => {
      const child = fakeDsh(scriptedAgent([]))
      // Hold routing_bind without acknowledging so operations.run stays inside prepare()!
      const origSend = child.send.bind(child)
      child.send = (message, callback) => {
        if (message && typeof message === 'object' && message.type === 'routing_bind') {
          bindSent = true
          releaseBind()
          callback?.(null)
          return true
        }
        return origSend(message, callback)
      }
      return child
    },
  })
  t.after(() => { bridge.dispose() })
  const { sessionId } = await bridge.start()
  assert.ok(sessionId)
  const promptPromise = bridge.prompt('在 bind 挂起期间被取消的请求', [], { userTurn: true })
  await bindSeen
  assert.equal(bindSent, true)
  assert.equal(startedPrefetches.length, 1, 'prefetch must have started before routingDesk.bind()')

  assert.equal(await bridge.cancel(), true)
  await promptPromise
  assert.deepEqual(cancelledPrefetches, startedPrefetches, 'pre-dispatch cancel during pending routingDesk.bind() must release the started prefetch')
})

test('ACP prompt returning stopReason cancelled calls cancelPrefetch so delayed claim returns skipped (R11 P2-1)', { timeout: 5000 }, async t => {
  const events: BridgeEvent[] = []
  let startedReqId = ''
  const prefetch = createMemoryPrefetchManager({
    defaultBudgetMs: 100,
    async callPrefetch() {
      return { epoch: 'e-acp', revision: 1, result: { status: 'hit', text: 'ACP_HIT', partial: false, hits: [{ text: 'ACP_HIT', names: ['a'] }] } }
    },
  })
  t.after(() => prefetch.close())
  prefetch.onState({ type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: 'e-acp', state: 'ready', revision: 1, coreEpoch: 1 })

  const fakeOwner = {
    channel: { call: async () => { throw new Error('unused') }, readBatch: async () => { throw new Error('unused') }, ready: () => false },
    profileDeletionGen: () => 0,
    startPrefetch(input: Parameters<typeof prefetch.startPrefetch>[0]) {
      startedReqId = input.requestId
      prefetch.startPrefetch(input)
    },
    cancelPrefetch: (s: string, r: string) => prefetch.cancelPrefetch(s, r),
    finishPrefetch: (s: string, r: string) => prefetch.finishPrefetch(s, r),
    clearSessionPrefetches: (s: string) => prefetch.clearSession(s),
    bindDsh() { return { receive: () => false, ready: () => true, waitReady: async () => {} } },
  }
  const bridge = createAcpBridge({
    routing: testRequests(),
    dshBin: '/fake/dsh',
    cwd: '/work',
    emit: e => events.push(e),
    memoryOwner: fakeOwner as unknown as Options['memoryOwner'],
    spawnFn: () => fakeDsh(conn => ({
      ...scriptedAgent([])(conn),
      async prompt() {
        return { stopReason: 'cancelled' }
      },
    })),
  })
  t.after(() => { bridge.dispose() })
  const { sessionId } = await bridge.start()
  assert.ok(sessionId)

  await bridge.prompt('post-dispatch cancelled prompt', [], { userTurn: true })
  assert.ok(startedReqId, 'prefetch must have been started')
  assert.ok(events.some(e => e.type === 'turn_end' && e.stopReason === 'cancelled'), 'turn_end must report stopReason cancelled')

  const delayedClaim = await prefetch.claimPrefetch({ requestId: startedReqId, sessionId })
  assert.deepEqual(
    delayedClaim,
    { found: true, result: { status: 'skipped' } },
    'delayed claim after ACP stopReason=cancelled must return terminal skipped (not { found: false }) (R11 P2-1)',
  )
})
