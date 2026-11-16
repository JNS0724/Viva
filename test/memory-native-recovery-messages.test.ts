import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import type { HostMemoryApi } from '../src/memory/contracts/host.ts'
import { memoryOriginalContentDigest, memoryRecoveryCandidates, memorySessionSurfaceHash, planMemoryContextRecovery } from '../plugins/memory/lib/context-recovery.ts'
import { createSessionIngestion } from '../plugins/memory/lib/ingestion.ts'
import { openNativeOriginalMaintenance } from '../src/memory/node/native-original-maintenance.ts'
import { eraseColdNativeCopies, PendingNativePublication } from '../plugins/memory/lib/native/maintenance.ts'
import { scratch } from './fixtures/scratch.js'

for (const tamperMarker of [false, true]) test(`cold recovery markers ${tamperMarker ? 'withhold a changed replica' : 'retain disjoint originals'} through two erasures and lost publication receipt`, async t => {
  const { dir, defer } = scratch(t, 'viva-recovery-native-')
  const memoryRoot = join(dir, 'memory'), root = join(dir, 'sessions')
  const options = { root: memoryRoot, hostNamespace: 'viva', fileMode: true,
    compute: () => null, route: () => null, quiesce: async () => {} }
  const parentId = SessionId('recovery-root'), forkId = SessionId('recovery-unadmitted-fork'), thirdId = SessionId('recovery-unverified-fork')
  const first = 'First source erased phrase'
  const second = 'Second source erased phrase'
  const tail = 'The disjoint same-message tail survives'
  const unrelated = 'Another independently retained user message'
  const text = [first, second, tail].join(' / ')
  const session = Session.create(parentId)
  const native = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  const independent = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: unrelated }] }), { surfaceOp: 'append' })
  const owner = openMemoryOwner(options)
  const identityOf = (documentId: string, workspace: string) => ({ kind: 'digest' as const, id: documentId, workspace })
  const targets: ReturnType<typeof identityOf>[] = []
  async function withStore<T>(work: (store: Context['sessionPersistence']) => Promise<T>) {
    const ctx = new Context(), mounted = await ctx.plugin(jsonl, { root, compression: 'zstd' })
    try { return await work(ctx.sessionPersistence) } finally { await mounted.dispose() }
  }
  const write = (session: Session, inherited = 0) => withStore(async store => {
    const writer = await store.create(session.header, { inheritedEventCount: SessionLogOffset(inherited) })
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  })
  const eventsOf = (id: SessionId) => withStore(async store => {
    const reader = await store.open(id, 'read')
    try { return (await reader.read()).events } finally { await reader.close() }
  })
  let markerSeq = -1
  let thirdHashMessage: unknown
  try {
    await owner.recover()
    const sourceIds: string[] = []
    for (const event of [native, independent]) {
      const result = await owner.receiveSource({ sessionId: parentId, messageId: event.data.id, text: event.data.content[0]!.type === 'text' ? event.data.content[0]!.text : '',
        contentDigest: memoryOriginalContentDigest(event.data), at: Date.now(), timezone: 'UTC', turn: 0, step: 0, admitted: true, inherited: false, live: false })
      sourceIds.push(result.sourceId)
    }
    const store = openMemoryStore(join(memoryRoot, 'memory.db'))
    try {
      const source = store.readSource(sourceIds[0]!)!
      const workspace = memorySourceWorkspace(source)
      const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, source(id) {
        const current = store.readSource(id)
        return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
      } })
      for (const [index, excerpt] of [first, second].entries()) {
        const start = text.indexOf(excerpt)
        const created = documents.commit({ operationId: randomUUID(), workspace, path: `digest/wiki/recovery-${index}.md`, expectedRevision: null,
          action: 'CREATE', markdown: excerpt, sources: [{ id: source.id, token: memorySourceToken(source), spans: [{ start, end: start + excerpt.length }] }], reads: [] })
        targets.push(identityOf(created.documentId, workspace))
      }
    } finally { store.close() }
    const baseSurfaceHash = memorySessionSurfaceHash(session)
    const ticket = await owner.prepareContextRecovery({ sessionId: parentId, baseSurfaceHash,
      candidates: memoryRecoveryCandidates(session).map(({ text, ...item }) => ({ ...item, content: text })) })
    const plan = planMemoryContextRecovery(session, ticket.ticketId, ticket.retainedMessageIds)
    owner.bindContextRecovery({ ticketId: ticket.ticketId, replacementMessageId: plan.message.id, replacementHash: plan.replacementHash })
    markerSeq = session.append([plan.input])[0]!.seq
    await write(session)
    await owner.commitContextRecovery({ ticketId: ticket.ticketId, baseSurfaceHash, replacementMessageId: plan.message.id, replacementHash: plan.replacementHash, persisted: true }, () => true)
    const prefix = session.snapshotEvents()
    const child = Session.fromRestore(forkId, buildForkSeed(prefix, prefix.at(-1)!.seq),
      { ...session.header, id: forkId, isSeeded: true }, SessionLogOffset(prefix.length), 'detached')
    await write(child, prefix.length)
    if (tamperMarker) {
      const unverified = prefix.map(event => event.seq === markerSeq && event.type === 'user/message'
        ? { ...event, data: { ...event.data, content: [{ type: 'text' as const, text: 'Unverified preamble' }, ...event.data.content.slice(1)] } } : event)
      const third = Session.fromRestore(thirdId, buildForkSeed(unverified, unverified.at(-1)!.seq),
        { ...session.header, id: thirdId, isSeeded: true }, SessionLogOffset(prefix.length), 'detached')
      thirdHashMessage = third.snapshotEvents()[markerSeq]!.data
      await write(third, prefix.length)
    }
  } finally { await owner.close() }

  const operationIds: string[] = []
  const forget = async (target: ReturnType<typeof identityOf>) => {
    const owner = openMemoryOwner(options)
    try {
      await owner.recover()
      const detail = await owner.handleHost('readFile', { args: [target] }) as HostMemoryApi['readFile']['output']
      assert.ok(detail)
      const id = randomUUID()
      operationIds.push(id)
      await owner.handleHost('forgetFile', { args: [{ operationId: id, identity: target, version: detail.version }] })
    } finally { await owner.close() }
  }
  const erase = () => eraseColdNativeCopies({ memoryRoot, sessionsRoot: root, storageRoot: join(dir, 'storage'), hostNamespace: 'viva',
    isCold: () => true, trace: { key: () => undefined, erase: () => assert.fail('recovery markers have no trace') } })
  await forget(targets[0]!)
  openNativeOriginalMaintenance(memoryRoot, 'viva')!.close()
  const db = new DatabaseSync(join(memoryRoot, 'memory.db'))
  defer(() => db.close())
  db.exec(`CREATE TRIGGER fail_recovery_publication BEFORE UPDATE OF published ON owner_native_output_publications
    WHEN OLD.operation LIKE '%:recovery-messages' BEGIN SELECT RAISE(ABORT, 'lost recovery receipt'); END`)
  await assert.rejects(erase(), PendingNativePublication)
  db.exec('DROP TRIGGER fail_recovery_publication')
  await erase()
  for (const id of [parentId, forkId]) {
    const first = await eventsOf(id)
    assert.doesNotMatch(JSON.stringify(first), /First source erased phrase/u)
    assert.match(JSON.stringify(first), /Second source erased phrase/u)
  }
  await forget(targets[1]!)
  await erase()
  await erase()
  for (const id of [parentId, forkId]) {
    const events = await eventsOf(id), marker = events[markerSeq]
    assert.ok(marker?.type === 'user/message' && marker.data.source.kind === 'viva-memory-recovery')
    assert.doesNotMatch(JSON.stringify(events), /First source erased phrase|Second source erased phrase/u)
    assert.match(JSON.stringify(marker.data.content), new RegExp(tail))
    assert.match(JSON.stringify(marker.data.content), new RegExp(unrelated))
    assert.deepEqual(events[independent.seq], independent)
    assert.ok(db.prepare('SELECT 1 FROM owner_native_surface_invalidations WHERE session=?').get(id))
  }
  assert.equal(db.prepare('SELECT count(*) n FROM owner_native_recovery_erased').get()?.n, tamperMarker ? 0 : 2)
  if (tamperMarker) assert.deepEqual((await eventsOf(thirdId))[markerSeq]!.data, thirdHashMessage,
    'a structurally valid third payload is retained and keeps the range cleanup pending')
  const resumedOwner = openMemoryOwner(options)
  try {
    await resumedOwner.recover()
    const native = await withStore(async store => {
      const handle = await store.open(parentId, 'read')
      try { return Session.fromRestore(parentId, (await handle.read()).events, handle.header, handle.inheritedEventCount, 'detached') }
      finally { await handle.close() }
    })
    const intake = createSessionIngestion(resumedOwner, async session => {
      return withStore(async store => {
        const writer = await store.open(session.id, 'write')
        try {
          const stored = (await writer.read()).events
          await writer.append(session.snapshotEvents(SessionLogOffset(stored.length)))
          await writer.flush()
          return true
        } finally { await writer.close() }
      })
    })
    await intake.recoverContext(native)
    await intake.synchronize(native)
    assert.equal(resumedOwner.nativeContextRewritten(parentId), false)
    assert.equal(resumedOwner.contextGeneration(parentId), 2)
    assert.match(JSON.stringify(native.deriveMessages()), new RegExp(unrelated))
    assert.doesNotMatch(JSON.stringify(native.deriveMessages()), /First source erased phrase|Second source erased phrase/u)
  } finally { await resumedOwner.close() }

})
