import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteMemoryChannel } from '../src/backend/remote-memory-channel.ts'
import { memoryHostFailure } from '../src/memory/contracts/domain-error.ts'
import { MemoryDomainError } from '../src/memory/core/presentation.ts'
import { t } from '../src/shared/i18n/translate.ts'
import { MEMORY_HOST_PROTOCOL, parseHostMemoryCommand } from '../src/memory/contracts/host.ts'
const state = (epoch: string, status = 'ready') => ({ type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch, state: status, revision: 0, coreEpoch: 0 })
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
  await assert.rejects(client.call('createFile', { args: [{ operationId: '810754af-d984-4716-a31d-82bb7673109b', text: 'text' }] }), /unavailable/)
  const pending = client.call('getOperation', { operationId: '810754af-d984-4716-a31d-82bb7673109b' })
  const rejected = assert.rejects(pending, /disconnected/)
  client.processExited(); await rejected
})
test('JSON tuple transport restores only optional undefined slots and rejects arbitrary runtime calls', () => {
  assert.equal(parseHostMemoryCommand('profilePage', { args: [null] }).input !== null, true)
  assert.throws(() => parseHostMemoryCommand('close', { args: [] }), /Unknown/)
})

test('owner domain errors retain conflict identity and localized wording across IPC', async () => {
  let sent: Record<string, unknown> = {}
  const client = createRemoteMemoryChannel({ send: message => { sent = message as Record<string, unknown> } })
  client.receive(state('owner'))
  const pending = client.call('editFile', { args: [{ operationId: '810754af-d984-4716-a31d-82bb7673109b', text: 'replacement', identity: { kind: 'digest', workspace: 'personal', id: 'file' }, version: { contentRevision: 'before', usageVersion: 1, policyToken: 'policy' } }] })
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

test('revision-only notices remain transient, epoch-bound and separate from owner readiness', () => {
  const revisions: number[] = []
  const client = createRemoteMemoryChannel({ send() {}, onNotice: notice => { revisions.push(notice.revision) } })
  const change = { type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: 'current', revision: 4 }
  client.receive(change)
  assert.equal(revisions.length, 0, 'an unknown owner cannot publish a notice')
  client.receive({ ...state('current'), revision: 4 })
  client.receive({ ...change, protocol: MEMORY_HOST_PROTOCOL - 1 })
  client.receive({ ...change, ids: [1] })
  assert.equal(revisions.length, 0, 'old protocols and removed notice fields are rejected')
  client.receive({ ...change, epoch: 'replaced' })
  client.receive({ ...change, revision: 3 })
  client.receive(change)
  assert.deepEqual(revisions, [4])
  assert.deepEqual(client.state(), { ...state('current'), revision: 4 })
  client.close()
  client.receive(change)
  assert.equal(revisions.length, 1)
})
