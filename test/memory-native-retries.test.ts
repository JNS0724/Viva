import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry/types'
import { appendPluginRecord, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import { createNativeOutputAttempts } from '../src/memory/node/native-output-attempts.ts'
import { nativeEventDigest } from '../plugins/memory/lib/native/event-digest.ts'
import { NATIVE_OUTPUT_MARKER } from '../plugins/memory/lib/native/output-attempts.ts'
import { inspectNativeOutputWindow, projectNativeRetry } from '../plugins/memory/lib/native/project-native-outputs.ts'
import { eraseColdNativeCopies, PendingNativePublication } from '../plugins/memory/lib/native/maintenance.ts'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'
import { scratch } from './fixtures/scratch.js'

function retryLog() {
  const session = Session.create(SessionId(randomUUID()))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
  const marker = { id: randomUUID(), generation: 0, turn: 1, step: 1 }
  const floor = appendPluginRecord(session, NATIVE_OUTPUT_MARKER, marker) + 1
  const output = session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
  const retryId = randomUUID() as RetryId, secret = 'The provider echoed this private remembered paragraph.'
  const retry = session.append('llm/retry', { retryId, turn: 1, step: 1, provider: 'fixture', mode: 'normal', policyKey: 'fixture-policy',
    retry: 1, maxRetries: 3, delayMs: 1000, failure: { message: secret, code: 'HTTP_429', status: 429, providerRetryAfterMs: 1000 } })
  const started = session.append('llm/retry-started', { retryId, turn: 1, step: 1, retry: 1 })
  const nextMarker = { id: randomUUID(), generation: 0, turn: 1, step: 1 }
  const nextFloor = appendPluginRecord(session, NATIVE_OUTPUT_MARKER, nextMarker) + 1
  const independentOutput = session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
  const independent = session.append('llm/retry', { ...retry.data, retry: 2 })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session, attempt: { ...marker, session: String(session.id), floor }, output, retry, started, independent, secret,
    independentAttempt: { ...nextMarker, session: String(session.id), floor: nextFloor }, independentOutput }
}

test('native retry failure projection binds the proven attempt window and retains machine routing state', () => {
  const f = retryLog(), events = f.session.snapshotEvents()
  const window = inspectNativeOutputWindow(events, f.session.id, 0, f.attempt)
  assert.ok(window.marker && !window.ambiguous)
  assert.equal(window.event?.seq, f.output.seq)
  assert.deepEqual(window.retries, [f.retry])
  assert.deepEqual(projectNativeRetry(f.retry), { ...f.retry, data: { ...f.retry.data,
    failure: { ...f.retry.data.failure, message: 'Failure details were withdrawn.' } } })
  const fork = inspectNativeOutputWindow(events, 'unopened-fork', f.retry.seq, f.attempt)
  assert.ok(fork.marker && !fork.ambiguous)
  assert.deepEqual(fork.retries, [], 'a later parent retry is outside this fork’s inherited prefix')
  const next = inspectNativeOutputWindow(events, f.session.id, 0, f.independentAttempt)
  assert.ok(next.marker && !next.ambiguous)
  assert.deepEqual(next.retries, [f.independent])
  const changed = events.map(event => event.seq === f.retry.seq ? { ...f.retry, data: { ...f.retry.data, provider: 'other' } } : event)
  assert.deepEqual(inspectNativeOutputWindow(changed, f.session.id, 0, f.attempt), { marker: true, ambiguous: true })
})

for (const forked of [false, true]) {
  test(`cold retry erasure ${forked ? 'with an inherited fork' : 'in the original session'} resumes after publication interruption`, async t => {
    const { dir, defer } = scratch(t, 'viva-native-retry-')
    const memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions'), f = retryLog()
    const prefix = f.session.snapshotEvents(), inherited = SessionLogOffset(prefix.length), forkId = SessionId(randomUUID())
    const child = Session.create(forkId, prefix, { ...f.session.header, id: forkId, isSeeded: true }, inherited)
    async function withStore<T>(work: (store: Context['sessionPersistence']) => Promise<T>) {
      const context = new Context(), mounted = await context.plugin(jsonl, { root, compression: 'zstd' })
      try { return await work(context.sessionPersistence) } finally { await mounted.dispose() }
    }
    async function write(session: Session, count = SessionLogOffset(0)) {
      await withStore(async store => {
        const writer = await store.create(session.header, { inheritedEventCount: count })
        try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
      })
    }
    const read = (id: SessionId) => withStore(async store => {
      const reader = await store.open(id, 'read')
      try { return (await reader.read()).events } finally { await reader.close() }
    })
    await write(f.session)
    if (forked) await write(child, inherited)
    const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva',
      compute: () => null, route: () => null, quiesce: async () => {} })
    try {
      await owner.recover()
      const file = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: 'Canonical memory supporting this failed request.' }] }) as HostMemoryApi['createFile']['output']
      assert.match(owner.runtime.handle({ op: 'file_read', session: f.session.id, id: file.identity.id }, { session: f.session.id, conversation: f.session.id }) ?? '', /Canonical/u)
      const archive = new DatabaseSync(join(memoryRoot, 'memory.db'))
      try {
        const attempts = createNativeOutputAttempts(archive)
        attempts.record(f.attempt, owner.dispatch.snapshot(f.session.id))
        attempts.finish(f.attempt, { seq: f.output.seq, kind: 'attempt', digest: nativeEventDigest(f.output) })
        attempts.record(f.independentAttempt, { sources: [], epoch: 0, turnOnly: false })
        attempts.finish(f.independentAttempt, { seq: f.independentOutput.seq, kind: 'attempt', digest: nativeEventDigest(f.independentOutput) })
      } finally { archive.close() }
      const detail = await owner.handleHost('readFile', { args: [file.identity] }) as HostMemoryApi['readFile']['output']
      assert.ok(detail)
      await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: file.identity, version: detail.version }] })
    } finally { await owner.close() }
    const maintenance = openNativeOriginalMaintenance(memoryRoot, 'viva')
    assert.ok(maintenance)
    maintenance.close()
    const db = new DatabaseSync(join(memoryRoot, 'memory.db'))
    defer(() => db.close())
    db.exec(`CREATE TRIGGER fail_retry_publication BEFORE UPDATE OF published ON owner_native_output_publications
      BEGIN SELECT RAISE(ABORT, 'interrupted retry erasure receipt'); END`)
    const erase = () => eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'), hostNamespace: 'viva',
      isCold: () => true, trace: { key: () => undefined, erase: () => assert.fail('this fixture has no trace') } })
    await assert.rejects(erase(), PendingNativePublication)
    const pending = db.prepare('SELECT payload FROM owner_native_output_publications WHERE published=0').all()
    assert.equal(pending.length, 1)
    assert.ok(!JSON.stringify(pending).includes(f.secret))
    assert.equal(db.prepare('SELECT 1 FROM owner_native_output_erased WHERE attempt=?').get(f.attempt.id), undefined)
    db.exec('DROP TRIGGER fail_retry_publication')
    await erase()
    await erase()
    for (const id of [f.session.id, ...forked ? [child.id] : []]) {
      const events = await read(id)
      const retry = events[f.retry.seq] as SessionEvent<'llm/retry'>
      assert.deepEqual(retry, projectNativeRetry(f.retry))
      assert.deepEqual(events[f.started.seq], f.started)
      assert.deepEqual(events[f.independent.seq], f.independent)
      assert.deepEqual(events[f.independentOutput.seq], f.independentOutput)
    }
    assert.ok(db.prepare('SELECT 1 FROM owner_native_output_erased WHERE attempt=?').get(f.attempt.id))
    assert.equal(db.prepare('SELECT 1 FROM owner_native_output_erased WHERE attempt=?').get(f.independentAttempt.id), undefined)
  })
}
