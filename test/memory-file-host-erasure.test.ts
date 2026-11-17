import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as shared from './fixtures/memory-file-host.ts'
import type { TestContext, RawIpc, HostMemoryCaller, HostMemoryMethod, HostMemoryApi, MemoryProject, MemoryHostEffect } from './fixtures/memory-file-host.ts'

const { randomUUID, maskTextSpans, withRequestSource, join, existsSync, readFileSync, writeFileSync, scratch, openMemoryOwner, openMemoryStore, openMemoryDocuments, memoryFileRevision, openMemoryNotes, memorySourceToken, memorySourceWorkspace, createVivaMemoryClient, registerRuntimeMemoryIpc, checkedIpc, memoryFileMutationResult, fixture, aborted } = shared

test('erased canonical coordinates reject raw and staged replay while a disjoint file remains usable after restart', async t => {
  const f = await fixture(t), original = f.store.readSource(f.sourceId)!, text = original.text!
  const token = memorySourceToken(original), forbidden = { id: original.id, token, spans: [{ start: 0, end: 25 }] }
  const independent = { id: original.id, token, spans: [{ start: 26, end: text.length }] }
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

test('forgetting a digest drains transport, cleans Node replicas and preserves disjoint file proof', async t => {
  const f = await fixture(t), source = f.store.readSource(f.sourceId)!
  const root = join(f.store.fileRoot, f.identity.workspace)
  const notes = openMemoryNotes(f.store, id => Boolean(f.store.readSource(id)?.text))
  const note = notes.add(f.session, '2026-11-16', [source], 'Assistant echo of the Friday report')!
  notes.commit(note, notes.pending(note), { status: 'write', title: 'Friday report', markdown: 'Friday report and Monday tea' },
    81, Date.now(), notes.snapshot([source.id]), undefined)
  const dailyPath = notes.read(note)!.path
  const transcript = join(root, 'session/dialog', memoryFileRevision(f.session) + '.jsonl')
  const orphan = join(root, 'session/dialog', `.viva-memory-${randomUUID()}.tmp`)
  writeFileSync(orphan, 'Abandoned Friday report replica')
  const foreign = join(root, 'session/dialog', 'independent.tmp')
  writeFileSync(foreign, 'Unmanaged temporary file')
  const tea = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/wiki/tea.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Tea is served on Monday.',
    sources: [{ id: source.id, token: memorySourceToken(source), spans: [{ start: 26, end: source.length }] }], reads: [] })
  const reader = randomUUID()
  await f.owner.receiveSource({ sessionId: reader, messageId: randomUUID(), text: 'Tea?', at: Date.now(), timezone: 'UTC',
    turn: 1, step: 1, admitted: true, inherited: false })
  const read = () => f.owner.runtime.handle({ op: 'file_read', session: reader, id: tea.documentId }, { session: reader, conversation: reader })
  assert.match(read(), /Tea is served on Monday/)
  const proof = await f.owner.handleHost('provenance', { args: [reader] }) as HostMemoryApi['provenance']['output']
  assert.deepEqual(proof.files?.find(file => file.id === tea.documentId)?.sourceRanges,
    [{ sourceId: source.id, spans: [{ start: 26, end: source.length }] }])
  const before = (await f.client.readFile(f.identity))!, operationId = randomUUID()
  const input = { operationId, identity: before.identity, version: before.version }
  const permit = f.owner.acquireSend(randomUUID(), { session: f.session }, source.text!)
  const pending = f.client.forgetFile(input)
  try {
    await aborted(permit.signal)
    assert.equal(f.store.readSource(source.id)?.text, source.text)
    assert.equal((await f.owner.handleHost('getOperation', { operationId }) as { sendFence: string }).sendFence, 'pending')
  } finally { permit.settled() }
  const receipt = await pending
  assert.equal(receipt.action, 'FORGET')
  await f.reopen()
  await f.owner.runtime.wake()
  assert.deepEqual(await f.client.forgetFile(input), receipt)
  assert.equal(await f.client.readFile(f.identity), null)
  assert.equal(existsSync(join(root, f.created.path)), false)
  assert.match(f.documents.receipt(f.identity.workspace, f.created.operationId)!.path, /digest\/wiki\/erased-/)
  assert.equal(existsSync(join(root, dailyPath)), false)
  assert.equal(existsSync(orphan), false)
  assert.equal(readFileSync(foreign, 'utf8'), 'Unmanaged temporary file')
  const serialized = readFileSync(transcript, 'utf8')
  assert.match(serialized, /Tea is served on Monday/)
  assert.doesNotMatch(serialized, /The report is due Friday|Assistant echo/)
  const relevantCopies = JSON.stringify([
    f.store.db.prepare('SELECT payload FROM memory_file_index_chunks').all(),
    f.store.db.prepare('SELECT before,after FROM memory_document_revisions').all(),
    f.store.db.prepare('SELECT plan FROM memory_file_intents').all(),
  ])
  assert.doesNotMatch(relevantCopies, /Friday report|The report is due Friday/)
  await assert.rejects(f.client.undoFile({ ...input, operationId: randomUUID(), changeId: before.actions.undo?.changeId ?? 'prior' }))
  assert.match(read(), /Tea is served on Monday/)
  f.owner.acquireSend(randomUUID(), { session: reader }, 'Independent tea file').settled()
  assert.throws(() => f.owner.acquireSend(randomUUID(), { session: f.session }, 'Old original'), /denied/)
  const [effect] = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  assert.equal(effect?.kind, 'erase-file-copies')
  assert.deepEqual(effect?.ranges?.map(({ sourceId, spans }) => ({ sourceId, spans })), [{ sourceId: source.id, spans: [{ start: 0, end: 25 }] }])
  assert.deepEqual(effect?.sessions, [f.session])
  const native = f.store.db.prepare('SELECT payload FROM owner_file_native_erasures WHERE operation=?').get(operationId)
  assert.deepEqual(JSON.parse(String(native?.payload)), { sessions: effect.sessions, ranges: effect.ranges })
  assert.equal(f.owner.runtime.cleanupPending(), 0)
  await f.owner.handleHost('ackHostEffect', { effectId: effect!.effectId, causeOperationId: operationId, revision: effect!.revision })
  assert.equal((await f.owner.handleHost('getOperation', { operationId }) as { cleanup: string }).cleanup, 'pending',
    'native transcript cleanup has an independent completion condition')
})

test('native erasure plans bind exact originals in a session and its fork across restart', async t => {
  const text = '🧪【请求 ID：r-9】\n用户原话：报告在周五提交。\nTea is served on Monday.'
  const f = await fixture(t, text), source = f.store.readSource(f.sourceId)!, before = (await f.client.readFile(f.identity))!
  const request = withRequestSource(`${text}\n\n${text}`, 'erase-test', text)
  await f.owner.handleHost('sourceAlias', { operationId: randomUUID(), sourceId: source.id,
    session: f.session, conversation: source.conversation, text })
  const delivery = await f.owner.handleHost('bindWireAlias', { args: [f.session, text, request.text, source.id, request.spans] }) as { wireText: string }
  const messageId = randomUUID()
  const message = { sessionId: f.session, messageId, text: delivery.wireText, contentDigest: 'a'.repeat(64),
    at: Date.now(), timezone: 'UTC', turn: 2, step: 1, admitted: false, inherited: false }
  assert.equal((await f.owner.receiveSource(message)).sourceId, source.id)
  const fork = randomUUID()
  assert.equal((await f.owner.receiveSource({ ...message, sessionId: fork, admitted: true, inherited: true })).sourceId, source.id)
  const separate = randomUUID()
  await f.owner.receiveSource({ ...message, sessionId: separate, messageId: randomUUID(), text, admitted: true })
  const start = text.indexOf('Tea')
  const tea = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/wiki/tea.md', expectedRevision: null,
    action: 'CREATE', markdown: 'Tea on Monday', sources: [{ id: source.id, token: memorySourceToken(source), spans: [{ start, end: text.length }] }], reads: [] })
  const teaIdentity = { kind: 'digest' as const, workspace: f.identity.workspace, id: tea.documentId }
  const operationId = randomUUID()
  await f.client.forgetFile({ operationId, identity: f.identity, version: before.version })
  const firstProjection = f.store.readSource(source.id)!
  const teaBefore = (await f.client.readFile(teaIdentity))!, nextOperation = randomUUID()
  await f.client.forgetFile({ operationId: nextOperation, identity: teaIdentity, version: teaBefore.version })
  await f.reopen()

  const row = f.store.db.prepare('SELECT payload FROM owner_file_native_erasures WHERE operation=?').get(operationId)
  const payload = String(row?.payload)
  assert.ok(row)
  assert.doesNotMatch(payload, /报告在周五|Tea is served|memory-delivery/)
  const plan = JSON.parse(payload) as {
    sessions: string[], ranges: { hash: string, afterHash: string }[], originals: { sessionId: string, messageId: string, sourceId: string,
      sourceHash: string, wireHash: string, contentHash: string, sourceSpans: typeof request.spans, wireCuts: typeof request.spans }[]
  }
  assert.deepEqual(plan.sessions.sort(), [f.session, fork].sort())
  assert.deepEqual(plan.originals.map(copy => copy.sessionId).sort(), [f.session, fork].sort())
  for (const copy of plan.originals) {
    assert.equal(copy.messageId, messageId)
    assert.equal(copy.sourceId, source.id)
    assert.equal(copy.sourceHash, source.hash)
    assert.match(copy.wireHash, /^[0-9a-f]{64}$/)
    assert.match(copy.contentHash, /^[0-9a-f]{64}$/)
    assert.deepEqual(copy.sourceSpans, request.spans)
    const [first, second] = request.spans
    assert.equal(first!.end - first!.start, 3)
    assert.deepEqual(copy.wireCuts, [first, { start: second!.start, end: second!.start + 22 }])
    const masked = maskTextSpans(delivery.wireText, copy.wireCuts)
    assert.equal(masked.slice(0, first!.start), delivery.wireText.slice(0, first!.start))
    assert.equal(masked[second!.start - 1], '\u200B')
    assert.equal(copy.sourceSpans.map(span => masked.slice(span.start, span.end)).join(''), firstProjection.text)
    assert.equal(masked.slice(second!.end), delivery.wireText.slice(second!.end))
  }
  const next = JSON.parse(String(f.store.db.prepare('SELECT payload FROM owner_file_native_erasures WHERE operation=?').get(nextOperation)?.payload)) as typeof plan
  assert.equal(next.ranges[0]?.hash, plan.ranges[0]?.afterHash)
  assert.equal(next.ranges[0]?.afterHash, f.store.readSource(source.id)?.hash)
  for (const copy of next.originals) {
    assert.equal(copy.sourceHash, source.hash)
    const end = request.spans.at(-1)!.end
    assert.deepEqual(copy.wireCuts, [{ start: end - (text.length - start), end }])
  }
})

test('a lost file-forget completion rolls back the cut and recovers one operation after restart', async t => {
  const f = await fixture(t), file = (await f.client.readFile(f.identity))!, source = f.store.readSource(f.sourceId)!
  const input = { operationId: randomUUID(), identity: file.identity, version: file.version }
  f.store.db.exec(`CREATE TRIGGER interrupt_forget BEFORE UPDATE ON owner_operations WHEN NEW.state='completed'
    BEGIN SELECT RAISE(ABORT, 'interrupted completion'); END`)
  await assert.rejects(f.client.forgetFile(input), /interrupted completion/)
  assert.equal(f.store.readSource(source.id)?.text, source.text)
  assert.ok(await f.client.readFile(f.identity))
  f.store.db.exec('DROP TRIGGER interrupt_forget')
  await f.reopen()
  const result = await f.client.forgetFile(input)
  assert.equal(result.action, 'FORGET')
  assert.equal(f.store.readSource(source.id)?.version, source.version + 1)
  assert.equal((await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]).length, 1)
  await assert.rejects(f.client.forgetFile({ ...input, version: { ...input.version, policyToken: 'different' } }), { code: 'operation.conflict' })
})

test('an independent stopped range remains addressable after its former digest is erased', async t => {
  const f = await fixture(t), source = f.store.readSource(f.sourceId)!
  const write = (path: string, markdown: string, spans?: Array<{ start: number, end: number }>) => f.documents.commit({
    workspace: f.identity.workspace, operationId: randomUUID(), path, markdown, action: 'CREATE', reads: [],
    expectedRevision: null, sources: [{ id: source.id, token: memorySourceToken(source), spans }] })
  const owner = write('digest/wiki/mixed.md', 'Mixed original evidence'), tea = write('digest/wiki/b-only.md', 'Monday tea',
    [{ start: 26, end: source.length }])
  const identity = { ...f.identity, id: owner.documentId }, prior = (await f.client.readFile(identity))!
  await f.client.setFileEnabled({ operationId: randomUUID(), identity, version: prior.version, enabled: false })
  const removed = (await f.client.readFile(f.identity))!
  await f.client.forgetFile({ operationId: randomUUID(), identity: removed.identity, version: removed.version })
  await f.reopen()
  const parked = (await f.client.readFile(identity))!, restriction = parked.restrictions![0]!
  assert.equal(parked.hasProjection, false)
  assert.equal(parked.markdown, '')
  assert.equal(f.owner.runtime.readDocument!(identity.workspace, tea.path), null)
  const input = { operationId: randomUUID(), identity, version: restriction.version, restrictionId: restriction.id, enabled: true }
  const receipt = await f.client.setFileEnabled(input)
  assert.deepEqual(await f.client.setFileEnabled(input), receipt)
  assert.equal(await f.client.readFile(identity), null)
  assert.equal(f.owner.runtime.readDocument!(identity.workspace, tea.path)?.markdown, 'Monday tea')
  assert.equal(await f.client.readFile(f.identity), null)
})

test('an erased locator is removed from independent Markdown and history across restart', async t => {
  const f = await fixture(t), source = f.store.readSource(f.sourceId)!
  const linked = f.documents.commit({ workspace: f.identity.workspace, operationId: randomUUID(), path: 'digest/wiki/linked.md',
    markdown: `Monday tea. [[${f.created.path}]] [[  ${f.created.path}#original  |retained citation]]\n\n| Source |\n| --- |\n| [[${f.created.path}\\|citation]] |`, action: 'CREATE', expectedRevision: null, reads: [],
    sources: [{ id: source.id, token: memorySourceToken(source), spans: [{ start: 26, end: source.length }] }] })
  const proof = [{ id: source.id, token: memorySourceToken(source), spans: [{ start: 26, end: source.length }] }]
  const replacement = { workspace: f.identity.workspace, path: 'digest/wiki/replacement.md', sources: proof, reads: [] }
  const draft = f.documents.commit({ ...replacement, operationId: randomUUID(), markdown: 'Draft', action: 'CREATE', expectedRevision: null })
  f.documents.commit({ ...replacement, operationId: randomUUID(), markdown: 'Updated tea', action: 'CORRECT', expectedRevision: draft.revision,
    corrections: [{ path: linked.path, revision: linked.revision!, startLine: 1, endLine: 1,
      text: `Monday tea. [[${f.created.path}]] [[  ${f.created.path}#original  |retained citation]]`,
      condition: `See [[${f.created.path}]]`, time: `After [[${f.created.path}]]` }] })
  const current = (await f.client.readFile(f.identity))!
  await f.client.forgetFile({ operationId: randomUUID(), identity: f.identity, version: current.version })
  await f.reopen()
  const session = randomUUID()
  const read = f.owner.runtime.handle({ op: 'file_read', session, id: linked.documentId, evidence: true }, { session, conversation: session })
  assert.match(read, /Monday tea/)
  assert.ok(!read.includes(f.created.path))
  assert.ok(!readFileSync(join(f.store.fileRoot, f.identity.workspace, linked.path), 'utf8').includes(f.created.path))
  const copies = f.store.db.prepare('SELECT before,after FROM memory_document_revisions').all()
  assert.ok(!JSON.stringify(copies).includes(f.created.path))
  assert.equal(f.owner.runtime.cleanupPending(), 0)
})

test('an escaped locator retained only in correction metadata is physically removed', async t => {
  const f = await fixture(t), source = f.store.readSource(f.sourceId)!
  const shared = { workspace: f.identity.workspace, reads: [], sources: [{ id: source.id, token: memorySourceToken(source),
    spans: [{ start: 26, end: source.length }] }] }
  const before = f.documents.commit({ ...shared, operationId: randomUUID(), path: 'digest/wiki/tea-before.md', markdown: 'Tea Monday',
    action: 'CREATE', expectedRevision: null })
  const after = f.documents.commit({ ...shared, operationId: randomUUID(), path: 'digest/wiki/tea-after.md', markdown: 'Draft',
    action: 'CREATE', expectedRevision: null })
  f.documents.commit({ ...shared, operationId: randomUUID(), path: after.path, markdown: 'Tea Tuesday',
    action: 'CORRECT', expectedRevision: after.revision, corrections: [{ path: before.path, revision: before.revision!, startLine: 1, endLine: 1,
      text: 'Tea Monday', time: '', condition: `[[${f.created.path}\\|citation]]` }] })
  const original = (await f.client.readFile(f.identity))!
  await f.client.forgetFile({ operationId: randomUUID(), identity: original.identity, version: original.version })
  await f.reopen()
  assert.equal(f.owner.runtime.cleanupPending(), 0)
  const metadata = f.store.db.prepare('SELECT corrections FROM memory_documents WHERE id=?').get(after.documentId)?.corrections
  assert.ok(!String(metadata).includes(f.created.path))
  const reader = randomUUID()
  const packet = f.owner.runtime.handle({ op: 'file_read', session: reader, id: before.documentId, evidence: true }, { session: reader, conversation: reader })
  assert.match(packet, /Tea Monday/)
  assert.ok(!packet.includes(f.created.path))
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

test('permanent file forget IPC binds owner proof, replays one operation, and reports pending copies honestly', async t => {
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
  assert.equal(result.status === 'applied' && result.cleanup, 'pending')
  assert.equal(await f.client.readFile(created.identity), null)
  assert.deepEqual(await call(request), result)
  const effects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  const effect = effects.find(item => item.effectId === request.operationId)!
  assert.equal(effect.kind, 'erase-file-copies')
  await f.owner.runtime.wake()
  await f.owner.handleHost('ackHostEffect', { effectId: effect.effectId, causeOperationId: effect.causeOperationId, revision: effect.revision })
  const complete = await call(request)
  assert.equal(complete.status === 'applied' && complete.cleanup, 'complete')
  await assert.rejects(f.client.undoFile({ operationId: randomUUID(), identity: detail.identity, version: detail.version, changeId: 'before-forget' }),
    { code: 'not.found' })
})

test('a concurrent edit cannot copy content across an exact forgetting boundary', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const user = await f.client.createFile({ operationId: randomUUID(), text: 'New independent material for tea' })
  await f.owner.runtime.wake()
  const permit = f.owner.acquireSend(randomUUID(), { session: f.session }, 'in-flight old report')
  const forgetting = f.client.forgetFile({ operationId: randomUUID(), identity: before.identity, version: before.version })
  const edit = { operationId: randomUUID(), identity: before.identity, version: before.version, text: 'Friday report needs updated wording.' }
  const editing = assert.rejects(f.client.editFile(edit), { code: 'revision.conflict' })
  try {
    await aborted(permit.signal)
    const pending = f.store.db.prepare('SELECT payload FROM owner_operations WHERE id=?').get(edit.operationId)?.payload
    assert.doesNotMatch(String(pending), /updated wording/)
    assert.equal(f.store.readSource(edit.operationId), null)
  } finally { permit.settled() }
  await forgetting
  await editing
  await f.reopen()
  await assert.rejects(f.client.editFile(edit), { code: 'revision.conflict' })
  assert.equal(await f.client.readFile(f.identity), null)
  assert.equal(f.store.readSource(edit.operationId), null)
  assert.match((await f.client.readFile(user.identity))!.markdown, /New independent material/)
})

test('an edit prepared before a source cut cannot recover its staged copy after restart', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const source = f.documents.read(f.identity.workspace, before.path)!.sources[0]!
  const peer = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/wiki/peer-report.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Independent digest identity, same exact evidence', sources: [source], reads: [] })
  const peerIdentity = { ...f.identity, id: peer.documentId }
  const peerBefore = (await f.client.readFile(peerIdentity))!
  const edit = { operationId: randomUUID(), identity: before.identity, version: before.version, text: 'Friday report with the private copied draft.' }
  f.store.db.exec(`CREATE TRIGGER interrupt_manual_receipt BEFORE INSERT ON memory_document_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated interruption after manual replacement'); END`)
  await assert.rejects(f.client.editFile(edit), /simulated interruption/)
  assert.equal(f.store.readSource(edit.operationId), null)
  assert.equal(await f.client.readFile(f.identity), null)
  f.store.db.exec('DROP TRIGGER interrupt_manual_receipt')
  await f.client.forgetFile({ operationId: randomUUID(), identity: peerIdentity, version: peerBefore.version })
  await f.reopen()
  await assert.rejects(f.client.editFile(edit), { code: 'revision.conflict' })
  assert.equal(await f.client.readFile(f.identity), null)
  assert.equal(f.store.readSource(edit.operationId), null)
  assert.match(JSON.stringify(f.store.db.prepare('SELECT state,plan FROM memory_file_intents WHERE id=?').get(`documents:${edit.operationId}`)), /cancelled/)
  assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT state,plan FROM memory_file_intents WHERE id=?').get(`documents:${edit.operationId}`)), /private copied draft/)
  assert.equal(existsSync(join(f.store.fileRoot, f.identity.workspace, before.path)), false)
})

test('manual lineage erases copied wording even through a second digest, preserving disjoint explicit input', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  const original = f.documents.read(f.identity.workspace, before.path)!.sources[0]!
  const peer = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/wiki/peer.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Another digest uses the report', sources: [original], reads: [] })
  const edit = { operationId: randomUUID(), identity: f.identity, version: before.version, text: 'Friday report with a new finishing time.' }
  const independent = await f.client.createFile({ operationId: randomUUID(), text: edit.text })
  await f.client.editFile(edit)
  const proof = f.documents.read(f.identity.workspace, before.path)!.sources.find(ref => ref.id === edit.operationId)!
  const clone = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/wiki/edit-clone.md',
    expectedRevision: null, action: 'CREATE', markdown: edit.text, sources: [proof], reads: [] })
  const peerIdentity = { ...f.identity, id: peer.documentId }, cloneIdentity = { ...f.identity, id: clone.documentId }
  const peerBefore = (await f.client.readFile(peerIdentity))!
  assert.match((await f.client.readFile(cloneIdentity))!.markdown, /finishing time/)
  const stopped = await f.client.setFileEnabled({ operationId: randomUUID(), identity: peerIdentity, version: peerBefore.version, enabled: false })
  assert.equal(f.owner.runtime.readDocument!(cloneIdentity.workspace, clone.path), null, 'a copied draft cannot bypass stop')
  const current = (await f.client.readFile(peerIdentity))!
  assert.equal(current.version.usageVersion, stopped.usageVersion)
  await f.client.forgetFile({ operationId: randomUUID(), identity: peerIdentity, version: current.version })
  await f.reopen()
  assert.equal(await f.client.readFile(cloneIdentity), null)
  assert.equal(f.store.readSource(edit.operationId)?.text?.trim(), '')
  assert.equal((await f.client.readFile(independent.identity))!.editor?.text, edit.text, 'identical explicit input is a separate proof, never a content blacklist')
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

test('manual edit waits for the physical fence and a queued stale forget cannot erase the revised file', async t => {
  const f = await fixture(t), before = (await f.client.readFile(f.identity))!
  f.owner.dispatch.recordFiles(f.session, [{ workspace: f.identity.workspace, id: f.identity.id, path: before.path,
    revision: before.version.contentRevision, usageVersion: before.version.usageVersion, policyToken: before.version.policyToken, sourceRanges: [{ sourceId: f.sourceId, spans: [{ start: 0, end: 25 }] }] }])
  const permit = f.owner.acquireSend(randomUUID(), { session: f.session }, 'Old digest dispatch')
  const edit = { operationId: randomUUID(), identity: before.identity, version: before.version, text: 'New text before explicit deletion.' }
  const editing = f.client.editFile(edit)
  const forgetting = assert.rejects(f.client.forgetFile({ operationId: randomUUID(), identity: before.identity, version: before.version }),
    { code: 'revision.conflict' })
  try {
    await aborted(permit.signal)
    assert.equal(f.store.readSource(edit.operationId), null)
    assert.equal((await f.client.readFile(before.identity))?.markdown, before.markdown)
  } finally { permit.settled() }
  const receipt = await editing
  await forgetting
  assert.equal(receipt.usageVersion, before.version.usageVersion + 1)
  assert.throws(() => f.owner.acquireSend(randomUUID(), { session: f.session }, 'Old digest retry'), /denied/)
  const [effect, duplicate] = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  assert.equal(effect?.kind, 'invalidate-context')
  assert.equal(effect?.causeOperationId, edit.operationId)
  assert.equal(duplicate, undefined)
  await f.reopen()
  assert.equal((await f.client.readFile(before.identity))?.editor?.text, edit.text)
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

test('manual creation rejects a retired locator in a tab-escaped title before staging', async t => {
  const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
  const request = { operationId: randomUUID(), title: `Title: links to [[\t${forgotten.path}]].`, text: 'Unrelated draft body.' }
  await f.client.forgetFile({ operationId: randomUUID(), identity: forgotten.identity, version: forgotten.version })
  assert.notEqual(f.documents.projectErasedLocators(forgotten.identity.workspace, request.title), request.title)
  await assert.rejects(f.client.createFile(request), { code: 'revision.conflict' })
  assert.equal(f.store.readSource(request.operationId), null)
  assert.equal(f.store.db.prepare('SELECT plan FROM memory_file_intents WHERE id=?').get(`documents:${request.operationId}`), undefined)
})

test('forgetting erases accepted escaped manual titles and their exact canonical locator copies', async t => {
  const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
  const text = 'Independently recorded Monday tea.'
  const request = { operationId: randomUUID(), title: `Tea: before [[\t${forgotten.path}\t|reference]] after`, text }
  const manual = await f.client.createFile(request)
  const before = (await f.client.readFile(manual.identity))!
  const disk = join(f.store.fileRoot, manual.identity.workspace, before.path)
  assert.equal(before.editor?.title, request.title)
  assert.ok(readFileSync(disk, 'utf8').includes(`[[\\t${forgotten.path}\\t|reference]]`))
  const original = f.store.readSource(request.operationId)!.text!
  assert.ok(original.includes(forgotten.path))
  assert.equal(f.owner.runtime.replaySource(request.operationId, original), true)

  await f.client.forgetFile({ operationId: randomUUID(), identity: forgotten.identity, version: forgotten.version })
  await f.reopen()
  await f.owner.runtime.wake()
  const after = (await f.client.readFile(manual.identity))!
  assert.equal(after.markdown.length, before.markdown.length)
  assert.notEqual(after.version.policyToken, before.version.policyToken)
  assert.equal(after.editor?.text, text)
  assert.match(after.editor?.title ?? '', /^Tea: before +after$/u)
  assert.ok(!JSON.stringify(after).includes(forgotten.path))
  const session = randomUUID()
  const model = f.owner.runtime.handle({ op: 'file_read', session, id: manual.identity.id, evidence: true }, { session, conversation: session })
  assert.ok(model.includes(text))
  assert.ok(!model.includes(forgotten.path))
  assert.equal(f.owner.runtime.replaySource(request.operationId, original), false)
  assert.equal(f.owner.runtime.cleanupPending(), 0)
  const cleanedSource = f.store.readSource(request.operationId)!
  assert.ok(!cleanedSource.text?.includes(forgotten.path))
  assert.equal(cleanedSource.text?.length, original.length)
  assert.ok(cleanedSource.text?.endsWith(text))
  const effects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  const effect = effects.find(item => item.kind === 'erase-file-copies')
  assert.ok(effect && 'ranges' in effect && effect.ranges?.some(range => range.sourceId === request.operationId))
  assert.ok((await f.client.cleanupPending()) > 0, 'the host acknowledgement remains separate from local canonical cleanup')

  await f.client.editFile({ operationId: randomUUID(), identity: manual.identity, version: after.version, title: 'Tea', text })
  // Isolate the canonical replica from the on-disk file and retained undo revisions.
  f.store.db.prepare('DELETE FROM memory_document_revisions WHERE document=?').run(manual.identity.id)
  await f.reopen()
  await f.owner.runtime.wake()
  assert.ok(!readFileSync(disk, 'utf8').includes(forgotten.path))
  assert.ok(!f.store.readSource(request.operationId)?.text?.includes(forgotten.path))
  assert.equal(f.owner.runtime.cleanupPending(), 0)
})

test('manual locator erasure preserves authored edits and exact disjoint evidence while erasing derived copies', async t => {
  const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
  const title = 'Tea 😀 preferences', link = `[[${forgotten.path}]]`
  const body = `Keep coffee decaffeinated.\r\nSee ${link}.\r\nKeep tea before noon.`
  const create = { operationId: randomUUID(), title, text: body }
  const file = await f.client.createFile(create), before = (await f.client.readFile(file.identity))!
  const edit = { operationId: randomUUID(), identity: file.identity, version: before.version, title,
    text: body.replace('before noon', 'before lunch') }
  await f.client.editFile(edit)
  const current = (await f.client.readFile(file.identity))!, original = f.store.readSource(edit.operationId)!
  const offset = original.text!.indexOf('Keep tea'), disjoint = [{ id: original.id, token: memorySourceToken(original),
    spans: [{ start: offset, end: original.length }] }]
  const peer = f.documents.commit({ operationId: randomUUID(), workspace: file.identity.workspace, path: 'digest/wiki/tea-boundary.md',
    markdown: 'Keep tea before lunch.', expectedRevision: null, action: 'CREATE', sources: disjoint, reads: [] })
  const dependent = f.documents.commit({ operationId: randomUUID(), workspace: file.identity.workspace, path: 'digest/wiki/tea-copy.md',
    markdown: 'The copied note points to the retired report.', expectedRevision: null, action: 'CREATE',
    sources: [{ id: original.id, token: memorySourceToken(original) }], reads: [] })
  await f.client.forgetFile({ operationId: randomUUID(), identity: forgotten.identity, version: forgotten.version })
  await f.reopen()
  await f.owner.runtime.wake()
  const after = (await f.client.readFile(file.identity))!
  assert.equal(after.editor?.text, edit.text.replace(link, ' '.repeat(link.length)))
  assert.equal(after.editor?.title, title)
  assert.equal(after.version.usageVersion, current.version.usageVersion)
  const stored = f.store.readSource(edit.operationId)!
  assert.equal(stored.text?.length, original.text!.length)
  assert.deepEqual(stored.erasure?.spans, [{ start: original.text!.indexOf(link), end: original.text!.indexOf(link) + link.length }])
  assert.equal(f.documents.read(file.identity.workspace, peer.path)?.markdown, 'Keep tea before lunch.')
  assert.equal(await f.client.readFile({ ...file.identity, id: dependent.documentId }), null)
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT before,after FROM memory_document_revisions WHERE document=?').all(file.identity.id)).includes(forgotten.path))
  assert.equal(f.owner.runtime.cleanupPending(), 0)
  assert.equal(f.owner.runtime.replaySource(edit.operationId, original.text!), false)
})

test('successive locator cuts of the same authored source retain the original independent prose', async t => {
  const f = await fixture(t), first = (await f.client.readFile(f.identity))!, source = f.store.readSource(f.sourceId)!
  const peer = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/wiki/monday-tea.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Monday tea.',
    sources: [{ id: source.id, token: memorySourceToken(source), spans: [{ start: 26, end: source.length }] }], reads: [] })
  const draft = { operationId: randomUUID(), title: 'Independent notes', text: `Keep the note. [[${first.path}]] Then [[${peer.path}]].` }
  const manual = await f.client.createFile(draft)
  await f.client.forgetFile({ operationId: randomUUID(), identity: first.identity, version: first.version })
  const second = (await f.client.readFile({ ...f.identity, id: peer.documentId }))!
  await f.client.forgetFile({ operationId: randomUUID(), identity: second.identity, version: second.version })
  await f.reopen()
  await f.owner.runtime.wake()
  const after = (await f.client.readFile(manual.identity))!
  assert.ok(after.editor?.text.includes('Keep the note.'))
  assert.ok(!after.markdown.includes(first.path))
  assert.ok(!after.markdown.includes(peer.path))
  assert.ok(f.store.readSource(draft.operationId)?.text?.includes('Keep the note.'))
  assert.equal(f.store.readSource(draft.operationId)?.erasure?.spans.length, 2)
  assert.equal(f.owner.runtime.cleanupPending(), 0)
})

test('locator erasure reaches newly retired derived paths and coalesces each canonical host range', async t => {
  const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
  const first = { operationId: randomUUID(), title: 'First independent note', text: `Keep first prose. [[${forgotten.path}]]` }
  const firstFile = await f.client.createFile(first), source = f.store.readSource(first.operationId)!
  const derived = f.documents.commit({ operationId: randomUUID(), workspace: firstFile.identity.workspace, path: 'digest/wiki/derived-chain.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Derived material from the first note.',
    sources: [{ id: source.id, token: memorySourceToken(source) }], reads: [] })
  const last = { operationId: randomUUID(), title: 'Last independent note', text: `Keep last prose. [[${forgotten.path}]] and [[${derived.path}]].` }
  const lastFile = await f.client.createFile(last), canonical = f.store.readSource(last.operationId)!
  const operationId = randomUUID()
  await f.client.forgetFile({ operationId, identity: forgotten.identity, version: forgotten.version })
  const effects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  const effect = effects.find(item => item.effectId === operationId)
  assert.ok(effect && 'ranges' in effect)
  const ranges = effect.ranges!.filter(range => range.sourceId === last.operationId)
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0]?.revision, canonical.version)
  assert.equal(ranges[0]?.hash, canonical.hash)
  assert.equal(ranges[0]?.afterHash, f.store.readSource(last.operationId)?.hash)
  assert.equal(ranges[0]?.spans.length, 2)
  await f.reopen()
  await f.owner.runtime.wake()
  for (const file of [firstFile, lastFile]) {
    const detail = (await f.client.readFile(file.identity))!
    assert.ok(detail.editor?.text.startsWith('Keep'))
    assert.ok(!detail.markdown.includes(forgotten.path))
    assert.ok(!detail.markdown.includes(derived.path))
  }
  assert.equal(await f.client.readFile({ ...firstFile.identity, id: derived.documentId }), null)
  assert.ok(!f.store.readSource(last.operationId)?.text?.includes(derived.path))
  assert.equal(f.owner.runtime.cleanupPending(), 0)
})

test('a native file-only reader drains before canonical locator erasure and receives the same range outbox', async t => {
  const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
  const input = { operationId: randomUUID(), text: `Keep independent prose. [[${forgotten.path}]]` }
  const file = await f.client.createFile(input), reader = randomUUID()
  await f.owner.runtime.wake()
  f.owner.initializeSession({ sessionId: reader, cwd: f.store.fileRoot })
  const result = f.owner.runtime.handle({ op: 'file_read', session: reader, id: file.identity.id }, f.owner.sessionContext(reader))
  assert.ok(result.includes('Keep independent prose'))
  assert.ok(f.store.db.prepare('SELECT 1 FROM memory_sessions WHERE id=?').get(reader))
  const permit = f.owner.acquireSend(randomUUID(), { session: reader }, 'Reader waiting for locator erasure')
  const operationId = randomUUID()
  const forgetting = f.client.forgetFile({ operationId, identity: forgotten.identity, version: forgotten.version })
  try {
    await aborted(permit.signal)
    assert.ok(f.store.readSource(input.operationId)?.text?.includes(forgotten.path))
  } finally { permit.settled() }
  await forgetting
  assert.ok(!f.store.readSource(input.operationId)?.text?.includes(forgotten.path))
  assert.throws(() => f.owner.acquireSend(randomUUID(), { session: reader }, 'Retired file reader retry'), /denied/u)
  const effects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  const effect = effects.find(item => item.effectId === operationId)
  assert.ok(effect?.sessions?.includes(reader))
  assert.ok(effect && 'ranges' in effect && effect.ranges?.some(range => range.sourceId === input.operationId))
  await f.reopen()
  await f.owner.runtime.wake()
  assert.ok(!f.store.readSource(input.operationId)?.text?.includes(forgotten.path))
  assert.ok(await f.client.readFile(file.identity))
})

test('saving the displayed projection unchanged preserves the accepted revision and source', async t => {
  const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
  const text = 'Independent note.'
  const created = await f.client.createFile({ operationId: randomUUID(), title: `Note: before [[\t${forgotten.path}]]`, text })
  const original = (await f.client.readFile(created.identity))!, disk = join(f.store.fileRoot, created.identity.workspace, original.path)
  await f.client.forgetFile({ operationId: randomUUID(), identity: forgotten.identity, version: forgotten.version })
  await f.owner.runtime.wake()
  const displayed = (await f.client.readFile(created.identity))!
  assert.match(displayed.editor?.title ?? '', /^Note: before +$/u)
  const input = { operationId: randomUUID(), identity: created.identity, version: displayed.version, ...displayed.editor! }
  const receipt = await f.client.editFile(input)
  assert.equal(receipt.contentRevision, displayed.version.contentRevision)
  assert.equal(receipt.usageVersion, displayed.version.usageVersion)
  assert.equal(readFileSync(disk, 'utf8'), displayed.markdown)
  assert.equal(f.store.readSource(input.operationId), null)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_document_revisions WHERE document=?').get(created.identity.id)?.n, 1)
  await f.reopen()
  assert.deepEqual(await f.client.editFile(input), receipt)
  await assert.rejects(f.client.editFile({ ...input, operationId: randomUUID(), version: original.version }), { code: 'revision.conflict' })
})

test('undo restores the projected historical body and its actual physical hash', async t => {
  const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
  const originalText = 'Independent original body.'
  const created = await f.client.createFile({ operationId: randomUUID(), title: `Note: [[\t${forgotten.path}]]`, text: originalText })
  await f.client.forgetFile({ operationId: randomUUID(), identity: forgotten.identity, version: forgotten.version })
  await f.owner.runtime.wake()
  const projected = (await f.client.readFile(created.identity))!
  const edited = await f.client.editFile({ operationId: randomUUID(), identity: created.identity, version: projected.version, title: 'Current title.', text: 'Independent revised body.' })
  const current = (await f.client.readFile(created.identity))!, disk = join(f.store.fileRoot, created.identity.workspace, current.path)
  assert.ok(!readFileSync(disk, 'utf8').includes(forgotten.path))
  const undo = { operationId: randomUUID(), identity: created.identity, version: current.version, changeId: edited.operationId }
  const receipt = await f.client.undoFile(undo)
  assert.equal(readFileSync(disk, 'utf8'), projected.markdown)
  assert.equal(receipt.contentRevision, memoryFileRevision(projected.markdown))
  await f.reopen()
  assert.deepEqual(await f.client.undoFile(undo), receipt)
  const restored = (await f.client.readFile(created.identity))!
  assert.equal(restored.markdown, projected.markdown)
  assert.equal(restored.editor?.text, originalText)
})

test('recovery rejects an interrupted undo that would restore a newly retired locator', async t => {
  const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
  const created = await f.client.createFile({ operationId: randomUUID(), title: `Note: [[\t${forgotten.path}]]`, text: 'Independent original body.' })
  const before = (await f.client.readFile(created.identity))!
  const edited = await f.client.editFile({ operationId: randomUUID(), identity: created.identity, version: before.version, title: 'Current title.', text: 'Independent revised body.' })
  const current = (await f.client.readFile(created.identity))!, disk = join(f.store.fileRoot, created.identity.workspace, current.path)
  const undo = { operationId: randomUUID(), identity: created.identity, version: current.version, changeId: edited.operationId }
  f.store.db.exec(`CREATE TRIGGER interrupt_locator_undo BEFORE INSERT ON memory_document_receipts
    BEGIN SELECT RAISE(ABORT, 'simulated interruption after undo replacement'); END`)
  await assert.rejects(f.client.undoFile(undo), /simulated interruption/)
  f.store.db.exec('DROP TRIGGER interrupt_locator_undo')
  assert.equal(readFileSync(disk, 'utf8'), before.markdown)

  await f.client.forgetFile({ operationId: randomUUID(), identity: forgotten.identity, version: forgotten.version })
  await f.reopen()
  await assert.rejects(f.client.undoFile(undo), { code: 'revision.conflict' })
  assert.equal(readFileSync(disk, 'utf8'), current.markdown)
  const retained = (await f.client.readFile(created.identity))!
  assert.equal(retained.version.contentRevision, current.version.contentRevision)
  assert.equal(retained.version.usageVersion, current.version.usageVersion)
  assert.notEqual(retained.version.policyToken, current.version.policyToken)
  assert.equal(f.documents.receipt(created.identity.workspace, undo.operationId), null)
  const aborted = f.store.db.prepare('SELECT state,plan FROM memory_file_intents WHERE id=?').get(`documents:${undo.operationId}`)
  assert.deepEqual({ ...aborted }, { state: 'cancelled', plan: null })
})

for (const [mode, field] of [['create', 'body'], ['create', 'title'], ['edit', 'body'], ['edit', 'title']] as const) {
  test(`manual ${mode} recovery rejects a retired locator in the draft ${field}`, async t => {
    const f = await fixture(t), forgotten = (await f.client.readFile(f.identity))!
    const independent = mode === 'edit'
      ? await f.client.createFile({ operationId: randomUUID(), text: 'Previously committed independent text.' }) : null
    const current = independent ? (await f.client.readFile(independent.identity))! : null
    const request = {
      operationId: randomUUID(),
      title: field === 'title' ? `Title: links to [[\t${forgotten.path}]].` : 'Independent draft',
      text: field === 'title' ? 'Unrelated draft body.' : `A staged copy links to [[${forgotten.path}]].`,
    }
    const submit = () => current ? f.client.editFile({ ...request, identity: current.identity, version: current.version }) : f.client.createFile(request)
    f.store.db.exec(`CREATE TRIGGER interrupt_locator_receipt BEFORE INSERT ON memory_document_receipts
      BEGIN SELECT RAISE(ABORT, 'simulated interruption after draft replacement'); END`)
    await assert.rejects(submit(), /simulated interruption/)
    f.store.db.exec('DROP TRIGGER interrupt_locator_receipt')
    const plan = () => f.store.db.prepare('SELECT state,plan FROM memory_file_intents WHERE id=?').get(`documents:${request.operationId}`)!
    const metadata = JSON.parse(String(plan().plan)) as { workspace: string, changes: Array<{ path: string }> }
    const disk = join(f.store.fileRoot, metadata.workspace, metadata.changes[0]!.path)
    const staged = readFileSync(disk, 'utf8')
    assert.ok(staged.includes(field === 'title' ? request.title.replace('\t', '\\t') : request.text))
    assert.equal(f.store.readSource(request.operationId), null)

    await f.client.forgetFile({ operationId: randomUUID(), identity: forgotten.identity, version: forgotten.version })
    assert.notEqual(f.documents.projectErasedLocators(forgotten.identity.workspace, staged), staged)
    await f.reopen()
    await assert.rejects(submit(), { code: 'revision.conflict' })
    assert.equal(f.store.readSource(request.operationId), null)
    assert.equal(f.documents.receipt(metadata.workspace, request.operationId), null)
    assert.deepEqual({ ...plan() }, { state: 'cancelled', plan: null })
    if (current) {
      assert.equal(readFileSync(disk, 'utf8'), current.markdown)
      assert.equal((await f.client.readFile(current.identity))?.markdown, current.markdown)
    } else assert.equal(existsSync(disk), false)
  })
}

for (const read of [true, false]) test(`file forget ${read ? 'retains' : 'omits'} native cleanup for a ${read ? 'reading' : 'non-reading'} native session after host acknowledgement and restart`, async t => {
  const f = await fixture(t), reader = randomUUID(), dispatchOnly = randomUUID()
  const text = 'Manually entered material with no original native occurrence.'
  const created = await f.client.createFile({ operationId: randomUUID(), text })
  assert.equal(f.store.readSource(created.operationId)?.session, null)
  await f.owner.runtime.wake()
  f.owner.initializeSession({ sessionId: reader, cwd: f.store.fileRoot })
  f.owner.runtime.recordSession(dispatchOnly)
  const readFile = (session: string) => f.owner.runtime.handle({ op: 'file_read', session, id: created.identity.id }, { session, conversation: session })
  assert.ok(readFile(dispatchOnly).includes(text))
  if (read) {
    const packet = readFile(reader)
    assert.ok(packet.includes(text))
    assert.deepEqual(f.owner.dispatch.snapshot(reader).fileSources, [created.operationId])
    f.owner.acquireSend(randomUUID(), { session: reader }, packet).settled()
  }
  const detail = (await f.client.readFile(created.identity))!, operationId = randomUUID()
  await f.client.forgetFile({ operationId, identity: created.identity, version: detail.version })
  await f.owner.runtime.wake()
  const [effect] = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  assert.equal(effect?.kind, 'erase-file-copies')
  assert.deepEqual(effect?.sessions?.sort(), (read ? [reader, dispatchOnly] : [dispatchOnly]).sort())
  await f.owner.handleHost('ackHostEffect', { effectId: effect!.effectId, causeOperationId: operationId, revision: effect!.revision })
  await f.reopen()
  await f.owner.runtime.wake()
  const waiting = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  assert.deepEqual(waiting.map(item => item.effectId), read ? [operationId] : [])
  assert.equal(f.owner.runtime.cleanupPending(), 0)
  const native = f.store.db.prepare('SELECT payload FROM owner_file_native_erasures WHERE operation=?').get(operationId)
  const outcome = await f.owner.handleHost('getOperation', { operationId }) as HostMemoryApi['getOperation']['output']
  if (read) {
    assert.deepEqual(JSON.parse(String(native?.payload)), { sessions: [reader], ranges: effect?.ranges })
    assert.doesNotMatch(String(native?.payload), /Manually entered/)
    assert.equal(outcome?.cleanup, 'pending')
    assert.throws(() => f.owner.acquireSend(randomUUID(), { session: reader }, text), /denied/)
  } else {
    assert.equal(native, undefined)
    assert.equal(outcome?.cleanup, 'complete')
  }
})


for (const derived of [true, false]) test(`retired native ${derived ? 'generated' : 'tool'} copies prevent a false clean receipt`, async t => {
  const f = await fixture(t), reader = randomUUID()
  const text = 'Independent manual file that reached a native provider.'
  const created = await f.client.createFile({ operationId: randomUUID(), text })
  await f.owner.runtime.wake()
  f.owner.initializeSession({ sessionId: reader, cwd: f.store.fileRoot })
  const packet = f.owner.runtime.handle({ op: 'file_read', session: reader, id: created.identity.id }, { session: reader, conversation: reader })
  assert.ok(packet.includes(text))
  f.owner.acquireSend(randomUUID(), { session: reader }, packet).settled()
  if (derived) await f.owner.registerDerived({ sessionId: reader, messageId: 'assistant-manual-copy', sourceIds: [] })
  const ticket = await f.owner.prepareContextRecovery({ sessionId: reader, baseSurfaceHash: 'old-native-surface', candidates: [] })
  const ack = { ticketId: ticket.ticketId, replacementMessageId: randomUUID(), replacementHash: randomUUID() }
  f.owner.bindContextRecovery(ack)
  await f.owner.commitContextRecovery({ ...ack, baseSurfaceHash: ticket.baseSurfaceHash, persisted: true }, () => true)
  assert.deepEqual(f.owner.dispatch.snapshot(reader).fileSources ?? [], [])
  const current = (await f.client.readFile(created.identity))!, operationId = randomUUID()
  await f.client.forgetFile({ operationId, identity: created.identity, version: current.version })
  const effect = (await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]).find(item => item.causeOperationId === operationId)!
  assert.ok(effect?.kind === 'erase-file-copies')
  assert.ok(!effect.sessions?.includes(reader), 'retired read sets are separate from live invalidation')
  await f.owner.handleHost('ackHostEffect', { effectId: effect.effectId, causeOperationId: operationId, revision: effect.revision })
  await f.reopen()
  await f.owner.runtime.wake()
  const native = f.store.db.prepare('SELECT payload FROM owner_file_native_erasures WHERE operation=?').get(operationId)
  assert.deepEqual(JSON.parse(String(native?.payload)), { sessions: [reader], ranges: effect.ranges })
  assert.doesNotMatch(String(native?.payload), /reached a native provider/)
  const outcome = await f.owner.handleHost('getOperation', { operationId }) as HostMemoryApi['getOperation']['output']
  assert.equal(outcome?.cleanup, 'pending')
})


test('a stale native read of a different note does not create a new erasure obligation', async t => {
  const f = await fixture(t), reader = randomUUID()
  const text = 'Independent unrelated native projection.'
  const erased = await f.client.createFile({ operationId: randomUUID(), text: 'Never read by a native session.' })
  const kept = await f.client.createFile({ operationId: randomUUID(), text })
  await f.owner.runtime.wake()
  f.owner.initializeSession({ sessionId: reader, cwd: f.store.fileRoot })
  const packet = f.owner.runtime.handle({ op: 'file_read', session: reader, id: kept.identity.id }, { session: reader, conversation: reader })
  assert.match(packet, /Independent unrelated native projection/)
  f.owner.acquireSend(randomUUID(), { session: reader }, packet).settled()
  const before = (await f.client.readFile(kept.identity))!
  await f.client.editFile({ operationId: randomUUID(), identity: kept.identity, version: before.version, text: text + ' Revised.' })
  assert.equal(f.owner.dispatch.stale(reader), true)
  const operationId = randomUUID(), detail = (await f.client.readFile(erased.identity))!
  await f.client.forgetFile({ operationId, identity: erased.identity, version: detail.version })
  const effect = (await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[])
    .find(item => item.causeOperationId === operationId)
  assert.ok(effect?.kind === 'erase-file-copies')
  assert.ok(!effect.sessions?.includes(reader))
  await f.owner.handleHost('ackHostEffect', { effectId: effect!.effectId, causeOperationId: operationId, revision: effect!.revision })
  await f.reopen()
  await f.owner.runtime.wake()
  assert.equal(f.store.db.prepare('SELECT payload FROM owner_file_native_erasures WHERE operation=?').get(operationId), undefined)
  const outcome = await f.owner.handleHost('getOperation', { operationId }) as HostMemoryApi['getOperation']['output']
  assert.equal(outcome?.cleanup, 'complete')
})

test('the host cannot drop exact file ranges while transferring a real file-only readset', async t => {
  const f = await fixture(t), reader = randomUUID(), recipient = randomUUID()
  f.owner.initializeSession({ sessionId: reader })
  f.owner.initializeSession({ sessionId: recipient })
  const result = f.owner.runtime.handle({ op: 'file_read', session: reader, id: f.identity.id }, f.owner.sessionContext(reader))
  assert.match(result, /Friday report/)
  const proof = f.owner.dispatch.snapshot(reader)
  assert.deepEqual(proof.fileSources, [f.sourceId])
  assert.ok(proof.files?.every(file => file.sourceRanges?.length))
  const missing = { ...proof, files: proof.files!.map(({ sourceRanges: _ranges, ...file }) => file) }
  for (const files of [missing.files, [...missing.files, ...proof.files!]]) {
    await assert.rejects(f.owner.handleHost('transfer', { args: [recipient, { ...proof, files }, undefined, true] }), /sourceRanges|complete source ranges/)
    assert.deepEqual(f.owner.dispatch.snapshot(recipient).sources, [])
    await assert.rejects(f.owner.handleHost('transfer', { args: [recipient, { ...proof, sources: [], fileSources: [], files }, undefined, true] }), /sourceRanges/)
  }
  assert.equal(await f.owner.handleHost('transfer', { args: [recipient, proof, undefined, true] }), true)
  assert.deepEqual(f.owner.dispatch.snapshot(recipient).fileSources, [f.sourceId])
})

test('a disjoint read after partial erasure cannot strand a later independent completed human turn', async t => {
  const f = await fixture(t), source = f.store.readSource(f.sourceId)!
  const offset = source.text!.indexOf('Tea')
  const kept = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/wiki/tea.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Tea is served on Monday.', sources: [{ id: source.id,
      token: memorySourceToken(source), spans: [{ start: offset, end: source.text!.length }] }], reads: [] })
  const detail = (await f.client.readFile(f.identity))!
  await f.client.forgetFile({ operationId: randomUUID(), identity: f.identity, version: detail.version })
  assert.ok(f.store.readSource(f.sourceId)?.erasure)
  const reader = randomUUID(), message = randomUUID(), words = 'The reading group has not decided which venue to use.'
  await f.owner.receiveSource({ sessionId: reader, messageId: message, text: words, at: Date.now(), timezone: 'UTC',
    turn: 1, step: 1, admitted: true, inherited: false })
  const packet = f.owner.runtime.handle({ op: 'file_read', session: reader, id: kept.documentId }, f.owner.sessionContext(reader))
  assert.match(packet, /Tea is served on Monday/)
  assert.ok(f.owner.dispatch.snapshot(reader).fileSources?.includes(f.sourceId), 'the exact remaining fragment is still authorized')
  await f.owner.completeTurn({ sessionId: reader, turn: 1, eventSeq: 4, sourceIds: [message], assistant: 'The group is still choosing a venue.',
    completed: true, at: Date.now(), timezone: 'UTC' })
  assert.equal(f.store.db.prepare('SELECT state FROM owner_turns WHERE session=? AND turn=1').get(reader)?.state, 'completed')
  const note = f.store.db.prepare('SELECT source_tokens,assistant_sources FROM memory_note_turns WHERE session=?').get(reader)
  assert.ok(note, 'the independent human turn reaches the real session/daily intake')
  assert.deepEqual((JSON.parse(String(note.source_tokens)) as Array<{ id: string }>).map(ref => ref.id), [message])
  assert.deepEqual(JSON.parse(String(note.assistant_sources)), [], 'unmapped generated prose must not expand a partial file proof to a whole source')
  const notes = openMemoryNotes(f.store, id => Boolean(f.store.readSource(id)?.text))
  const groups = notes.pendingGroups().filter(group => group.session === reader)
  assert.equal(groups.length, 1)
  assert.equal(notes.pending(groups[0]!.note)[0]?.assistant, '')
  assert.match(f.owner.runtime.handle({ op: 'file_read', session: reader, id: kept.documentId }, f.owner.sessionContext(reader)), /Tea is served on Monday/)
})
