import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as shared from './fixtures/memory-file-host.ts'
import type { TestContext, RawIpc, HostMemoryCaller, HostMemoryMethod, HostMemoryApi, MemoryProject, MemoryHostEffect } from './fixtures/memory-file-host.ts'

const { randomUUID, maskTextSpans, withRequestSource, join, existsSync, readFileSync, writeFileSync, scratch, openMemoryOwner, openMemoryStore, openMemoryDocuments, memoryFileRevision, openMemoryNotes, memorySourceToken, memorySourceWorkspace, createVivaMemoryClient, registerRuntimeMemoryIpc, checkedIpc, memoryFileMutationResult, fixture, aborted } = shared

test('admitted routing evidence is withheld during a drained mutation and stays stale in a fresh session', async t => {
  const f = await fixture(t), current = (await f.client.readFile(f.identity))!
  const snapshot = async (session: string, prior?: NonNullable<HostMemoryApi['authorizedProvenance']['output']>) =>
    await f.owner.handleHost('authorizedProvenance', { session, prior }) as HostMemoryApi['authorizedProvenance']['output']
  const stranger = randomUUID()
  assert.equal(await snapshot(stranger), null, 'a request must have a native owner session')
  f.owner.initializeSession({ sessionId: f.session })
  const evidence = await snapshot(f.session)
  assert.ok(evidence && evidence.sources.includes(f.sourceId))
  const permit = f.owner.acquireSend(randomUUID(), { session: f.session }, 'request carrying original proof')
  const forgotten = f.client.forgetFile({ operationId: randomUUID(), identity: f.identity, version: current.version })
  try {
    await aborted(permit.signal)
    assert.equal(await snapshot(f.session), null)
  } finally { permit.settled() }
  await forgotten
  await f.owner.runtime.wake()
  assert.equal(await snapshot(f.session), null)
  f.owner.initializeSession({ sessionId: stranger, cwd: f.store.fileRoot })
  assert.ok(await snapshot(stranger))
  assert.equal(await snapshot(stranger, evidence), null, 'a later readset cannot reauthorize the erased decision')
})

test('history use rejects a stale authorized original or generated reply before the host acknowledges erasure', async t => {
  const f = await fixture(t), file = (await f.client.readFile(f.identity))!, original = f.store.readSource(f.sourceId)!
  const rows = [
    { segmentId: f.session, sessionId: f.session, role: 'user', text: original.text!, sourceId: original.id },
    { segmentId: f.session, sessionId: f.session, role: 'assistant', text: 'Generated report guidance.', sourceId: null },
  ]
  for (const row of rows) assert.equal(await f.owner.handleHost('allowsProjectHistory', { args: [row, undefined, undefined] }), true)
  const target = randomUUID()
  f.owner.initializeSession({ sessionId: target, cwd: f.store.fileRoot })
  const operationId = randomUUID()
  await f.client.forgetFile({ operationId, identity: file.identity, version: file.version })
  const effects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  assert.ok(effects.some(effect => effect.effectId === operationId), 'the host has not acknowledged the erasure')
  for (const row of rows) {
    await assert.rejects(f.owner.handleHost('useHistory', { args: [undefined, row] }), { code: 'revision.conflict' })
    await assert.rejects(f.owner.handleHost('useHistory', { args: [target, row] }), { code: 'revision.conflict' })
  }
  assert.deepEqual(f.owner.dispatch.snapshot(target).sources, [])
  assert.deepEqual(f.owner.dispatch.snapshot(target).files ?? [], [])
  assert.equal(await f.owner.handleHost('transfer', { args: [target, f.owner.dispatch.snapshot(f.session), undefined, true] }), false)

  const independentSession = randomUUID(), independentId = randomUUID(), independentText = 'A separately received original stays available.'
  await f.owner.receiveSource({ sessionId: independentSession, messageId: independentId, text: independentText, at: Date.now(),
    timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false })
  const independent = { segmentId: independentSession, sessionId: independentSession, role: 'user', text: independentText, sourceId: independentId }
  await f.owner.handleHost('useHistory', { args: [target, independent] })
  assert.deepEqual(f.owner.dispatch.snapshot(target).sources, [independentId])
  await f.reopen()
  await assert.rejects(f.owner.handleHost('useHistory', { args: [undefined, rows[0]!] }), { code: 'revision.conflict' })
  await f.owner.handleHost('useHistory', { args: [target, independent] })
  assert.deepEqual(f.owner.dispatch.snapshot(target).sources, [independentId])
})

test('fast routing binds the exact host delivery even before native inbox intake', async t => {
  const f = await fixture(t), sourceId = randomUUID(), words = 'Add the Friday item to my task.'
  const session = f.session, conversation = f.session
  await f.owner.handleHost('sourceAlias', { operationId: sourceId, sourceId, session, conversation, text: words })
  const read = (sessionId: string, id?: string) =>
    f.owner.handleHost('authorizedProvenance', { session: sessionId, sourceId: id }) as Promise<HostMemoryApi['authorizedProvenance']['output']>
  assert.equal(await read(session, sourceId), null, 'an alias without a wire binding is insufficient')
  const bound = await f.owner.handleHost('bindWireAlias', { args: [session, words, `Late user message: ${words}`, sourceId] }) as { wireText: string }
  assert.ok((await read(session, sourceId))?.sources.includes(sourceId))
  assert.equal((await read(session))?.sources.includes(sourceId), false, 'the proof is request-local until native admission')
  await f.owner.receiveSource({ sessionId: session, messageId: randomUUID(), text: bound.wireText,
    at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: false, inherited: false })
  assert.ok((await read(session, sourceId))?.sources.includes(sourceId))
  assert.equal((await read(session))?.sources.includes(sourceId), false)
  const other = randomUUID()
  f.owner.initializeSession({ sessionId: other, cwd: f.store.fileRoot })
  assert.equal(await read(other, sourceId), null, 'a different session cannot claim this input')
})

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
    revision: before.version.contentRevision, usageVersion: before.version.usageVersion, policyToken: before.version.policyToken, sourceRanges: [{ sourceId: f.sourceId, spans: [{ start: 0, end: 25 }] }] }])
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
  assert.equal(Object.hasOwn(effects[0]!, 'memoryIds'), false)
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
  const source = f.store.readSource(f.sourceId)!
  const profile = f.documents.commit({ operationId: randomUUID(), workspace: f.identity.workspace, path: 'digest/personal/report-habits.md',
    expectedRevision: null, action: 'CREATE', markdown: 'Prefers weekly progress on Friday.', sources: [{ id: source.id, token: memorySourceToken(source) }], reads: [] })
  const listeners = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const ipc = checkedIpc({ handle: (name, listener) => { listeners.set(name, listener) }, on: () => {} })
  const localLink = 'viva://timeline/segment/0/1'
  registerRuntimeMemoryIpc(ipc, { client: f.client, cwd: () => '', habits: () => ({ text: '', samples: 0 }), chooseDocs: async () => null,
  sourceLink: (sourceId) => sourceId === f.sourceId ? localLink : null })
  const call = (channel: string, ...args: unknown[]) => listeners.get(channel)!({}, ...args)
  const page = await call('memory:get') as { fileProfile: HostMemoryApi['fileProfile']['output'] }
  assert.equal(Object.hasOwn(page, 'items'), false)
  assert.equal(Object.hasOwn(page, 'summaries'), false)
  const profileIdentity = { ...f.identity, id: profile.documentId }
  assert.deepEqual(page.fileProfile, { user: [{ identity: profileIdentity, text: 'Prefers weekly progress on Friday.' }], project: null })
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

test('file profiles use current scoped, undisputed digest evidence rather than legacy facts', async t => {
  const f = await fixture(t)
  const add = (sourceId: string, path: string, text: string) => {
    const source = f.store.readSource(sourceId)!
    const workspace = memorySourceWorkspace(source)
    const refs = [{ id: source.id, token: memorySourceToken(source) }]
    const result = f.documents.commit({ operationId: randomUUID(), workspace, path, expectedRevision: null, action: 'CREATE', markdown: text, sources: refs, reads: [] })
    return { kind: 'digest' as const, workspace, id: result.documentId }
  }
  const user = add(f.sourceId, 'digest/personal/work-style.md', `Weekly reports on Friday. [[${f.created.path}]]`)
  const project: MemoryProject = { kind: 'project', id: 'test-project' }
  const projectText = 'Project releases use the staged build.', projectSource = randomUUID()
  await f.owner.receiveSource({ sessionId: randomUUID(), messageId: projectSource, text: projectText, project: project.id,
    at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false })
  const projectFile = add(projectSource, 'digest/personal/project-release.md', projectText)
  assert.deepEqual(await f.client.fileProfile(), { user: [{ identity: user, text: 'Weekly reports on Friday.' }], project: null })
  assert.deepEqual((await f.client.fileProfile(project)).project, [{ identity: projectFile, text: projectText }])
  assert.deepEqual((await f.client.fileProfile({ kind: 'project', id: 'other-project' })).project, [])

  const detail = (await f.client.readFile(user))!
  assert.equal(detail.sources[0]?.sourceId, f.sourceId)
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: user, version: detail.version, enabled: false })
  assert.deepEqual((await f.client.fileProfile(project)).user, [])
  const stopped = (await f.client.readFile(user))!
  await f.client.setFileEnabled({ operationId: randomUUID(), identity: user, version: stopped.version, enabled: true })
  assert.equal((await f.client.fileProfile(project)).user.length, 1)

  const source = f.store.readSource(projectSource)!, path = 'digest/personal/project-release.md'
  f.documents.defer({ operationId: 'test-pending-profile', workspace: projectFile.workspace,
    unit: { name: 'Project releases', bucket: 'personal', summary: projectText, paths: [path] },
    reason: 'The rollout environment is disputed.', sources: [{ id: source.id, token: memorySourceToken(source) }],
    reads: [f.documents.read(projectFile.workspace, path)!], files: [], readPolicies: [] })
  assert.deepEqual((await f.client.fileProfile(project)).project, [])
  assert.equal((await f.client.fileProfile(project)).user.length, 1)
})

test('file-mode cleanup stays pending until both host and native owners complete their copies', async t => {
  const f = await fixture(t), detail = (await f.client.readFile(f.identity))!
  const operationId = randomUUID()
  await f.client.forgetFile({ operationId, identity: f.identity, version: detail.version })
  await f.reopen()
  assert.equal(f.owner.runtime.cleanupPending(), 0)
  assert.equal(await f.client.cleanupPending(), 1)
  const effects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  const effect = effects.find(item => item.effectId === operationId)!
  assert.equal(effect.kind, 'erase-file-copies')
  await f.owner.handleHost('ackHostEffect', { effectId: effect.effectId, causeOperationId: effect.causeOperationId, revision: effect.revision })
  assert.equal(await f.client.cleanupPending(), 1, 'host acknowledgement cannot settle a pending native copy')
  const { createNativeErasureReceipts } = await import('../src/memory/node/native-erasure-receipts.ts')
  createNativeErasureReceipts(f.store.db).acknowledge(operationId, 'c'.repeat(64))
  assert.equal(await f.client.cleanupPending(), 0)
  assert.ok(f.store.db.prepare('SELECT 1 FROM owner_file_native_erasures WHERE operation=?').get(operationId), 'the immutable plan remains auditable')
  assert.deepEqual(await f.owner.handleHost('pendingHostEffects', {}), [])
})

test('file profile keeps unrelated lines while withholding a verified superseded fragment', async t => {
  const f = await fixture(t), original = f.store.readSource(f.sourceId)!
  const common = { workspace: f.identity.workspace, sources: [{ id: original.id, token: memorySourceToken(original) }], reads: [] }
  const personal = f.documents.commit({ ...common, operationId: randomUUID(), path: 'digest/personal/drink.md', expectedRevision: null,
    action: 'CREATE', markdown: 'Schedules drinks for weekends.\nKeeps reports concise.' })
  const prior = f.documents.commit({ ...common, operationId: randomUUID(), path: 'digest/wiki/new-drink.md', expectedRevision: null,
    action: 'CREATE', markdown: 'Review the drink schedule' })
  f.documents.commit({ ...common, operationId: randomUUID(), path: prior.path, expectedRevision: prior.revision, action: 'CORRECT',
    markdown: 'Schedules drinks for weekdays.', corrections: [{ path: personal.path, revision: personal.revision!, startLine: 1, endLine: 1,
      text: 'Schedules drinks for weekends.', time: '', condition: '' }] })
  const profile = await f.client.fileProfile()
  assert.deepEqual(profile.user, [{ identity: { ...f.identity, id: personal.documentId }, text: 'Keeps reports concise.' }])
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
