import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { testRequests, withPluginSide } from './fixtures/request-routing.ts'
import { currentTurnTextParts } from './fixtures/model-user-text.ts'
import { parseHostMemoryCommand } from '../src/memory/contracts/host.ts'

function fixture({ recovered = true, admittedAfter = true, projectChanged = false, recoveryError = false, resumeError = '' } = {}) {
  let allowed = false
  let created = 0
  const calls: string[] = []
  const child = withPluginSide(Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { child.killed = true },
  }))
  const transport = child as typeof child & { send(message: object, callback?: (error: Error | null) => void): boolean }
  const send = transport.send
  transport.send = (message, callback) => {
    const input = message as { type?: string, method?: unknown, input?: unknown, requestId?: string, epoch?: string }
    if (input.type !== 'memory_host_request') return send(message, callback)
    const command = parseHostMemoryCommand(input.method, input.input)
    calls.push(command.method)
    if (command.method === 'recoverContext' && recoveryError) {
      setImmediate(() => child.emit('message', { type: 'memory_host_result', requestId: input.requestId, epoch: input.epoch, ok: false, error: { reason: 'native flush failed' } }))
      callback?.(null); return true
    }
    let result: unknown
    if (command.method === 'projectChanged') result = projectChanged
    else if (command.method === 'recoverContext') { allowed = admittedAfter; result = recovered }
    else if (command.method === 'bindWireAlias') result = { wireText: command.input.args[2] }
    else throw new Error(`Unexpected command ${command.method}`)
    setImmediate(() => child.emit('message', { type: 'memory_host_result', requestId: input.requestId, epoch: input.epoch, ok: true, result }))
    callback?.(null)
    return true
  }
  const agent = {
    async initialize(params: { protocolVersion: number }) { return { protocolVersion: params.protocolVersion, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [] } },
    async resumeSession(params: { sessionId: string }) { calls.push(`resume:${params.sessionId}`); if (resumeError) throw new Error(resumeError); return { configOptions: [] } },
    async newSession() { calls.push('newSession'); return { sessionId: ++created === 1 ? 'native-main' : `native-new-${created}`, configOptions: [] } },
    async closeSession(params: { sessionId: string }) { calls.push(`close:${params.sessionId}`); return {} },
    async prompt() { calls.push('prompt'); return { stopReason: 'end_turn' } },
    async cancel() {}, async authenticate() { return {} },
  }
  new AgentSideConnection(() => agent as never, ndJsonStream(Writable.toWeb(child.stdout), Readable.toWeb(child.stdin) as never))
  const bridge = createAcpBridge({ routing: testRequests(), dshBin: '/fake/dsh', profile: 'acp', cwd: '/work', emit() {},
    allowSession: () => { calls.push('allowsSession'); return allowed }, spawnFn: (() => child) as never })
  return { bridge, calls, ready() { bridge.memory.receive({ type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: 'owner', state: 'ready', revision: 1, coreEpoch: 0 }) } }
}

test('a new Viva human request performs native durable recovery before rechecking admission and constructing its prompt', async t => {
  const { bridge, calls, ready } = fixture(); t.after(() => { void bridge.dispose() }); await bridge.start(); ready()
  await bridge.prompt('A new human question')
  const recovery = calls.indexOf('recoverContext'), prompt = calls.indexOf('prompt')
  assert.ok(recovery >= 0 && prompt > recovery)
  assert.equal(calls[recovery + 1], 'allowsSession', 'native success does not replace the normal authorization gate')
  assert.ok(calls.indexOf('bindWireAlias') > recovery, 'source alias and request content are constructed only after recovery')
})

test('a failed or still-stale recovery cannot dispatch the Viva prompt', async t => {
  for (const settings of [{ recovered: false, admittedAfter: true }, { recovered: true, admittedAfter: false }]) {
    const { bridge, calls, ready } = fixture(settings); t.after(() => { void bridge.dispose() }); await bridge.start(); ready()
    await assert.rejects(bridge.prompt('A new human question'))
    assert.equal(calls.includes('recoverContext'), true)
    assert.equal(calls.includes('prompt'), false)
  }
})

test('derived relays and non-user turns cannot use context recovery to bypass stale provenance', async t => {
  for (const options of [{ request: false }, { request: true, userTurn: false }]) {
    const { bridge, calls, ready } = fixture(); t.after(() => { void bridge.dispose() }); await bridge.start(); ready()
    await assert.rejects(bridge.prompt('Generated background result', [], options))
    assert.equal(calls.includes('recoverContext'), false)
    assert.equal(calls.includes('prompt'), false)
  }
})

test('foreground cold resume loads the real native session before recovery and never silently substitutes a new session on stale denial', async t => {
  for (const recovered of [true, false]) {
    const { bridge, calls, ready } = fixture({ recovered }); t.after(() => { void bridge.dispose() }); ready()
    if (recovered) {
      const result = await bridge.start({ resumeSessionId: 'native-saved' })
      assert.equal(result.resumed, true)
      assert.equal(result.sessionId, 'native-saved')
    } else await assert.rejects(bridge.start({ resumeSessionId: 'native-saved' }))
    assert.ok(calls.indexOf('resume:native-saved') < calls.indexOf('recoverContext'))
    assert.equal(calls.includes('newSession'), false)
    assert.equal(calls.includes('prompt'), false, 'loading and recovering native history sends no model request')
  }
})


test('cold startup opens an empty native session only for a verified project identity mismatch', async t => {
  const { bridge, calls, ready } = fixture({ projectChanged: true })
  t.after(() => { void bridge.dispose() }); ready()
  const result = await bridge.start({ resumeSessionId: 'old-project-session' })
  assert.equal(result.resumed, false)
  assert.equal(result.sessionId, 'native-main')
  assert.deepEqual(calls.slice(0, 2), ['projectChanged', 'newSession'])
  assert.equal(calls.includes('resume:old-project-session'), false)
  assert.equal(calls.includes('recoverContext'), false)
  assert.equal(calls.includes('prompt'), false)
})


test('a cold recovery storage or flush failure does not open an empty replacement session', async t => {
  const { bridge, calls, ready } = fixture({ recoveryError: true })
  t.after(() => { void bridge.dispose() }); ready()
  await assert.rejects(bridge.start({ resumeSessionId: 'native-saved' }), /native flush failed/)
  assert.ok(calls.includes('projectChanged'))
  assert.ok(calls.includes('recoverContext'))
  assert.equal(calls.includes('newSession'), false)
  assert.equal(calls.includes('prompt'), false)
})

test('fake model current-turn parsing excludes recovered history before separate or merged new prompt blocks', () => {
  const previous = ['The previous generated context has been retired.', '[Earlier user message 1]', 'old request']
  assert.deepEqual(currentTurnTextParts([...previous, '\n[End of earlier user messages]\n', 'new request', '<about-user>profile']), ['new request', '<about-user>profile'])
  assert.deepEqual(currentTurnTextParts([previous.join('\n') + '\n[End of earlier user messages]\nnew request']), ['new request'])
  assert.deepEqual(currentTurnTextParts(['normal request', '<about-user>profile']), ['normal request', '<about-user>profile'])
  assert.deepEqual(currentTurnTextParts(['Please quote [End of earlier user messages] literally']), ['Please quote [End of earlier user messages] literally'])
})


test('native loading or plugin replay errors do not silently start a new cold session', async t => {
  const { bridge, calls, ready } = fixture({ resumeError: 'native storage unreadable' })
  t.after(() => { void bridge.dispose() }); ready()
  await assert.rejects(bridge.start({ resumeSessionId: 'native-saved' }), /native storage unreadable/)
  assert.ok(calls.includes('resume:native-saved'))
  assert.equal(calls.includes('newSession'), false)
  assert.equal(calls.includes('recoverContext'), false)
})

for (const entry of ['switch', 'reload'] as const) {
  test(`non-exact ${entry} may open an empty session for a verified project change`, async t => {
    const { bridge, calls, ready } = fixture({ projectChanged: true })
    t.after(() => { void bridge.dispose() }); ready()
    const initial = await bridge.start(), offset = calls.length
    const result = await (entry === 'switch' ? bridge.switchSession('native-saved') : bridge.reloadSession())
    const actual = calls.slice(offset)
    assert.equal(result.resumed, false)
    assert.notEqual(result.sessionId, initial.sessionId)
    assert.ok(actual.includes('projectChanged'))
    assert.equal(actual.filter(call => call === 'newSession').length, 1)
    assert.equal(actual.some(call => call.startsWith('resume:')), false)
    assert.equal(actual.includes('recoverContext'), false)
    assert.equal(actual.includes('prompt'), false)
  })

  for (const failure of ['native-storage', 'recovery-flush'] as const) {
    test(`non-exact ${entry} refuses ${failure} without substituting a fresh session`, async t => {
      const { bridge, calls, ready } = fixture(failure === 'native-storage'
        ? { resumeError: 'native storage unreadable' } : { recoveryError: true })
      t.after(() => { void bridge.dispose() }); ready(); await bridge.start()
      const offset = calls.length
      await assert.rejects(entry === 'switch' ? bridge.switchSession('native-saved') : bridge.reloadSession(),
        failure === 'native-storage' ? /native storage unreadable/ : /native flush failed/)
      const actual = calls.slice(offset)
      assert.ok(actual.includes('projectChanged'))
      assert.ok(actual.some(call => call.startsWith('resume:')))
      assert.equal(actual.includes('recoverContext'), failure === 'recovery-flush')
      assert.equal(actual.includes('newSession'), false)
      assert.equal(actual.includes('prompt'), false)
    })
  }
}
