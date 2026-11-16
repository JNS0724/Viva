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
import { memoryOriginalContentDigest, memoryRecoveryMessageHash } from '../plugins/memory/lib/context-recovery.ts'
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
  const second = createUserMessage({ source: { kind: 'subagent-settled', form: 'notice',
    summary: 'Source-derived title in the native notice', senderSessionId: parentId },
    content: [{ type: 'text', text: 'Host task brief from a separate second source' }] })
  const noticeOnly = createUserMessage({ source: { kind: 'subagent-settled', form: 'notice',
    summary: 'Source-derived notice without content blocks', senderSessionId: parentId }, content: [] })
  const equalIndependent = make('user', 'Old injection from the first source')
  const tampered = { ...second, content: [{ type: 'text' as const, text: 'Unverified third payload must remain present' }] }
  const session = Session.create(parentId)
  const audit = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [first, second, noticeOnly, equalIndependent] })
  const shown = session.append('user/message', first, { surfaceOp: 'append' })
  const accepted = session.append('user/message', second, { surfaceOp: 'append' })
  const notice = session.append('user/message', noticeOnly, { surfaceOp: 'append' })
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
      contentDigest: memoryOriginalContentDigest(message), nativeMessageDigest: memoryRecoveryMessageHash(message) })
    if (message === second) await owner.registerDerived({ sessionId: scope, messageId: noticeOnly.id, sourceIds: [],
      nativeUserSource: noticeOnly.source.kind, nativeMessageDigest: memoryRecoveryMessageHash(noticeOnly),
      contentDigest: memoryOriginalContentDigest(noticeOnly) })
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
    assert.deepEqual(grouped.data.inserted.map(item => item.content), [[], [], [], equalIndependent.content])
    assert.equal(installedFirst.data.id, first.id)
    assert.equal(installedSecond.data.id, second.id)
    assert.deepEqual(installedFirst.data.content, [])
    assert.deepEqual(installedSecond.data.content, [])
    assert.ok(installedSecond.data.source.kind === 'subagent-settled')
    assert.equal(installedSecond.data.source.summary, '')
    assert.equal(grouped.data.inserted[1]!.source.kind, 'subagent-settled')
    assert.doesNotMatch(JSON.stringify([grouped, installedSecond]), /Source-derived title/u)
    const emptyNotice = events[notice.seq]
    assert.ok(emptyNotice?.type === 'user/message' && emptyNotice.data.source.kind === 'subagent-settled')
    assert.equal(emptyNotice.data.source.summary, '')
    assert.deepEqual(events[untouched.seq], untouched)
  }
  assert.deepEqual((await read(untrusted.id)).at(-1)?.data, tampered)
  assert.equal(db.prepare('SELECT erased FROM owner_native_derived_messages WHERE message=?').get(first.id)?.erased, 1)
  assert.equal(db.prepare('SELECT erased FROM owner_native_derived_messages WHERE message=?').get(second.id)?.erased, 0,
    'an unverified third payload keeps that evidence pending')
  assert.ok(db.prepare('SELECT 1 FROM owner_native_cleanup_receipts WHERE operation=?').get(attemptA))
  assert.equal(db.prepare('SELECT 1 FROM owner_native_cleanup_receipts WHERE operation=?').get(attemptB), undefined)
})

for (const unknownFailure of [false, true]) test(`cold recovery restores a flushed fork receipt ${unknownFailure ? 'while an unattributed error stays pending' : 'when its parent has only the attempt marker'}`, async t => {
  const { createAssistantMessage } = await import('@deepseek-ai/dsh-llm')
  const { appendPluginRecord } = await import('@deepseek-ai/dsh-session')
  const { NATIVE_OUTPUT_MARKER } = await import('../plugins/memory/lib/native/output-attempts.ts')
  const { createNativeOutputAttempts } = await import('../src/memory/node/native-output-attempts.ts')
  const { dir } = scratch(t, 'viva-native-forked-endpoint-')
  const memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
  const parent = Session.create(SessionId(randomUUID())), childId = SessionId(randomUUID())
  const marker = { id: randomUUID(), generation: 0, turn: 1, step: 1 }
  parent.append('turn/start', { turn: 1 })
  parent.append('step/start', { turn: 1, step: 1 })
  const floor = appendPluginRecord(parent, NATIVE_OUTPUT_MARKER, marker) + 1
  const secret = 'The inherited model response reached only the child artifact.'
  const terminal = parent.append('assistant/message', { turn: 1, step: 1,
    message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: secret }] }), stream: [],
  }, { surfaceOp: 'append' })
  const prefix = parent.snapshotEvents(), inherited = SessionLogOffset(prefix.length)
  const child = Session.create(childId, prefix, { ...parent.header, id: childId, isSeeded: true }, inherited)
  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva', fileMode: true,
    compute: () => null, route: () => null, quiesce: async () => {} })
  try {
    await owner.recover()
    owner.initializeSession({ sessionId: String(parent.id) })
    const file = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: 'Canonical file underlying the response.' }] }) as HostMemoryApi['createFile']['output']
    assert.match(owner.runtime.handle({ op: 'file_read', session: parent.id, id: file.identity.id }, { session: parent.id, conversation: parent.id }) ?? '', /Canonical/)
    const db = new DatabaseSync(join(memoryRoot, 'memory.db'))
    try { createNativeOutputAttempts(db).record({ ...marker, session: parent.id, floor }, owner.dispatch.snapshot(parent.id)) }
    finally { db.close() }
    const detail = await owner.handleHost('readFile', { args: [file.identity] }) as HostMemoryApi['readFile']['output']
    assert.ok(detail)
    await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: file.identity, version: detail.version }] })
  } finally { await owner.close() }

  const parentPrefix = Session.fromRestore(parent.id, prefix.slice(0, floor), parent.header, SessionLogOffset(0), 'detached')
  if (unknownFailure) {
    const compactionId = randomUUID() as import('@deepseek-ai/dsh-compaction').CompactionId
    parentPrefix.append('compaction/start', { compactionId, turn: 1 })
    parentPrefix.append('compaction/end', { compactionId, turn: 1, error: 'An unverified summarizer echoed private content.' })
  }
  const context = new Context(), mounted = await context.plugin(jsonl, { root, compression: 'zstd' })
  try {
    const original = await context.sessionPersistence.create(parent.header)
    try { await original.append(parentPrefix.snapshotEvents()); await original.flush() } finally { await original.close() }
    const fork = await context.sessionPersistence.create(child.header, { inheritedEventCount: inherited })
    try { await fork.append(child.snapshotEvents()); await fork.flush() } finally { await fork.close() }
  } finally { await mounted.dispose() }
  await eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'), hostNamespace: 'viva',
    isCold: () => true, trace: { key: () => undefined, erase: () => assert.fail('this fixture has no trace') } })
  const db = new DatabaseSync(join(memoryRoot, 'memory.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT result FROM owner_native_output_attempts WHERE id=?').get(marker.id)
    const result = JSON.parse(String(row?.result)) as { state: string, terminal: { seq: number } }
    assert.equal(result.state, 'settled')
    assert.equal(result.terminal.seq, terminal.seq)
    assert.ok(db.prepare('SELECT 1 FROM owner_native_output_erased WHERE attempt=?').get(marker.id))
    assert.equal(db.prepare('SELECT count(*) AS total FROM owner_native_cleanup_receipts').get()?.total, unknownFailure ? 0 : 1)
  } finally { db.close() }
  const verify = new Context(), installed = await verify.plugin(jsonl, { root })
  try {
    const handle = await verify.sessionPersistence.open(childId, 'read')
    try { assert.doesNotMatch(JSON.stringify((await handle.read()).events), /inherited model response/) } finally { await handle.close() }
  } finally { await installed.dispose() }
})

test('cold recovery restores a tool receipt flushed only in an inherited fork and completes erasure', async t => {
  const { createAssistantMessage, createToolResultMessage, ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const { createNativeToolReads } = await import('../src/memory/node/native-tool-reads.ts')
  const { nativeEventDigest } = await import('../plugins/memory/lib/native/event-digest.ts')
  const { dir } = scratch(t, 'viva-native-forked-tool-endpoint-')
  const memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
  const parent = Session.create(SessionId(randomUUID())), childId = SessionId(randomUUID())
  const block = { type: 'tool-call' as const, id: ToolCallId(randomUUID()), name: 'memory_read', arguments: '{}' }
  parent.append('turn/start', { turn: 1 })
  parent.append('step/start', { turn: 1, step: 1 })
  parent.append('assistant/message', { turn: 1, step: 1,
    message: createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [block] }), stream: [],
  }, { surfaceOp: 'append' })
  const call = parent.append('tool/call', { turn: 1, step: 1, callId: block.id, name: block.name, arguments: block.arguments })
  const secret = 'The inherited private tool result exists only in the fork.'
  const terminal = parent.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: block.id, content: [{ type: 'text', text: secret }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  parent.append('step/end', { turn: 1, step: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const prefix = parent.snapshotEvents(), inherited = SessionLogOffset(prefix.length)
  const child = Session.create(childId, prefix, { ...parent.header, id: childId, isSeeded: true }, inherited)
  const identity = { id: randomUUID(), session: String(parent.id), callId: String(block.id), generation: 0,
    turn: 1, step: 1, seq: call.seq, digest: nativeEventDigest(call) }
  const owner = openMemoryOwner({ root: memoryRoot, hostNamespace: 'viva', fileMode: true,
    compute: () => null, route: () => null, quiesce: async () => {} })
  try {
    await owner.recover()
    const file = await owner.handleHost('createFile', { args: [{ operationId: randomUUID(), text: 'Canonical file underlying the tool result.' }] }) as HostMemoryApi['createFile']['output']
    assert.match(owner.runtime.handle({ op: 'file_read', session: parent.id, id: file.identity.id }, { session: parent.id, conversation: parent.id }) ?? '', /Canonical/u)
    const db = new DatabaseSync(join(memoryRoot, 'memory.db'))
    try {
      const evidence = owner.dispatch.snapshot(parent.id)
      createNativeToolReads(db).record(identity, evidence.files ?? [], evidence.sources)
    } finally { db.close() }
    const detail = await owner.handleHost('readFile', { args: [file.identity] }) as HostMemoryApi['readFile']['output']
    assert.ok(detail)
    await owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: file.identity, version: detail.version }] })
  } finally { await owner.close() }

  const context = new Context(), mounted = await context.plugin(jsonl, { root, compression: 'zstd' })
  try {
    const original = await context.sessionPersistence.create(parent.header)
    try { await original.append(prefix.slice(0, terminal.seq)); await original.flush() } finally { await original.close() }
    const fork = await context.sessionPersistence.create(child.header, { inheritedEventCount: inherited })
    try { await fork.append(child.snapshotEvents()); await fork.flush() } finally { await fork.close() }
  } finally { await mounted.dispose() }
  const erase = () => eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storages'), hostNamespace: 'viva',
    isCold: () => true, trace: { key: () => undefined, erase: () => assert.fail('this fixture has no trace') } })
  await erase()
  await erase()
  const db = new DatabaseSync(join(memoryRoot, 'memory.db'), { readOnly: true })
  try {
    const saved = JSON.parse(String(db.prepare('SELECT result FROM owner_native_tool_calls WHERE id=?').get(identity.id)?.result)) as { seq: number }
    assert.equal(saved.seq, terminal.seq)
    assert.ok(db.prepare('SELECT 1 FROM owner_native_output_erased WHERE attempt=?').get(identity.id))
  } finally { db.close() }
  const verify = new Context(), installed = await verify.plugin(jsonl, { root })
  try {
    for (const id of [parent.id, childId]) {
      const handle = await verify.sessionPersistence.open(id, 'read')
      try { assert.doesNotMatch(JSON.stringify((await handle.read()).events), /inherited private tool result/u) }
      finally { await handle.close() }
    }
  } finally { await installed.dispose() }
})

test('a native participant waits for the memory WAL reader and binds its receipt to the exact plan', async t => {
  const { createNativeErasureReceipts } = await import('../src/memory/node/native-erasure-receipts.ts')
  const { dir } = scratch(t, 'viva-native-participant-checkpoint-')
  const file = join(dir, 'participant.db'), db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=0;
    CREATE TABLE owner_file_native_erasures(operation TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE original(text TEXT); INSERT INTO original VALUES('retired private text');`)
  const operation = randomUUID()
  db.prepare('INSERT INTO owner_file_native_erasures VALUES (?,?)').run(operation, '{"range":"first"}')
  const receipts = createNativeErasureReceipts(db)
  const reader = new DatabaseSync(file, { readOnly: true })
  try {
    reader.exec('BEGIN')
    assert.equal(reader.prepare('SELECT text FROM original').get()?.text, 'retired private text')
    db.exec('UPDATE original SET text=NULL')
    assert.throws(() => receipts.acknowledge(operation, 'a'.repeat(64)), /durable memory checkpoint/)
    assert.equal(receipts.complete(operation), false)
    reader.exec('ROLLBACK')
    receipts.acknowledge(operation, 'a'.repeat(64))
    assert.equal(receipts.complete(operation), true)
    db.prepare('UPDATE owner_file_native_erasures SET payload=? WHERE operation=?').run('{"range":"changed"}', operation)
    assert.equal(receipts.complete(operation), false, 'a modified plan cannot borrow the earlier receipt')
  } finally { reader.close(); db.close() }
})
