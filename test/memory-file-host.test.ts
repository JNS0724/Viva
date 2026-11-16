import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { createVivaMemoryClient } from '../src/backend/memory-client.ts'
import { registerRuntimeMemoryIpc } from '../src/backend/memory-ipc.ts'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import type { RawIpc } from '../src/shared/ipc-contract.ts'
import type { HostMemoryCaller, HostMemoryMethod, HostMemoryApi } from '../src/memory/contracts/host.ts'
import { memoryFileMutationResult } from '../src/memory/contracts/file-management.ts'
import type { MemoryHostEffect } from '../src/memory/contracts/service.ts'

async function fixture(t: TestContext, fileMode = true) {
  const { dir, defer } = scratch(t, 'memory-file-host-')
  const options = { root: dir, hostNamespace: 'viva-test', dailyNotes: true, fileMode,
    compute: () => null, route: () => null, quiesce: async () => {} }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), sourceId = randomUUID(), text = 'The report is due Friday. Tea is served on Monday.'
  await owner.receiveSource({ sessionId: session, messageId: sourceId, text, at: Date.now(), timezone: 'UTC',
    turn: 1, step: 1, admitted: true, inherited: false })
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const source = store.readSource(sourceId)!, workspace = memorySourceWorkspace(source)
  const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, source(id) {
    const current = store.readSource(id)
    return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
  } })
  const created = documents.commit({ operationId: randomUUID(), workspace, path: 'digest/wiki/report.md', expectedRevision: null,
    action: 'CREATE', markdown: 'Friday report', sources: [{ id: sourceId, token: memorySourceToken(source), spans: [{ start: 0, end: 25 }] }], reads: [] })
  // The trusted bridge authenticates the caller; the fixture exercises its typed client contract.
  const call: HostMemoryCaller = <M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input']) =>
    owner.handleHost(method, input) as Promise<HostMemoryApi[M]['output']>
  const client = createVivaMemoryClient(call)
  const identity = { kind: 'digest' as const, workspace, id: created.documentId }
  return { get owner() { return owner }, client, store, documents, created, identity, session, sourceId,
    async reopen(beforeRecovery?: () => void) { await owner.close(); owner = openMemoryOwner(options); beforeRecovery?.(); await owner.recover() } }
}

async function aborted(signal: AbortSignal) {
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('send barrier did not request cancellation')), 2000)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

test('trusted file management can re-enable a disabled digest while model reads stay blocked', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  assert.ok(before)
  assert.equal((await f.client.listFiles({ kind: 'digest' })).items.length, 1)
  const stopped = await f.client.setFileEnabled({ operationId: randomUUID(), identity: f.identity, version: before.version, enabled: false })
  memoryFileMutationResult.parse(stopped)
  assert.equal(f.owner.runtime.readDocument!(f.identity.workspace, before.path), null)
  const disabled = (await f.client.readFile(f.identity))!
  assert.ok(disabled, 'management bypasses use restrictions only')
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.markdown, before.markdown)
  assert.equal((await f.client.listFiles({ state: 'disabled' })).items.length, 1)
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: f.identity, version: disabled.version, enabled: true })
  assert.equal(f.owner.runtime.readDocument!(f.identity.workspace, before.path)?.markdown, before.markdown)
})

test('file writes drain transport and invalidate captured sessions before their durable completion', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  f.owner.dispatch.recordFiles(f.session, [{ workspace: f.identity.workspace, id: f.identity.id, path: before.path,
    revision: before.version.contentRevision, usageVersion: before.version.usageVersion, policyToken: before.version.policyToken }])
  const permit = f.owner.acquireSend(randomUUID(), { session: f.session }, 'request using Friday report')
  const operationId = randomUUID()
  const pending = f.client.setFileEnabled({ operationId, identity: f.identity, version: before.version, enabled: false })
  try {
    await aborted(permit.signal)
    assert.equal((await f.client.readFile(f.identity))?.enabled, true)
    const operation = await f.owner.handleHost('getOperation', { operationId }) as { state: string }
    assert.equal(operation.state, 'running')
  } finally { permit.settled() }
  await pending
  assert.throws(() => f.owner.acquireSend(randomUUID(), { session: f.session }, 'stale retry'), /denied/)
  const effects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  assert.equal(effects.length, 1)
  assert.equal(effects[0]!.causeOperationId, operationId)
  assert.ok(effects[0]!.sessions?.includes(f.session))
  assert.ok(effects[0]!.sources.some(source => source.sourceId === f.sourceId))
  assert.equal(effects[0]!.memoryIds, undefined)
})

test('same file operation replays its receipt after restart; changed input conflicts and outbox is not duplicated', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const input = { operationId: randomUUID(), identity: f.identity, version: before.version, enabled: false }
  const receipt = await f.client.setFileEnabled(input)
  await f.reopen()
  assert.deepEqual(await f.client.setFileEnabled(input), receipt)
  assert.equal((await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]).length, 1)
  await assert.rejects(f.client.setFileEnabled({ ...input, enabled: true }), { code: 'operation.conflict' })
  await assert.rejects(f.client.setFileEnabled({ ...input, version: { ...input.version, policyToken: 'changed' } }), { code: 'operation.conflict' })
})

test('file management no-op validates CAS and stores a receipt without creating a new revision', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const input = { operationId: randomUUID(), identity: f.identity, version: before.version, enabled: true }
  const count = () => Number(f.store.db.prepare('SELECT count(*) AS n FROM memory_document_revisions').get()!.n)
  const revisions = count(), result = await f.client.setFileEnabled(input)
  assert.equal(count(), revisions)
  assert.equal(result.usageVersion, before.version.usageVersion)
  assert.deepEqual(await f.client.setFileEnabled(input), result)
  await assert.rejects(f.client.setFileEnabled({ ...input, operationId: randomUUID(), version: { ...before.version, policyToken: 'stale' } }), { code: 'revision.conflict' })
})

test('host undo binds the specific semantic edit, survives a stop and does not become redo', async t => {
  const f = await fixture(t), original = f.documents.read(f.identity.workspace, f.created.path)!
  const changed = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: original.path,
    expectedRevision: original.revision, action: 'REFINE', markdown: 'The Friday report.', sources: original.sources, reads: [] })
  const current = (await f.client.readFile(f.identity))!
  assert.equal(current.actions.undo?.changeId, changed.operationId)
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: f.identity, version: current.version, enabled: false })
  const stopped = (await f.client.readFile(f.identity))!
  assert.equal(stopped.actions.undo?.changeId, changed.operationId)
  await assert.rejects(f.client.undoFile({ operationId: randomUUID(), identity: f.identity, version: stopped.version, changeId: 'different-change' }), { code: 'revision.conflict' })
  const command = { operationId: randomUUID(), identity: f.identity, version: stopped.version, changeId: changed.operationId }
  const receipt = await f.client.undoFile(command)
  const restored = (await f.client.readFile(f.identity))!
  assert.equal(restored.markdown, original.markdown)
  assert.equal(restored.enabled, false)
  assert.equal(restored.actions.undo, null)
  assert.deepEqual(await f.client.undoFile(command), receipt)
})


test('recovery rejects an old policy after another digest corrects the target without changing its content revision', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const command = { operationId: randomUUID(), identity: f.identity, version: before.version, enabled: true }
  const original = f.documents.read(f.identity.workspace, before.path)!
  const replacement = f.documents.commit({ operationId: randomUUID(), workspace: original.workspace, path: 'digest/wiki/revised-report.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Draft report', sources: original.sources, reads: [] })
  f.store.db.exec(`CREATE TRIGGER interrupt_document_receipt BEFORE INSERT ON memory_document_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated interruption before document receipt'); END`)
  await assert.rejects(f.client.setFileEnabled(command), /simulated interruption/)
  f.store.db.exec('DROP TRIGGER interrupt_document_receipt')
  f.documents.commit({ operationId: randomUUID(), workspace: original.workspace, path: replacement.path,
    expectedRevision: replacement.revision, action: 'CORRECT', markdown: 'Revised Friday report', sources: original.sources, reads: [],
    corrections: [{ path: original.path, revision: original.revision, startLine: 1, endLine: 1,
      text: original.markdown, condition: '', time: '' }] })
  const corrected = (await f.client.readFile(f.identity))!
  assert.equal(corrected.version.contentRevision, before.version.contentRevision)
  assert.equal(corrected.version.usageVersion, before.version.usageVersion)
  assert.notEqual(corrected.version.policyToken, before.version.policyToken)
  // The owner replays the document journal inside the authorized command after source recovery.
  await f.reopen()
  assert.equal(f.documents.receipt(f.identity.workspace, command.operationId), null)
  await assert.rejects(f.client.setFileEnabled(command), { code: 'revision.conflict' })
  assert.equal((await f.owner.handleHost('getOperation', { operationId: command.operationId }) as { state: string }).state, 'failed')
})

test('restart completes the host outbox once after the document receipt commits and the owner transaction fails', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const command = { operationId: randomUUID(), identity: f.identity, version: before.version, enabled: false }
  f.store.db.exec(`CREATE TRIGGER interrupt_owner_completion BEFORE UPDATE ON owner_operations
    WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'simulated owner interruption'); END`)
  await assert.rejects(f.client.setFileEnabled(command), /simulated owner interruption/)
  assert.ok(f.documents.receipt(f.identity.workspace, command.operationId))
  assert.deepEqual(await f.owner.handleHost('pendingHostEffects', {}), [])
  f.store.db.exec('DROP TRIGGER interrupt_owner_completion')
  await f.reopen()
  const receipt = await f.client.setFileEnabled(command)
  assert.equal(receipt.action, 'DISABLE')
  const [effect, extra] = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  assert.equal(extra, undefined)
  assert.equal(effect?.causeOperationId, command.operationId)
  const operation = () => f.owner.handleHost('getOperation', { operationId: command.operationId }) as Promise<{ state: string, cleanup: string }>
  assert.equal((await operation()).state, 'completed')
  assert.equal((await operation()).cleanup, 'pending')
  await f.owner.handleHost('ackHostEffect', { effectId: effect!.effectId, causeOperationId: effect!.causeOperationId, revision: effect!.revision })
  assert.equal((await operation()).cleanup, 'complete')
  assert.deepEqual(await f.client.setFileEnabled(command), receipt)
  assert.deepEqual(await f.owner.handleHost('pendingHostEffects', {}), [])
})


test('undo after file replacement recovers under the original policy and publishes the same receipt', async t => {
  const f = await fixture(t), original = f.documents.read(f.identity.workspace, f.created.path)!
  const changed = f.documents.commit({ operationId: randomUUID(), workspace: original.workspace, path: original.path,
    expectedRevision: original.revision, action: 'REFINE', markdown: 'A clarified Friday report', sources: original.sources, reads: [] })
  const current = (await f.client.readFile(f.identity))!
  const command = { operationId: randomUUID(), identity: f.identity, version: current.version, changeId: changed.operationId }
  f.store.db.exec(`CREATE TRIGGER interrupt_document_receipt BEFORE INSERT ON memory_document_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated interruption after file replacement'); END`)
  await assert.rejects(f.client.undoFile(command), /simulated interruption/)
  assert.equal(await f.client.readFile(f.identity), null, 'an unfinished file plan stays quarantined')
  f.store.db.exec('DROP TRIGGER interrupt_document_receipt')
  await f.reopen()
  const receipt = await f.client.undoFile(command)
  assert.equal(receipt.contentRevision, original.revision)
  assert.equal((await f.client.readFile(f.identity))?.markdown, original.markdown)
  assert.deepEqual(await f.client.undoFile(command), receipt)
  assert.equal((await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]).length, 1)
})

test('undoing a disabled digest does not release evidence added by the revision being reverted', async t => {
  const f = await fixture(t), original = f.documents.read(f.identity.workspace, f.created.path)!
  const span = { ...original.sources[0]!, spans: [{ start: 25, end: 49 }] }
  const tea = f.documents.commit({ operationId: randomUUID(), workspace: original.workspace, path: 'digest/wiki/tea.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Monday tea', sources: [span], reads: [] })
  const edited = f.documents.commit({ operationId: randomUUID(), workspace: original.workspace, path: original.path,
    expectedRevision: original.revision, action: 'REFINE', markdown: 'Friday report and Monday tea',
    sources: [{ ...span, spans: [{ start: 0, end: 49 }] }], reads: [] })
  const current = (await f.client.readFile(f.identity))!
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: f.identity, version: current.version, enabled: false })
  assert.equal(f.owner.runtime.readDocument!(original.workspace, tea.path), null)
  const stopped = (await f.client.readFile(f.identity))!
  await f.client.undoFile({ operationId: randomUUID(), identity: f.identity, version: stopped.version, changeId: edited.operationId })
  await f.reopen()
  assert.equal(f.owner.runtime.readDocument!(original.workspace, tea.path), null)
  const restored = (await f.client.readFile(f.identity))!
  assert.equal(restored.markdown, original.markdown)
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: f.identity, version: restored.version, enabled: true })
  assert.equal(f.owner.runtime.readDocument!(original.workspace, tea.path)?.markdown, 'Monday tea')
})


test('Viva IPC forwards a versioned management command and rejects caller-supplied authority', async t => {
  const f = await fixture(t)
  const listeners = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const ipc = checkedIpc({ handle: (name, listener) => { listeners.set(name, listener) }, on: () => {} })
  registerRuntimeMemoryIpc(ipc, { client: f.client, cwd: () => '', habits: () => ({ text: '', samples: 0 }), chooseDocs: async () => null })
  const call = (channel: string, value: unknown) => listeners.get(channel)!({}, value)
  const detail = (await f.client.readFile(f.identity))!
  const command = { operationId: randomUUID(), identity: f.identity, version: detail.version, enabled: false }
  assert.throws(() => call('memory:read-file', { ...f.identity, authorized: true }), /invalid memory:read-file/)
  assert.throws(() => call('memory:set-file-enabled', { ...command, version: { ...detail.version, policyToken: undefined } }), /invalid memory:set-file-enabled/)
  assert.deepEqual(await call('memory:read-file', f.identity), detail)
  assert.equal(memoryFileMutationResult.parse(await call('memory:set-file-enabled', command)).action, 'DISABLE')
  assert.equal((await f.client.readFile(f.identity))?.enabled, false)
})


test('a same-process retry of a prepared stop durably schedules the affected daily rebuild', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const source = f.store.readSource(f.sourceId)!
  const notes = openMemoryNotes(f.store, id => Boolean(f.store.readSource(id)?.text))
  const key = notes.add(f.session, new Date().toISOString().slice(0, 10), [source], '')!
  const refs = notes.snapshot([f.sourceId])
  assert.equal(notes.commit(key, notes.pending(key), { status: 'write', title: 'Work', markdown: source.text! },
    1, Date.now(), refs, undefined), true)
  const command = { operationId: randomUUID(), identity: f.identity, version: before.version, enabled: false }
  f.store.db.exec(`CREATE TRIGGER interrupt_document_receipt BEFORE INSERT ON memory_document_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated interruption before document receipt'); END`)
  await assert.rejects(f.client.setFileEnabled(command), /simulated interruption/)
  const rebuild = () => f.store.db.prepare("SELECT payload FROM effects WHERE kind='memory.note' AND key=?").get(key)?.payload
  assert.equal(rebuild(), undefined)
  f.store.db.exec('DROP TRIGGER interrupt_document_receipt')
  assert.equal((await f.client.setFileEnabled(command)).action, 'DISABLE')
  assert.equal(JSON.parse(String(rebuild())).rebuild, true)
})

test('recovery applies a committed source withdrawal before any prepared undo of that source', async t => {
  const f = await fixture(t), original = f.documents.read(f.identity.workspace, f.created.path)!
  const changed = f.documents.commit({ operationId: randomUUID(), workspace: original.workspace, path: original.path,
    expectedRevision: original.revision, action: 'REFINE', markdown: 'A clarified Friday report', sources: original.sources, reads: [] })
  const current = (await f.client.readFile(f.identity))!
  const undo = { operationId: randomUUID(), identity: f.identity, version: current.version, changeId: changed.operationId }
  f.store.db.exec(`CREATE TRIGGER interrupt_document_receipt BEFORE INSERT ON memory_document_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated undo interruption'); END`)
  await assert.rejects(f.client.undoFile(undo), /simulated undo interruption/)
  f.store.db.exec('DROP TRIGGER interrupt_document_receipt')
  const operationId = randomUUID()
  const { ticket } = await f.owner.handleHost('prepareSourceChange', { operationId, conversation: f.session, ids: [f.sourceId] }) as { ticket: string }
  f.store.db.exec(`CREATE TRIGGER interrupt_owner BEFORE UPDATE ON owner_occurrences
    BEGIN SELECT RAISE(ABORT, 'simulated withdrawal interruption'); END`)
  await assert.rejects(f.owner.handleHost('commitSourceChange', { operationId, ticket }), /simulated withdrawal interruption/)
  assert.equal((await f.owner.handleHost('getOperation', { operationId }) as { state: string }).state, 'host-committed')
  f.store.db.exec('DROP TRIGGER interrupt_owner')
  await f.reopen(() => assert.equal(f.documents.receipt(f.identity.workspace, undo.operationId), null))
  assert.equal(f.documents.receipt(f.identity.workspace, undo.operationId), null)
  assert.equal(await f.client.readFile(f.identity), null)
  assert.equal(f.store.sourceExcluded(f.sourceId), true)
  await assert.rejects(f.client.undoFile(undo), { code: 'revision.conflict' })
})


test('stopping a source span revokes raw sends and transferred contexts, while its unrelated file evidence remains sendable', async t => {
  const f = await fixture(t), original = f.documents.read(f.identity.workspace, f.created.path)!
  const source = f.store.readSource(f.sourceId)!
  const saved = f.documents.commit({ operationId: randomUUID(), workspace: original.workspace, path: 'digest/wiki/tea.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Tea is served on Monday.', sources: [{ ...original.sources[0]!, spans: [{ start: 26, end: source.text!.length }] }], reads: [] })
  const background = randomUUID(), schedule = randomUUID()
  for (const session of [background, schedule]) {
    const operationId = randomUUID()
    await f.owner.handleHost('sourceAlias', { operationId, sourceId: operationId, session, conversation: session,
      text: 'Use the saved context for a later task', origin: 'derived', dependencies: f.owner.dispatch.snapshot(f.session) })
  }
  const before = (await f.client.readFile(f.identity))!
  const send = f.owner.acquireSend(randomUUID(), { session: f.session }, source.text!)
  const change = f.client.setFileEnabled({ operationId: randomUUID(), identity: f.identity, version: before.version, enabled: false })
  try {
    await aborted(send.signal)
    assert.equal((await f.client.readFile(f.identity))?.enabled, true)
  } finally { send.settled() }
  await change
  const denied = () => {
    for (const session of [f.session, background, schedule]) {
      assert.equal(f.owner.needsContextRecovery(session), true)
      assert.throws(() => f.owner.acquireSend(randomUUID(), { session }, 'retry with old evidence'), /denied/)
    }
  }
  denied()
  assert.equal(await f.owner.handleHost('replaySources', { args: [[source.id], source.text] }), false)
  const reader = randomUUID(), prompt = randomUUID()
  await f.owner.receiveSource({ sessionId: reader, messageId: prompt, text: 'When is tea served?', at: Date.now(), timezone: 'UTC',
    turn: 1, step: 1, admitted: true, inherited: false })
  const packet = f.owner.runtime.handle({ op: 'file_read', session: reader, id: saved.documentId, start_line: 1, end_line: 1 }, { session: reader, conversation: reader })
  assert.match(packet, /Tea is served on Monday/)
  assert.ok(!packet.includes('Friday report'))
  const proof = f.owner.dispatch.snapshot(reader)
  assert.deepEqual(proof.fileSources, [source.id])
  assert.equal(f.owner.dispatch.transferable(proof), true)
  assert.equal(f.owner.dispatch.transferable({ ...proof, fileSources: [prompt] }), false, 'a file cannot qualify an unrelated source')
  const derivedId = randomUUID()
  await f.owner.registerDerived({ sessionId: reader, messageId: derivedId, sourceIds: proof.sources })
  await f.owner.runtime.wake()
  f.owner.acquireSend(randomUUID(), { session: reader }, packet).settled()
  await f.reopen()
  denied()
  assert.deepEqual(f.owner.dispatch.snapshot(reader).fileSources, [source.id])
  await f.owner.registerDerived({ sessionId: reader, messageId: derivedId, sourceIds: [] })
  await f.owner.runtime.wake()
  f.owner.acquireSend(randomUUID(), { session: reader }, packet).settled()
  f.owner.dispatch.recordSource(reader, source.id)
  f.owner.dispatch.attach(reader, proof)
  assert.equal(f.owner.dispatch.snapshot(reader).fileSources, undefined, 'a file read cannot downgrade an existing raw dependency')
  assert.throws(() => f.owner.acquireSend(randomUUID(), { session: reader }, packet), /denied/)
})


test('the transitional fact engine cannot inject or re-dispatch facts derived from a stopped source', async t => {
  const f = await fixture(t, false), source = f.store.readSource(f.sourceId)!, text = source.text!
  const interval = { from: null, to: null }
  const factId = f.store.tx(() => {
    const id = f.store.insert({ text, kind: 'fact', modality: 'asserted', conditional: false, keywords: [],
      scope: source.scope, source: 'agent', conversationId: source.conversation }, f.store.nextRevision(), source.at, interval)
    f.store.evidence(id, source, 0, text.length, null, null, interval, [{ start: 0, end: text.length }])
    return id
  })
  const context = async () => {
    const session = randomUUID()
    await f.owner.receiveSource({ sessionId: session, messageId: randomUUID(), text: 'What is the report deadline?',
      at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false })
    const packet = f.owner.runtime.handle({ op: 'context', session, turn: 1, question: 'report deadline' }, f.owner.sessionContext(session))
    return { session, packet }
  }
  const old = await context()
  assert.ok(old.packet.includes(text))
  assert.ok(f.owner.dispatch.snapshot(old.session).dependencies.some(ref => ref.id === factId))
  const before = (await f.client.readFile(f.identity))!
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: f.identity, version: before.version, enabled: false })
  assert.throws(() => f.owner.acquireSend(randomUUID(), { session: old.session }, old.packet), /denied/)
  const next = await context()
  assert.ok(!next.packet.includes(text))
  assert.ok(!f.owner.dispatch.snapshot(next.session).dependencies.some(ref => ref.id === factId))
})

test('erased canonical coordinates reject raw and staged replay while a disjoint file remains usable after restart', async t => {
  const f = await fixture(t), original = f.store.readSource(f.sourceId)!, text = original.text!
  const token = memorySourceToken(original), forbidden = { id: original.id, token, spans: [{ start: 0, end: 25 }] }
  const independent = { id: original.id, token, spans: [{ start: 26, end: text.length }] }
  // Even when the old fact projection has an edge for this canonical source,
  // advancing the source revision must leave independent file proof available.
  const interval = { from: null, to: null }
  f.store.tx(() => {
    const id = f.store.insert({ text, kind: 'fact', modality: 'asserted', conditional: false, keywords: [],
      scope: original.scope, source: 'agent', conversationId: original.conversation }, f.store.nextRevision(), original.at, interval)
    f.store.evidence(id, original, 0, text.length, null, null, interval, [{ start: 0, end: text.length }])
  })
  const saved = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/wiki/tea.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Tea is served on Monday.', sources: [independent], reads: [] })
  const alias = { operationId: randomUUID(), sourceId: original.id, session: f.session, conversation: f.session, text }
  await f.owner.handleHost('sourceAlias', alias)
  const reader = randomUUID()
  const read = () => f.owner.runtime.handle({ op: 'file_read', session: reader, id: saved.documentId }, { session: reader, conversation: reader })
  assert.match(read(), /Tea is served on Monday/)
  const before = f.owner.dispatch.snapshot(reader)
  assert.equal(f.store.eraseFileSource(forbidden, original.version + 1), null)
  assert.deepEqual(f.store.eraseFileSource(forbidden, original.version), { token, spans: forbidden.spans })
  const erased = f.store.readSource(original.id)!
  assert.equal(erased.version, original.version + 1)
  assert.equal(erased.text?.length, text.length)
  assert.equal(erased.text?.slice(0, 25), ' '.repeat(25))
  assert.equal(erased.text?.slice(26), text.slice(26))
  assert.equal(memorySourceToken(erased), token)
  assert.equal(f.store.eraseFileSource(forbidden, erased.version), null)
  const check = async () => {
    assert.equal(f.owner.runtime.dispatchSourceCurrent(original.id), false)
    assert.equal(f.owner.runtime.replaySource(original.id, text), false)
    await assert.rejects(f.owner.handleHost('sourceAlias', { ...alias, operationId: randomUUID() }), /withdrawn|unavailable/)
    await assert.rejects(f.owner.handleHost('bindWireAlias', { args: [f.session, text, text, original.id] }), /withdrawn|unavailable/)
    assert.equal(await f.client.readFile(f.identity), null, 'trusted management may not bypass permanent erasure')
    assert.equal(f.owner.dispatch.transferable(before), true)
    assert.match(read(), /Tea is served on Monday/)
    assert.throws(() => f.owner.acquireSend(randomUUID(), { session: f.session }, text), /denied/)
  }
  await check()
  await f.reopen()
  await check()

  const fresh = randomUUID()
  await f.owner.receiveSource({ sessionId: randomUUID(), messageId: fresh, text, at: Date.now(), timezone: 'UTC',
    turn: 1, step: 1, admitted: true, inherited: false })
  assert.equal(f.owner.runtime.dispatchSourceCurrent(fresh), true, 'an independent original is admitted normally')
})
