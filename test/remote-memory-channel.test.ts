import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteMemoryChannel } from '../src/backend/remote-memory-channel.ts'
import { memoryHostFailure } from '../src/memory/contracts/domain-error.ts'
import { MemoryDomainError } from '../src/memory/core/presentation.ts'
import { t } from '../src/shared/i18n/translate.ts'
import { parseHostMemoryCommand } from '../src/memory/contracts/host.ts'
const state = (epoch: string, status = 'ready') => ({ type: 'memory_owner_state', protocol: 1, epoch, state: status, revision: 0, coreEpoch: 0 })
test('remote owner client rejects disconnected calls and a late old-epoch response', async () => {
  const sent: Array<Record<string, unknown>> = []
  const client = createRemoteMemoryChannel({ send: message => sent.push(message as Record<string, unknown>), timeoutMs: 50 })
  await assert.rejects(client.call('revision', { args: [] }), /unavailable/)
  client.receive(state('first'))
  const pending = client.call('revision', { args: [] })
  const rejected = assert.rejects(pending, /generation changed/)
  client.receive(state('second'))
  client.receive({ type: 'memory_host_result', requestId: sent[0].requestId, epoch: 'first', ok: true, result: 99 })
  await rejected
  const next = client.call('revision', { args: [] })
  client.receive({ type: 'memory_host_result', requestId: sent[1].requestId, epoch: 'second', ok: true, result: 2 })
  assert.equal(await next, 2)
  client.close()
})
test('recovering owner permits only durable recovery methods and fails pending work on disconnect', async () => {
  const client = createRemoteMemoryChannel({ send() {} })
  client.receive(state('recover', 'recovering'))
  await assert.rejects(client.call('addMemory', { args: ['text'] }), /unavailable/)
  const pending = client.call('pendingHostEffects', {})
  const rejected = assert.rejects(pending, /disconnected/)
  client.processExited(); await rejected
})
test('JSON tuple transport restores only optional undefined slots and rejects arbitrary runtime calls', () => {
  assert.deepEqual(parseHostMemoryCommand('transfer', { args: ['session', null, null, true] }), { method: 'transfer', input: { args: ['session', undefined, undefined, true] } })
  assert.equal(parseHostMemoryCommand('authorizeGeneralQuestion', { args: ['session', 'turn', [], null, { kind: 'user' }, null, 'show'] }).input !== null, true)
  assert.throws(() => parseHostMemoryCommand('close', { args: [] }), /Unknown/)
  assert.throws(() => parseHostMemoryCommand('recordSession', { args: [null] }))
})

test('owner domain errors retain conflict identity and localized wording across IPC', async () => {
  let sent: Record<string, unknown> = {}
  const client = createRemoteMemoryChannel({ send: message => { sent = message as Record<string, unknown> } })
  client.receive(state('owner'))
  const pending = client.call('editMemory', { args: [1, 'replacement', 3, 'operation'] })
  const rejected = assert.rejects(pending, (error: Error & { code?: string }) => {
    assert.equal(error.code, 'revision-conflict')
    assert.equal(error.message, t('main.memory.revision.conflict'))
    return true
  })
  client.receive({ type: 'memory_host_result', requestId: sent.requestId, epoch: 'owner', ok: false,
    error: memoryHostFailure(new MemoryDomainError('revision.conflict', 'Internal domain wording')) })
  await rejected
  client.close()
})

test('verified save notices remain transient, epoch-bound and separate from owner metadata', () => {
  const learned: string[][] = []
  const client = createRemoteMemoryChannel({ send() {}, onNotice: notice => { learned.push([...(notice.learned ?? [])]) } })
  const change = { type: 'memory_owner_change', protocol: 1, epoch: 'current', revision: 4, ids: [1], learned: ['已验证的新事实'] }
  client.receive(change)
  assert.equal(learned.length, 0, 'an unknown owner cannot publish a notice')
  client.receive({ ...state('current'), revision: 4 })
  client.receive({ ...change, epoch: 'replaced' })
  client.receive({ ...change, revision: 3 })
  client.receive(change)
  assert.deepEqual(learned, [['已验证的新事实']])
  assert.equal('learned' in client.state()!, false, 'source-sensitive notice text is not cached with owner readiness')
  client.close()
  client.receive(change)
  assert.equal(learned.length, 1)
})

test('context usage and projection notifications remain explicit and reject stale owner generations', () => {
  const contexts: Array<{ session: string, conversation: string | null, turn: number, pushed: Array<{ text: string, names: string[] }> }> = []
  let projections = 0
  const client = createRemoteMemoryChannel({ send() {}, onContextUsed: notice => contexts.push(notice), onProjection: () => { projections++ } })
  client.receive({ ...state('current'), revision: 3 })
  const context = { type: 'memory_owner_context_used', protocol: 1, epoch: 'current', revision: 3,
    session: 'native-session', conversation: 'host-conversation', turn: 2, at: 1234,
    pushed: [{ text: '周报每周五提交', names: ['周报'] }] }
  client.receive({ ...context, epoch: 'old' })
  client.receive(context)
  client.receive({ type: 'memory_owner_projection', protocol: 1, epoch: 'old', revision: 3 })
  client.receive({ type: 'memory_owner_projection', protocol: 1, epoch: 'current', revision: 3 })
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0]?.conversation, 'host-conversation')
  assert.deepEqual(contexts[0]?.pushed, [{ text: '周报每周五提交', names: ['周报'] }])
  assert.equal(projections, 1, 'same-revision projection changes are not lost to state deduplication')
  assert.equal('pushed' in client.state()!, false)
  client.close()
})
