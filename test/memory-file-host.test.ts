import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { withRequestSource } from '../src/shared/request-routing/header.ts'
import { dirname, join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createOwnerRpcPeer } from '../src/memory/node/owner-rpc-peer.ts'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { eventually } from './fixtures/eventually.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { createVivaMemoryClient } from '../src/backend/memory-client.ts'
import { registerRuntimeMemoryIpc } from '../src/backend/memory-ipc.ts'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import type { RawIpc } from '../src/shared/ipc-contract.ts'
import type { HostMemoryCaller, HostMemoryMethod, HostMemoryApi, MemoryProject } from '../src/memory/contracts/host.ts'
import { memoryFileMutationResult } from '../src/memory/contracts/file-management.ts'

async function fixture(t: TestContext, text = 'The report is due Friday. Tea is served on Monday.') {
  const { dir, defer } = scratch(t, 'memory-file-host-')
  const options = { root: dir, dailyNotes: true,
    compute: () => null, route: () => null }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const session = randomUUID(), sourceId = randomUUID()
  await owner.receiveSource({ sessionId: session, messageId: sourceId, text, at: Date.now(), timezone: 'UTC',
    turn: 1, cwd: null })
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
  return { dir, defer, get owner() { return owner }, client, store, documents, created, identity, session, sourceId,
    async reopen(beforeRecovery?: () => void) { await owner.close(); owner = openMemoryOwner(options); beforeRecovery?.(); await owner.recover() } }
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





test('Viva IPC forwards a versioned management command and rejects caller-supplied authority', async t => {
  const f = await fixture(t)
  const source = f.store.readSource(f.sourceId)!
  const profile = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/personal/report-habits.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Prefers weekly progress on Friday.', sources: [{ id: source.id, token: memorySourceToken(source) }], reads: [] })
  const listeners = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const ipc = checkedIpc({ handle: (name, listener) => { listeners.set(name, listener) }, on: () => {} })
  const localLink = 'viva://timeline/segment/0/1'
  registerRuntimeMemoryIpc(ipc, { client: f.client, cwd: () => '', habits: () => ({ text: '', samples: 0 }), chooseDocs: async () => null,
  sourceLink: (sourceId) => sourceId === f.sourceId ? localLink : null })
  const call = (channel: string, ...args: unknown[]) => listeners.get(channel)!({}, ...args)
  const page = await call('memory:get') as { cleanupPending: number, revision: number, residentProfile: unknown, habits: unknown }
  assert.equal(Object.hasOwn(page, 'items'), false)
  assert.equal(Object.hasOwn(page, 'summaries'), false)
  assert.equal(Object.hasOwn(page, 'fileProfile'), false)
  assert.equal(page.residentProfile, null)
  const profileIdentity = { ...f.identity, id: profile.documentId }
  assert.deepEqual((await call('memory:read-file', profileIdentity) as { sources: Array<{ sourceId: string, link: string | null }> }).sources
    .map(({ sourceId, link }) => ({ sourceId, link })), [{ sourceId: f.sourceId, link: localLink }])
  const detail = (await f.client.readFile(f.identity))!
  const command = { operationId: randomUUID(), identity: f.identity, version: detail.version, enabled: false }
  assert.throws(() => call('memory:read-file', { ...f.identity, authorized: true }), /invalid memory:read-file/)
  assert.throws(() => call('memory:set-file-enabled', { ...command, version: { ...detail.version, policyToken: undefined } }), /invalid memory:set-file-enabled/)
  assert.deepEqual(await call('memory:read-file', f.identity), { ...detail, sources: detail.sources.map(source => ({ ...source, link: localLink })) })
  assert.equal(memoryFileMutationResult.parse(await call('memory:set-file-enabled', command)).action, 'DISABLE')
  assert.equal((await f.client.readFile(f.identity))?.enabled, false)
})

test('resident profile identity tracks digest/personal/profile.md across enable, disable and restart', async t => {
  const f = await fixture(t)
  const source = f.store.readSource(f.sourceId)!
  const workspace = memorySourceWorkspace(source)
  const refs = [{ id: source.id, token: memorySourceToken(source) }]
  const created = f.documents.commit({
    operationId: randomUUID(),
    workspace,
    path: 'digest/personal/profile.md',
    expectedRevision: null,
    action: 'CREATE',
    markdown: `---\nname: Personal Profile\ndescription: Resident profile\n---\n\n## 自动整理\n- Weekly reports on Friday.\n\n## Sources\n- [[${f.created.path}]]`,
    sources: refs,
    reads: [],
  })
  const resident = { kind: 'digest' as const, workspace, id: created.documentId }
  assert.deepEqual((await f.client.readPage()).residentProfile, resident)

  const detail = (await f.client.readFile(resident))!
  assert.equal(detail.sources[0]?.sourceId, f.sourceId)
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: resident, version: detail.version, enabled: false })
  // Disabled resident profile remains visible in management so the user can re-enable it.
  assert.deepEqual((await f.client.readPage()).residentProfile, resident)
  assert.equal(f.owner.profileSnapshot().text, '')

  const stopped = (await f.client.readFile(resident))!
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: resident, version: stopped.version, enabled: true })
  assert.match(f.owner.profileSnapshot().text, /Weekly reports on Friday/)

  await f.reopen()
  assert.deepEqual((await f.client.readPage()).residentProfile, resident)
  assert.match(f.owner.profileSnapshot().text, /Weekly reports on Friday/)
})









test('manual file writes use the accepted digest, preserve evidence and support idempotent undo', async t => {
  const f = await fixture(t)
  const create = { operationId: randomUUID(), title: 'Standup', text: 'Standup starts at 09:30.\n' }
  const created = await f.client.createFile(create)
  assert.equal(created.action, 'CREATE')
  assert.equal(f.store.readSource(create.operationId)?.author, 'manual')
  assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memories'").get(), undefined)
  const first = (await f.client.readFile(created.identity))!
  assert.deepEqual(first.editor, { title: create.title, text: create.text })
  assert.equal(first.actions.forget, true)
  const same = await f.client.editFile({ operationId: randomUUID(), identity: first.identity, version: first.version, text: first.editor!.text })
  assert.equal(same.usageVersion, first.version.usageVersion)
  const edit = { operationId: randomUUID(), identity: first.identity, version: first.version, text: 'Standup starts at 10:00.' }
  const edited = await f.client.editFile(edit)
  assert.equal(edited.action, 'EDIT')
  const second = (await f.client.readFile(created.identity))!
  assert.notEqual(second.version.policyToken, first.version.policyToken)
  assert.deepEqual(second.sources.map(ref => ref.sourceId), [create.operationId, edit.operationId])
  assert.deepEqual(second.editor, { title: create.title, text: edit.text })
  assert.equal(second.actions.undo?.changeId, edit.operationId)
  assert.match(f.owner.runtime.handle({ op: 'recall', session: f.session, query: 'Standup' }, { session: f.session, conversation: f.session }), /10:00/)
  await f.reopen()
  assert.deepEqual(await f.client.createFile(create), created)
  assert.deepEqual(await f.client.editFile(edit), edited)
  await assert.rejects(f.client.editFile({ ...edit, operationId: randomUUID() }), { code: 'revision.conflict' })
  await assert.rejects(f.client.editFile({ ...edit, text: 'Different reused operation' }), { code: 'operation.conflict' })
  await f.client.undoFile({ operationId: randomUUID(), identity: second.identity, version: second.version, changeId: edit.operationId })
  assert.deepEqual((await f.client.readFile(created.identity))?.editor, first.editor)
  const restored = (await f.client.readFile(created.identity))!
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: restored.identity, version: restored.version, enabled: false })
  const stopped = (await f.client.readFile(restored.identity))!
  assert.equal(stopped.actions.edit, false)
  assert.equal(stopped.editor, undefined)
  await assert.rejects(f.client.editFile({ ...edit, operationId: randomUUID(), version: stopped.version }), { code: 'revision.conflict' })
})

test('manual IPC reports structured failures without accepting caller provenance or keeping rejected text', async t => {
  const f = await fixture(t)
  const listeners = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const ipc = checkedIpc({ handle: (name, listener) => { listeners.set(name, listener) }, on: () => {} })
  registerRuntimeMemoryIpc(ipc, { client: f.client, cwd: () => '', habits: () => ({ text: '', samples: 0 }), chooseDocs: async () => null })
  const call = (channel: string, value: unknown) => listeners.get(channel)!({}, value)
  const input = { operationId: randomUUID(), text: 'Ordinary manual draft' }
  assert.throws(() => call('memory:create-file', { ...input, workspace: f.identity.workspace }), /invalid memory:create-file/)
  assert.throws(() => call('memory:create-file', { ...input, sourceId: f.sourceId }), /invalid memory:create-file/)
  const detail = (await f.client.readFile(f.identity))!
  assert.deepEqual(await call('memory:edit-file', { ...input, identity: detail.identity, version: { ...detail.version, policyToken: 'stale' } }),
    { status: 'rejected', code: 'revision.conflict' })
  const secret = { operationId: randomUUID(), text: 'password: not-a-real-secret' }
  assert.deepEqual(await call('memory:create-file', secret), { status: 'rejected', code: 'credentials' })
  assert.equal(f.store.readSource(secret.operationId), null)
  const payload = f.store.db.prepare('SELECT payload FROM owner_operations WHERE id=?').get(secret.operationId)?.payload
  assert.doesNotMatch(String(payload), /not-a-real-secret/)
  const splitSecret = { operationId: randomUUID(), title: 'password:', text: 'cross-field-secret-value' }
  assert.deepEqual(await call('memory:create-file', splitSecret), { status: 'rejected', code: 'credentials' })
  assert.equal(f.store.readSource(splitSecret.operationId), null)
  assert.equal(f.store.db.prepare('SELECT plan FROM memory_file_intents WHERE id=?').get(`documents:${splitSecret.operationId}`), undefined)
  assert.doesNotMatch(String(f.store.db.prepare('SELECT payload FROM owner_operations WHERE id=?').get(splitSecret.operationId)?.payload), /cross-field-secret/)
  const result = await call('memory:create-file', { operationId: randomUUID(), text: 'An explicit new entry' }) as { status: string }
  assert.equal(result.status, 'applied')
})

test('deleting a file over IPC checks its version, replays its receipt and keeps sources and sibling files', async t => {
  const f = await fixture(t), created = await f.client.createFile({ operationId: randomUUID(), text: 'Explicit manual memory' })
  const detail = (await f.client.readFile(created.identity))!
  assert.equal(detail.actions.forget, true, 'the accepted file exposes permanent forget through the production capability')
  const listeners = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const ipc = checkedIpc({ handle: (name, listener) => { listeners.set(name, listener) }, on: () => {} })
  registerRuntimeMemoryIpc(ipc, { client: f.client, cwd: () => '', habits: () => ({ text: '', samples: 0 }), chooseDocs: async () => null })
  const call = (value: unknown) => listeners.get('memory:forget-file')!({}, value) as Promise<import('../src/memory/contracts/file-management.ts').MemoryFileForgetResult>
  const request = { operationId: randomUUID(), identity: detail.identity, version: detail.version }
  assert.throws(() => call({ ...request, authorized: true }), /invalid memory:forget-file/)
  assert.deepEqual(await call({ ...request, operationId: randomUUID(), version: { ...request.version, policyToken: 'obsolete' } }),
    { status: 'rejected', code: 'revision.conflict' })
  const result = await call(request)
  assert.equal(result.status, 'applied')
  await f.owner.runtime.wake()
  const verified = await call(request)
  assert.ok(verified.status === 'applied' && verified.cleanup === 'complete')
  assert.equal(await f.client.readFile(created.identity), null)
  assert.deepEqual(await call(request), verified)
  assert.equal(f.store.readSource(detail.sources[0]!.sourceId)?.text, 'Explicit manual memory')
  assert.ok(await f.client.readFile(f.identity))
  await f.reopen()
  assert.deepEqual(await f.client.forgetFile(request), result.status === 'applied' && result.receipt)
  assert.equal(await f.client.readFile(created.identity), null)
  await assert.rejects(f.client.undoFile({ operationId: randomUUID(), identity: detail.identity, version: detail.version, changeId: 'before-forget' }),
    { code: 'not.found' })
})





test('a manual file replays after replacement and atomically publishes its evidence and receipt', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const command = { operationId: randomUUID(), identity: f.identity, version: before.version, text: 'Written after an interrupted checkpoint.' }
  f.store.db.exec(`CREATE TRIGGER interrupt_manual_finish BEFORE INSERT ON memory_document_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated manual receipt interruption'); END`)
  await assert.rejects(f.client.editFile(command), /simulated manual receipt interruption/)
  assert.equal(f.store.readSource(command.operationId), null)
  f.store.db.exec('DROP TRIGGER interrupt_manual_finish')
  await f.reopen()
  const after = await f.client.editFile(command)
  assert.equal(after.action, 'EDIT')
  assert.equal(f.store.readSource(command.operationId)?.text, command.text)
  assert.match((await f.client.readFile(f.identity))!.markdown, /interrupted checkpoint/)
  assert.deepEqual(await f.client.editFile(command), after)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions WHERE operation=?').get(command.operationId)?.n, 1)
})


test('a body-free owner operation interrupted before its file intent accepts an original retry', async t => {
  const f = await fixture(t), command = { operationId: randomUUID(), text: 'A volatile unpublished manual draft.' }
  f.store.db.exec(`CREATE TRIGGER interrupt_manual_before_journal BEFORE INSERT ON memory_file_intents
    WHEN NEW.namespace='documents' BEGIN SELECT RAISE(ABORT, 'simulated interruption before manual intent'); END`)
  await assert.rejects(f.client.createFile(command), /simulated interruption before manual intent/)
  assert.equal(f.store.readSource(command.operationId), null)
  const payload = f.store.db.prepare('SELECT payload FROM owner_operations WHERE id=?').get(command.operationId)?.payload
  assert.doesNotMatch(String(payload), /volatile unpublished/)
  f.store.db.exec('DROP TRIGGER interrupt_manual_before_journal')
  await f.reopen()
  await assert.rejects(f.client.createFile({ ...command, text: 'Changed retry' }), { code: 'operation.conflict' })
  const created = await f.client.createFile(command)
  assert.equal(created.action, 'CREATE')
  assert.deepEqual(await f.client.createFile(command), created)
  assert.equal((await f.client.readFile(created.identity))?.editor?.text, command.text)
})

async function retirableReport(f: Awaited<ReturnType<typeof fixture>>) {
  const before = (await f.client.readFile(f.identity))!
  await f.client.editFile({ operationId: randomUUID(), identity: before.identity, version: before.version, text: 'Friday report revised.' })
  return (await f.client.readFile(f.identity))!
}
