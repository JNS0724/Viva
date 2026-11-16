import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'
import { memoryOriginalContentDigest } from '../plugins/memory/lib/context-recovery.ts'
import { eraseColdNativeCopies, PendingNativePublication } from '../plugins/memory/lib/native/maintenance.ts'
import { scratch } from './fixtures/scratch.js'

test('cold native derived erasure groups inbox replicas and retains independent and unauthenticated messages', async t => {
  const { dir, defer } = scratch(t, 'viva-native-derived-')
  const memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
  const options = { root: memoryRoot, hostNamespace: 'viva', fileMode: true,
    compute: () => null, route: () => null, quiesce: async () => {} }
  const owner = openMemoryOwner(options)
  const call = <K extends 'createFile' | 'readFile' | 'forgetFile'>(method: K, input: HostMemoryApi[K]['input']) =>
    owner.handleHost(method, input) as Promise<HostMemoryApi[K]['output']>
  const attemptA = randomUUID(), attemptB = randomUUID()
  const parentId = SessionId('derived-root'), childId = SessionId('derived-unknown-fork')
  const make = (kind: 'user' | 'viva-memory', text: string) => createUserMessage({
    source: { kind }, content: [{ type: 'text', text }],
  })
  const first = make('viva-memory', 'Old injection from the first source')
  const second = make('user', 'Host task brief from a separate second source')
  const equalIndependent = make('user', 'Old injection from the first source')
  const tampered = { ...second, content: [{ type: 'text' as const, text: 'Unverified third payload must remain present' }] }
  const session = Session.create(parentId)
  const audit = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [first, second, equalIndependent] })
  const shown = session.append('user/message', first, { surfaceOp: 'append' })
  const accepted = session.append('user/message', second, { surfaceOp: 'append' })
  const untouched = session.append('user/message', equalIndependent, { surfaceOp: 'append' })
  const prefix = session.snapshotEvents()
  const child = Session.fromRestore(childId, buildForkSeed(prefix, untouched.seq),
    { ...session.header, id: childId, isSeeded: true }, SessionLogOffset(prefix.length), 'detached')
  const untrusted = Session.create(SessionId('derived-unverified'))
  untrusted.append('user/message', tampered, { surfaceOp: 'append' })

  async function withStore<T>(work: (store: Context['sessionPersistence']) => Promise<T>) {
    const ctx = new Context(), plugin = await ctx.plugin(jsonl, { root, compression: 'zstd' })
    try { return await work(ctx.sessionPersistence) } finally { await plugin.dispose() }
  }
  const write = (session: Session, count = 0) => withStore(async store => {
    const writer = await store.create(session.header, { inheritedEventCount: SessionLogOffset(count) })
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  })
  const read = (id: SessionId) => withStore(async store => {
    const handle = await store.open(id, 'read')
    try { return (await handle.read()).events } finally { await handle.close() }
  })
  await write(session)
  await write(child, prefix.length)
  await write(untrusted)

  async function prepare(message: UserMessage, scope: string, operationId: string) {
    const original = 'Canonical independent file ' + scope
    const created = await call('createFile', { args: [{ operationId: randomUUID(), text: original }] })
    owner.initializeSession({ sessionId: scope })
    const packet = owner.runtime.handle({ op: 'file_read', session: scope, id: created.identity.id }, { session: scope, conversation: scope })
    assert.match(packet ?? '', /Canonical/u)
    await owner.registerDerived({ sessionId: scope, messageId: message.id, sourceIds: [], nativeUserSource: message.source.kind,
      contentDigest: memoryOriginalContentDigest(message) })
    const detail = await call('readFile', { args: [created.identity] })
    assert.ok(detail)
    await call('forgetFile', { args: [{ operationId, identity: created.identity, version: detail.version }] })
  }
  try {
    await owner.recover()
    await prepare(first, String(parentId), attemptA)
    await prepare(second, 'other-authorized-origin', attemptB)
  } finally { await owner.close() }

  const administration = openNativeOriginalMaintenance(memoryRoot, 'viva')
  assert.ok(administration)
  administration.close()
  const db = new DatabaseSync(join(memoryRoot, 'memory.db'))
  defer(() => db.close())
  db.exec(`CREATE TRIGGER fail_derived_receipt BEFORE UPDATE OF published ON owner_native_output_publications
    WHEN OLD.operation LIKE '%:derived-messages' BEGIN SELECT RAISE(ABORT, 'interrupted derived receipt'); END`)
  const erase = () => eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'),
    hostNamespace: 'viva', isCold: () => true, trace: { key: () => undefined, erase: () => assert.fail('no Viva trace copy for user messages') } })
  await assert.rejects(erase(), PendingNativePublication)
  assert.equal(db.prepare('SELECT count(*) n FROM owner_native_output_publications WHERE operation=? AND published=0')
    .get(attemptA + ':derived-messages')?.n, 1)
  db.exec('DROP TRIGGER fail_derived_receipt')
  await erase()
  await erase()
  for (const id of [parentId, childId]) {
    const events = await read(id)
    const grouped = events[audit.seq], installedFirst = events[shown.seq], installedSecond = events[accepted.seq]
    assert.ok(grouped?.type === 'agent/inbox/spliced' && installedFirst?.type === 'user/message' && installedSecond?.type === 'user/message')
    assert.deepEqual(grouped.data.inserted.map(item => item.content), [[], [], equalIndependent.content])
    assert.equal(installedFirst.data.id, first.id)
    assert.equal(installedSecond.data.id, second.id)
    assert.deepEqual(installedFirst.data.content, [])
    assert.deepEqual(installedSecond.data.content, [])
    assert.deepEqual(events[untouched.seq], untouched)
  }
  assert.deepEqual((await read(untrusted.id)).at(-1)?.data, tampered)
  assert.equal(db.prepare('SELECT erased FROM owner_native_derived_messages WHERE message=?').get(first.id)?.erased, 1)
  assert.equal(db.prepare('SELECT erased FROM owner_native_derived_messages WHERE message=?').get(second.id)?.erased, 0,
    'an unverified third payload keeps that evidence pending')
})
