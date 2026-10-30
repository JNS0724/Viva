import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, RequestError } from '@agentclientprotocol/sdk'
import { createAcpBridge, SWITCHING } from '../src/main/acp-bridge.ts'
import { ResumeError } from '../src/main/resume-failure.ts'

/**
 * 继续这个话题 through the real bridge: exactly that session or none. The session in use is left only once the topic's
 * own is resumed; a failure (dsh holding no such session, or a fault on the way) leaves the agent where it was.
 */

const CURRENT = 'live-current'
const OLDER = 'live-older'
const OPTIONS = [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'v4', options: [{ value: 'v4', name: 'V4' }] }]

/** A fake `dsh --profile acp` whose stdio is served by a real ACP agent connection. */
function fakeDsh(agent: object) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { child.killed = true },
  })
  new AgentSideConnection(() => agent as never, ndJsonStream(Writable.toWeb(child.stdout), Readable.toWeb(child.stdin) as never))
  return child
}

function bridgeWith({ failClose = false, slow = null as Promise<void> | null } = {}) {
  const log: string[][] = []
  const agent = {
    async initialize(params: { protocolVersion: number }) {
      return { protocolVersion: params.protocolVersion, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, authMethods: [] }
    },
    async newSession(params: { cwd: string }) { log.push(['newSession', params.cwd]); return { sessionId: CURRENT, configOptions: OPTIONS } },
    async resumeSession(params: { sessionId: string, cwd: string }) {
      log.push(['resumeSession', params.sessionId])
      // As dsh-acp says it: Invalid params, the reason in data.
      if (params.sessionId === 'gone') throw RequestError.invalidParams({ details: `session is not resumable: ${params.sessionId}` })
      if (params.sessionId === 'flaky') throw new Error('read ECONNRESET')
      if (slow) await slow
      return { configOptions: OPTIONS }
    },
    async closeSession(params: { sessionId: string }) {
      log.push(['closeSession', params.sessionId])
      if (failClose) throw new Error('close failed')
      return {}
    },
    async cancel() {},
    async authenticate() { return {} },
    async prompt(params: { sessionId: string }) { log.push(['prompt', params.sessionId]); return { stopReason: 'end_turn' } },
  }
  const bridge = createAcpBridge({ dshBin: '/fake/dsh', profile: 'acp', cwd: '/work', spawnFn: (() => fakeDsh(agent)) as never, emit: () => {} })
  return { log, bridge }
}

const calls = (log: string[][], after: number) => log.slice(after).map((entry) => entry.join(' '))

test('a session dsh holds no more (said in the ACP error\'s data) is gone; the agent stays on its session, nothing opened', async () => {
  const { log, bridge } = bridgeWith()
  await bridge.start()
  const from = log.length
  await assert.rejects(bridge.switchSession('gone', '/work', { exactly: true }), (err: unknown) => err instanceof ResumeError && err.reason === 'gone')
  assert.deepEqual(calls(log, from), ['resumeSession gone'], 'the session in use not closed, no new one')
  const back = await bridge.switchSession(OLDER, '/work', { exactly: true })
  assert.deepEqual([back.sessionId, back.resumed], [OLDER, true])
  // The session left closes in the background, after the other was resumed.
  for (let i = 0; i < 200 && calls(log, from).length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(calls(log, from).slice(1), [`resumeSession ${OLDER}`, `closeSession ${CURRENT}`], 'left only once the other is resumed')
  bridge.dispose()
})

test('a fault on the way may work when tried again: unavailable, and the agent stays where it was', async () => {
  const { log, bridge } = bridgeWith()
  await bridge.start()
  const from = log.length
  await assert.rejects(bridge.switchSession('flaky', '/work', { exactly: true }), (err: unknown) => err instanceof ResumeError && err.reason === 'unavailable')
  assert.deepEqual(calls(log, from), ['resumeSession flaky'])
  bridge.dispose()
})

test('while a topic is taken up the bridge says it is switching, so no question goes to the session being left', async () => {
  const { bridge } = bridgeWith()
  await bridge.start()
  assert.equal(bridge.isSwitching(), false)
  const going = bridge.switchSession(OLDER, '/work', { exactly: true })
  assert.equal(bridge.isSwitching(), true, 'from the moment it starts')
  await going
  assert.equal(bridge.isSwitching(), false)
  await assert.rejects(bridge.switchSession('gone', '/work', { exactly: true }))
  assert.equal(bridge.isSwitching(), false, 'and after a failure too')
  bridge.dispose()
})

test('a question while a topic is being taken up is refused; none reaches the session being left', async () => {
  let release!: () => void
  const { log, bridge } = bridgeWith({ slow: new Promise<void>((resolve) => { release = resolve }) })
  await bridge.start()
  const going = bridge.switchSession(OLDER, '/work', { exactly: true })
  await assert.rejects(bridge.prompt('趁切换的时候问一句'), new RegExp(SWITCHING))
  release()
  await going
  assert.equal(log.some(([kind]) => kind === 'prompt'), false, 'no turn was started')
  bridge.dispose()
})

test('a question while going back is prepared (the session still being forked) is refused too', async (t) => {
  const { log, bridge } = bridgeWith()
  await bridge.start()
  // No fork plugin answers here: the fork waits for its time to run out, as a slow one would.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const going = bridge.fork({ before: 0 })
  assert.equal(bridge.isSwitching(), true, 'from the moment going back starts, before the switch itself')
  await assert.rejects(bridge.prompt('趁回退的时候问一句'), new RegExp(SWITCHING))
  t.mock.timers.tick(60_000)
  const result = await going
  t.mock.timers.reset()
  assert.equal(result.ok, false)
  assert.equal(bridge.isSwitching(), false, 'and let go when it is over')
  assert.equal(log.some(([kind]) => kind === 'prompt'), false, 'no turn was started')
  bridge.dispose()
})

test('the session left failing to close does not undo going over: the agent is on the one resumed', async () => {
  const { bridge } = bridgeWith({ failClose: true })
  await bridge.start()
  const went = await bridge.switchSession(OLDER, '/work', { exactly: true })
  assert.deepEqual([went.sessionId, went.resumed], [OLDER, true])
  bridge.dispose()
})
