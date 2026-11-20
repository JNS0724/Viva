import { legacyDailyRename } from './fixtures/memory-note-fixture.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import type { MemoryHostEffect } from '../src/memory/contracts/service.ts'
import type { MemoryFileDetail, MemoryFileListResult, MemoryFileMutationResult, MemoryFileSetEnabledRequest, MemoryManagedFileIdentity } from '../src/memory/contracts/file-management.ts'

async function fixture(t: TestContext) {
  const { dir, defer } = scratch(t, 'memory-daily-usage-')
  const at = Date.now(), day = new Date(at).toISOString().slice(0, 10)
  const session = randomUUID()
  const options = { root: dir, hostNamespace: 'viva-test', dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {},
    async compute(job: import('../src/memory/contracts/memory-contract.ts').MemoryCompute) {
      if (job.stage !== 'note') return '{"proposals":[]}'
      const input = JSON.parse(job.input) as { existing?: { markdown: string }, turns: { user: { text: string }[] }[] }
      return JSON.stringify({ status: 'write', title: input.turns[0]?.user[0]?.text ?? 'Daily note',
        markdown: [input.existing?.markdown, ...input.turns.flatMap(turn => turn.user.map(user => user.text.trim()))].filter(Boolean).join('\n') })
    },
  }
  let owner = openMemoryOwner(options)
  defer(() => owner.close())
  await owner.recover()
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  let turn = 0
  async function add(text: string) {
    const messageId = randomUUID(), contextGeneration = owner.contextGeneration(session)
    turn++
    await owner.receiveSource({ sessionId: session, messageId, text, at, timezone: 'UTC', turn, step: 1,
      admitted: true, inherited: false, contextGeneration })
    await owner.completeTurn({ sessionId: session, turn, eventSeq: turn * 3, sourceIds: [messageId], assistant: '',
      completed: true, at, timezone: 'UTC', contextGeneration })
    await owner.runtime.wake()
    return { messageId, content: text }
  }
  async function find() {
    const list = await owner.handleHost('listFiles', { args: [{ kind: 'daily' }] }) as MemoryFileListResult
    assert.equal(list.items.length, 1)
    return detail(list.items[0]!.identity)
  }
  async function detail(identity: MemoryManagedFileIdentity) {
    const item = await owner.handleHost('readFile', { args: [identity] }) as MemoryFileDetail | null
    assert.ok(item)
    return item
  }
  const set = (input: MemoryFileSetEnabledRequest) => owner.handleHost('setFileEnabled', { args: [input] }) as Promise<MemoryFileMutationResult>
  return { get owner() { return owner }, add, find, detail, set, store, day, session,
    async reopen(dailyNotes: typeof options.dailyNotes | false = options.dailyNotes) {
      await owner.close(); owner = openMemoryOwner({ ...options, dailyNotes }); await owner.recover(); await owner.runtime.wake()
    } }
}

const stopInput = (file: MemoryFileDetail) => ({ operationId: randomUUID(), identity: file.identity, version: file.version, enabled: false })

async function retireStoppedOriginal(f: Awaited<ReturnType<typeof fixture>>, first: { messageId: string, content: string }) {
  const ticket = await f.owner.prepareContextRecovery({ sessionId: f.session, baseSurfaceHash: 'stopped-surface', candidates: [first] })
  assert.deepEqual(ticket.retainedMessageIds, [])
  const bound = { sessionId: ticket.sessionId, ticketId: ticket.ticketId, replacementMessageId: randomUUID(), replacementHash: randomUUID() }
  f.owner.bindContextRecovery(bound)
  await f.owner.commitContextRecovery({ ...bound, baseSurfaceHash: ticket.baseSurfaceHash, persisted: true }, () => true)
}

test('daily restrictions survive empty projection and restart and can be lifted individually after independent input', async t => {
  const f = await fixture(t), first = await f.add('The first launch item is due Friday.'), initial = await f.find()
  assert.equal(initial.enabled, true)
  assert.equal(initial.hasProjection, true)
  assert.equal(initial.actions.forget, true)
  assert.deepEqual(initial.restrictions, [])
  const stopFirst = stopInput(initial), stopped = await f.set(stopFirst)
  assert.equal(stopped.restrictionId, stopFirst.operationId)
  await f.owner.runtime.wake()
  const empty = await f.detail(initial.identity)
  assert.equal(empty.hasProjection, false)
  assert.equal(empty.markdown, '')
  assert.equal(empty.actions.forget, true)
  assert.equal(empty.path, initial.path)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(first.messageId), false)
  const dayIndex = join(f.store.fileRoot, initial.identity.workspace, `daily/${f.day}.md`)
  assert.ok(!readFileSync(dayIndex, 'utf8').includes(initial.path))
  const earlier = empty.restrictions![0]!
  await f.reopen()
  assert.deepEqual(await f.set(stopFirst), stopped)
  assert.deepEqual((await f.detail(initial.identity)).restrictions, [earlier])
  const retained = await f.owner.handleHost('readFile', { args: [initial.identity, earlier.id] }) as MemoryFileDetail
  assert.equal(retained.stoppedSnapshot?.markdown, initial.markdown)
  assert.equal(retained.actions.forget, false)
  assert.equal(await f.owner.handleHost('readFile', { args: [initial.identity, randomUUID()] }), null)

  await retireStoppedOriginal(f, first)
  const second = await f.add('The afternoon tea is served Monday.'), fresh = await f.detail(initial.identity)
  assert.equal(fresh.path, initial.path)
  assert.deepEqual(fresh.identity, initial.identity)
  assert.equal(fresh.hasProjection, true)
  assert.equal(fresh.enabled, true)
  assert.match(fresh.markdown, /afternoon tea/)
  assert.doesNotMatch(fresh.markdown, /first launch/)
  assert.deepEqual(fresh.restrictions, [earlier])
  assert.ok(readFileSync(dayIndex, 'utf8').includes(fresh.path))
  assert.doesNotMatch(fresh.path, /first.launch/i)
  const reader = randomUUID()
  const recalled = f.owner.runtime.handle({ op: 'recall', session: reader, query: 'afternoon tea' }, { session: reader, conversation: reader })
  assert.match(recalled, /afternoon tea/)
  assert.doesNotMatch(recalled, /first.launch/i)
  await assert.rejects(f.set(stopInput(initial)), { code: 'revision.conflict' })

  const stopSecond = await f.set(stopInput(fresh))
  await f.owner.runtime.wake()
  assert.deepEqual((await f.detail(initial.identity)).restrictions?.map(item => item.id), [earlier.id, stopSecond.restrictionId])
  const enable = { operationId: randomUUID(), identity: fresh.identity, enabled: true, restrictionId: earlier.id, version: earlier.version }
  await assert.rejects(f.set({ ...enable, operationId: randomUUID(), restrictionId: stopSecond.restrictionId }), { code: 'revision.conflict' })
  const enabled = await f.set(enable)
  await f.owner.runtime.wake()
  const restored = await f.detail(initial.identity)
  assert.equal(restored.path, initial.path)
  assert.match(restored.markdown, /first launch/)
  assert.doesNotMatch(restored.markdown, /afternoon tea/)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(first.messageId), true)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(second.messageId), false)
  assert.deepEqual(restored.restrictions?.map(item => item.id), [stopSecond.restrictionId])
  assert.deepEqual(await f.set(enable), enabled)
  const hostEffects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  for (const [operation, source] of [[stopped.operationId, first.messageId],
    [stopSecond.operationId, second.messageId], [enabled.operationId, first.messageId]]) {
    const effect = hostEffects.find(item => item.causeOperationId === operation)
    assert.deepEqual(effect?.sources.map(ref => ref.sourceId), [source])
  }
  await assert.rejects(f.set({ ...enable, operationId: randomUUID() }), { code: 'revision.conflict' })
})


test('withdrawing one stopped source leaves another daily restriction addressable after restart', async t => {
  const f = await fixture(t), first = await f.add('Private detail about the first delivery.'), initial = await f.find()
  const stopFirst = await f.set(stopInput(initial))
  await f.owner.runtime.wake()
  await retireStoppedOriginal(f, first)
  const second = await f.add('The second delivery is independent.'), fresh = await f.detail(initial.identity)
  const stopSecond = await f.set(stopInput(fresh))
  await f.owner.runtime.wake()
  const stopped = await f.detail(initial.identity)
  const restriction = stopped.restrictions!.find(item => item.id === stopSecond.restrictionId)!
  const operationId = randomUUID()
  const { ticket } = await f.owner.handleHost('prepareSourceChange', { operationId, conversation: f.session,
    onlySources: true, ids: [first.messageId] }) as { ticket: string }
  await f.owner.handleHost('commitSourceChange', { operationId, ticket })
  await f.reopen()
  const remaining = await f.detail(initial.identity)
  assert.equal(remaining.hasProjection, false)
  assert.equal(remaining.markdown, '')
  assert.deepEqual(remaining.restrictions, [restriction])
  assert.notEqual(remaining.path, initial.path, 'withdrawal drops the prior source-derived filename')
  assert.equal(f.store.sourceExcluded(first.messageId), true)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(second.messageId), false)
  await assert.rejects(f.set({ operationId: randomUUID(), identity: initial.identity, enabled: true, restrictionId: stopFirst.restrictionId,
    version: stopped.restrictions!.find(item => item.id === stopFirst.restrictionId)!.version }), { code: 'revision.conflict' })
  await f.set({ operationId: randomUUID(), identity: initial.identity, enabled: true, restrictionId: restriction.id, version: restriction.version })
  await f.owner.runtime.wake()
  const restored = await f.detail(initial.identity)
  assert.match(restored.markdown, /second delivery is independent/)
  assert.doesNotMatch(restored.markdown, /Private detail/)
  assert.deepEqual(restored.restrictions, [])
})

test('a lost owner completion replays the daily receipt and invalidation without creating a second restriction', async t => {
  const f = await fixture(t)
  const source = await f.add('Review every Tuesday.')
  const daily = await f.find(), input = stopInput(daily)
  f.store.db.exec(`CREATE TRIGGER interrupt_owner_completion BEFORE UPDATE ON owner_operations
    WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'simulated owner interruption'); END`)
  await assert.rejects(f.set(input), /simulated owner interruption/)
  f.store.db.exec('DROP TRIGGER interrupt_owner_completion')
  const saved = (await f.detail(daily.identity)).restrictions!
  assert.deepEqual(saved.map(item => item.id), [input.operationId])
  await f.reopen()
  const result = await f.set(input)
  assert.equal(result.restrictionId, input.operationId)
  assert.deepEqual((await f.detail(daily.identity)).restrictions, saved)
  const hostEffects = await f.owner.handleHost('pendingHostEffects', {}) as MemoryHostEffect[]
  assert.deepEqual(hostEffects.map(effect => [effect.causeOperationId, effect.sources.map(ref => ref.sourceId)]),
    [[input.operationId, [source.messageId]]])
  await assert.rejects(f.set({ ...input, enabled: true }), { code: 'operation.conflict' })
})


test('turning off daily capture keeps existing stopped original sources fenced', async t => {
  const f = await fixture(t), source = await f.add('A stopped delivery.'), card = await f.find()
  await f.set(stopInput(card))
  await f.reopen(false)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(source.messageId), false)
  assert.throws(() => f.owner.acquireSend(randomUUID(), { session: f.session }, source.content), /denied/)
  const transcript = join(f.store.fileRoot, card.identity.workspace, 'session', 'dialog', `${memoryFileRevision(f.session)}.jsonl`)
  assert.match(readFileSync(transcript, 'utf8'), /A stopped delivery/)
  const operationId = randomUUID()
  const { ticket } = await f.owner.handleHost('prepareSourceChange', { operationId, conversation: f.session,
    onlySources: true, ids: [source.messageId] }) as { ticket: string }
  await f.owner.handleHost('commitSourceChange', { operationId, ticket })
  await f.owner.runtime.wake()
  assert.equal(existsSync(transcript), false)
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM memory_file_use_restrictions').get()?.n, 0)
  assert.equal((await f.owner.handleHost('getOperation', { operationId }) as { cleanup: string }).cleanup, 'complete')
})

test('an older file layout fails before starting an owner that could ignore existing restrictions', t => {
  const { dir, defer } = scratch(t, 'memory-previous-file-layout-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  store.close()
  const db = new DatabaseSync(join(dir, 'memory.db'))
  defer(() => db.close())
  db.exec('CREATE TABLE memory_document_use_restrictions (document TEXT PRIMARY KEY, sources TEXT NOT NULL)')
  assert.throws(() => openMemoryOwner({ root: dir, dailyNotes: false, route: () => null, compute: () => null,
    quiesce: async () => {} }), /Memory file layout is incompatible/)
})


test('withdrawing part of a stopped snapshot removes its body while retaining the independent limit', async t => {
  const f = await fixture(t), first = await f.add('Withdraw this private item.')
  await f.add('Retain this independent item.')
  const card = await f.find(), stopped = await f.set(stopInput(card))
  await f.owner.runtime.wake()
  const prior = (await f.find()).restrictions![0]!
  assert.equal(prior.id, stopped.restrictionId)
  const archived = await f.owner.handleHost('readFile', { args: [card.identity, prior.id] }) as MemoryFileDetail
  assert.match(archived.stoppedSnapshot!.markdown!, /Withdraw this private item/)
  const operationId = randomUUID()
  const { ticket } = await f.owner.handleHost('prepareSourceChange', { operationId, conversation: f.session,
    onlySources: true, ids: [first.messageId] }) as { ticket: string }
  await f.owner.handleHost('commitSourceChange', { operationId, ticket })
  await f.owner.runtime.wake()
  const reduced = await f.owner.handleHost('readFile', { args: [card.identity, prior.id] }) as MemoryFileDetail
  assert.equal(reduced.stoppedSnapshot?.markdown, null)
  assert.equal(reduced.actions.forget, false)
  assert.equal(reduced.stoppedSnapshot?.sources.length, 1)
  assert.equal(reduced.restrictions?.[0]?.id, prior.id)
  assert.notEqual(reduced.restrictions?.[0]?.version.policyToken, prior.version.policyToken)
  await assert.rejects(f.set({ operationId: randomUUID(), identity: card.identity, version: prior.version,
    enabled: true, restrictionId: prior.id }), { code: 'revision.conflict' })
})

/** Reopen the data layout of an older release that had already accepted a rename. */
async function priorDailyRename(f: Awaited<ReturnType<typeof fixture>>, initial: MemoryFileDetail, name: string) {
  const notes = openMemoryNotes(f.store, id => Boolean(f.store.readSource(id)?.text))
  const allocation = notes.allocations().find(item => item.path === initial.path)!
  const to = `daily/${f.day}/${name}.md`
  legacyDailyRename(f.store, allocation, to)
  await f.reopen()
  const renamed = await f.detail(initial.identity)
  assert.equal(renamed.path, to)
  return { renamed, allocation }
}

function fixtureDocuments(f: Awaited<ReturnType<typeof fixture>>) {
  return openMemoryDocuments({ db: f.store.db, root: f.store.fileRoot, source(id) {
    const row = f.store.readSource(id)
    return row?.text ? { text: row.text, workspace: memorySourceWorkspace(row), token: memorySourceToken(row) } : undefined
  } })
}

test('a prior external daily filename cannot carry stopped content into a later model projection', async t => {
  const f = await fixture(t), original = await f.add('PrivateExternalRename is a stopped marker.'), initial = await f.find()
  const { renamed, allocation } = await priorDailyRename(f, initial, 'PrivateExternalRename')
  await f.set(stopInput(renamed))
  await f.owner.runtime.wake()
  await retireStoppedOriginal(f, original)
  await f.add('The afternoon tea is an unrelated topic.')
  const rebuilt = await f.find()
  assert.deepEqual(rebuilt.identity, initial.identity)
  assert.notEqual(rebuilt.path, renamed.path)
  assert.doesNotMatch(rebuilt.path, /PrivateExternalRename/)
  assert.equal(f.store.db.prepare('SELECT 1 FROM memory_note_aliases WHERE note=?').get(allocation.key), undefined)
  const session = randomUUID()
  const packet = f.owner.runtime.handle({ op: 'recall', session, query: 'afternoon tea' }, { session, conversation: session })
  assert.match(packet, /afternoon tea/)
  assert.doesNotMatch(packet, /PrivateExternalRename/)
})

test('stopping a digest retires a daily alias carrying the shared stopped evidence', async t => {
  const f = await fixture(t), privateText = 'PrivateSharedProject is temporarily confidential. '
  const { messageId } = await f.add(privateText + 'IndependentTea is on Monday.')
  const daily = await f.find()
  const { renamed, allocation } = await priorDailyRename(f, daily, 'PrivateSharedProject')
  const ref = f.store.readSource(messageId)!
  const digest = fixtureDocuments(f).commit({ workspace: daily.identity.workspace, operationId: randomUUID(), action: 'CREATE',
    path: 'digest/wiki/neutral.md', markdown: privateText, expectedRevision: null, reads: [],
    sources: [{ id: ref.id, token: memorySourceToken(ref), spans: [{ start: 0, end: privateText.length }] }] })
  const target = await f.detail({ workspace: daily.identity.workspace, kind: 'digest', id: digest.documentId })
  await f.set(stopInput(target))
  await f.owner.runtime.wake()
  const rebuilt = await f.find()
  assert.deepEqual(rebuilt.identity, daily.identity)
  assert.notEqual(rebuilt.path, renamed.path)
  assert.equal(f.store.db.prepare('SELECT 1 FROM memory_note_aliases WHERE note=?').get(allocation.key), undefined)
  assert.match(rebuilt.markdown, /IndependentTea/)
  const reader = randomUUID()
  const packet = f.owner.runtime.handle({ op: 'recall', session: reader, query: 'IndependentTea' }, { session: reader, conversation: reader })
  assert.match(packet, /IndependentTea/)
  assert.doesNotMatch(packet, /PrivateSharedProject/)
})

test('a daily projection with unavailable current applicability can still be stopped as evidence', async t => {
  const f = await fixture(t), old = 'Prior original schedule Friday.'
  await f.add(old)
  const initial = await f.find(), replacement = randomUUID(), session = randomUUID()
  await f.owner.receiveSource({ sessionId: session, messageId: replacement, text: 'Confirmed schedule Saturday.',
    at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false })
  const documents = fixtureDocuments(f)
  const source = f.store.readSource(replacement)!
  const base = { workspace: initial.identity.workspace, path: 'digest/wiki/schedule.md',
    sources: [{ id: source.id, token: memorySourceToken(source) }], reads: [] }
  const first = documents.commit({ ...base, operationId: randomUUID(), action: 'CREATE', expectedRevision: null, markdown: 'Proposed change' })
  const line = initial.markdown.split('\n').indexOf(old) + 1
  const saved = documents.commit({ ...base, operationId: randomUUID(), action: 'CORRECT', expectedRevision: first.revision,
    markdown: 'Confirmed schedule Saturday.', corrections: [{ path: initial.path, revision: initial.version.contentRevision,
      startLine: line, endLine: line, text: old, condition: '', time: '' }] })
  const digest = await f.detail({ kind: 'digest', workspace: initial.identity.workspace, id: saved.documentId })
  await f.set(stopInput(digest))
  const pending = await f.detail(initial.identity)
  assert.equal(pending.applicability, 'unavailable')
  assert.equal(pending.hasProjection, true)
  assert.equal(pending.actions.stop, true)
  const reader = randomUUID()
  const examine = () => f.owner.runtime.handle({ op: 'file_read', session: reader, id: initial.identity.id, evidence: true },
    { session: reader, conversation: reader })
  assert.match(examine(), /Prior original schedule Friday/)
  await f.set(stopInput(pending))
  assert.doesNotMatch(examine(), /Prior original schedule Friday/)
})

test('a daily correction quotation is erased from the independent digest and its deferred work on source withdrawal', async t => {
  const f = await fixture(t), marker = 'Confidential original detail on Monday.', original = await f.add(marker)
  const daily = await f.find(), workspace = daily.identity.workspace, replacementText = 'The confirmed detail is now Tuesday.'
  const replacementId = randomUUID()
  await f.owner.receiveSource({ sessionId: randomUUID(), messageId: replacementId, text: replacementText,
    at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false })
  const source = f.store.readSource(replacementId)!, documents = fixtureDocuments(f)
  const base = { workspace, path: 'digest/wiki/confirmed-schedule.md',
    sources: [{ id: source.id, token: memorySourceToken(source) }], reads: [] }
  const draft = documents.commit({ ...base, operationId: randomUUID(), action: 'CREATE', expectedRevision: null, markdown: 'Draft' })
  const line = daily.markdown.split('\n').indexOf(marker) + 1
  documents.commit({ ...base, operationId: randomUUID(), action: 'CORRECT', expectedRevision: draft.revision, markdown: replacementText,
    corrections: [{ path: daily.path, revision: daily.version.contentRevision, startLine: line, endLine: line, text: marker, condition: '', time: '' }] })
  const snapshot = documents.read(workspace, base.path)!
  const question = documents.defer({ ...base, operationId: randomUUID(), unit: { name: 'Schedule', bucket: 'personal', summary: 'Confirm the schedule', paths: [] },
    reason: marker, reads: [snapshot], files: [] })
  const operationId = randomUUID()
  const { ticket } = await f.owner.handleHost('prepareSourceChange', { operationId, conversation: f.session,
    onlySources: true, ids: [original.messageId] }) as { ticket: string }
  await f.owner.handleHost('commitSourceChange', { operationId, ticket })
  await f.reopen()
  const reopened = fixtureDocuments(f)
  assert.equal(reopened.deferred(workspace, question.operationId), null)
  assert.equal(reopened.read(workspace, base.path)?.markdown, replacementText)
  assert.equal(reopened.supersessions(workspace, daily.path)[0]?.text, '')
  assert.equal((await f.owner.handleHost('getOperation', { operationId }) as { cleanup: string }).cleanup, 'complete')
  const retained = JSON.stringify(f.store.db.prepare('SELECT before,after FROM memory_document_revisions').all())
  assert(!retained.includes(marker))
  const later = 'An independent lavender routine.'
  await f.add(later)
  const fresh = await f.find()
  assert.deepEqual(fresh.identity, daily.identity)
  assert.equal(fresh.applicability, 'current')
  const reader = randomUUID()
  const packet = f.owner.runtime.handle({ op: 'recall', session: reader, query: 'lavender' }, { session: reader, conversation: reader })
  assert.match(packet, /independent lavender routine/)
  assert.doesNotMatch(packet, /Confidential original detail/)
})

test('file deletion rejects stopped snapshots and preserves both the current file and the prior restriction', async t => {
  const f = await fixture(t), a = await f.add('Private earlier evidence for Tuesday.'), first = await f.find()
  const stopped = await f.set(stopInput(first))
  await f.owner.runtime.wake()
  await retireStoppedOriginal(f, a)
  const second = await f.add('Independent lavender note.'), current = await f.find()
  const scope = current.restrictions!.find(restriction => restriction.id === stopped.restrictionId)!
  const forget = (request: object) => f.owner.handleHost('forgetFile', { args: [request] })
  const input = { operationId: randomUUID(), identity: current.identity, restrictionId: scope.id, version: scope.version }
  await assert.rejects(forget({ ...input, operationId: randomUUID(), version: current.version }), { code: 'invalid.text' })
  await assert.rejects(forget(input), { code: 'invalid.text' })
  await f.reopen()
  const remaining = await f.find()
  assert.deepEqual(remaining.restrictions, current.restrictions)
  assert.equal(remaining.path, current.path)
  assert.match(remaining.markdown, /Independent lavender note/)
  assert.doesNotMatch(remaining.markdown, /Private earlier evidence/)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(second.messageId), true)
  assert.equal(f.owner.runtime.dispatchSourceCurrent(a.messageId), false)
})

test('stopped correction evidence supplies neither private applicability text nor dependency to an independent daily rebuild', async t => {
  const f = await fixture(t), line = 'Identical quotation on the schedule.', secret = 'Confidential approved condition.'
  const original = await f.add(`${line}\n${secret}`), initial = await f.find()
  const lineNumber = initial.markdown.split('\n').findIndex(text => text === line) + 1
  assert(lineNumber > 0)
  const replacementSession = randomUUID(), replacementId = randomUUID(), replacementText = 'Use the new schedule independently.'
  await f.owner.receiveSource({ sessionId: replacementSession, messageId: replacementId, text: replacementText,
    at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false })
  const replacement = f.store.readSource(replacementId)!, documents = fixtureDocuments(f)
  const base = { workspace: initial.identity.workspace, path: 'digest/wiki/replacement.md',
    sources: [{ id: replacement.id, token: memorySourceToken(replacement) }], reads: [] }
  const draft = documents.commit({ ...base, operationId: randomUUID(), action: 'CREATE', expectedRevision: null, markdown: replacementText })
  documents.commit({ ...base, operationId: randomUUID(), action: 'CORRECT', expectedRevision: draft.revision, markdown: replacementText,
    corrections: [{ path: initial.path, revision: initial.version.contentRevision, startLine: lineNumber, endLine: lineNumber,
      text: line, condition: secret, time: '' }] })
  const active = await f.find()
  await f.set(stopInput(active))
  await f.owner.runtime.wake()
  await retireStoppedOriginal(f, original)
  const independent = await f.add(line), rebuilt = await f.find(), reader = randomUUID()
  const packet = f.owner.runtime.handle({ op: 'file_read', session: reader, id: rebuilt.identity.id, evidence: true },
    { session: reader, conversation: reader })
  assert.match(packet, /Identical quotation on the schedule/)
  assert.match(packet, /replacement/)
  assert.doesNotMatch(packet, /Confidential approved condition/)
  const evidence = await f.owner.handleHost('provenance', { args: [reader] }) as import('../src/memory/contracts/records.ts').MemoryProvenance
  const sources = evidence.files?.flatMap(file => file.sourceRanges?.map(ref => ref.sourceId) ?? []) ?? []
  assert(sources.includes(independent.messageId))
  assert(!sources.includes(original.messageId))
})


test('a changed stopped daily snapshot cannot advertise permanent forget or authorize its old proof', async t => {
  const f = await fixture(t)
  await f.add('A private stopped daily record.')
  const before = await f.find(), stopped = await f.set(stopInput(before))
  await f.owner.runtime.wake()
  const restriction = (await f.find()).restrictions!.find(item => item.id === stopped.restrictionId)!
  const read = () => f.owner.handleHost('readFile', { args: [before.identity, restriction.id] }) as Promise<MemoryFileDetail>
  assert.equal((await read()).actions.forget, false)
  f.store.db.prepare('UPDATE memory_file_use_restrictions SET snapshot=snapshot || ? WHERE id=?').run('\nchanged externally', restriction.id)
  const changed = await read()
  assert.equal(changed.actions.forget, false)
  assert.equal(changed.stoppedSnapshot?.markdown, null)
  await assert.rejects(f.owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: before.identity,
    restrictionId: restriction.id, version: restriction.version }] }), { code: 'invalid.text' })
})


test('deleting the only daily file retires its search passages and vectors while preserving the source', async t => {
  const f = await fixture(t), original = await f.add('A single indexed daily entry.'), file = await f.find()
  const db = f.store.db
  const reader = randomUUID()
  f.owner.runtime.handle({ op: 'recall', session: reader, query: 'single indexed daily entry' }, { session: reader, conversation: reader })
  const node = () => db.prepare('SELECT id FROM memory_file_index_nodes WHERE workspace=? AND id=?').get(file.identity.workspace, file.identity.id)
  const chunks = () => db.prepare('SELECT payload FROM memory_file_index_chunks WHERE workspace=? AND file_id=?').all(file.identity.workspace, file.identity.id)
  const vectors = () => db.prepare("SELECT ref FROM memory_file_index_vectors WHERE json_extract(ref,'$[0]')=? AND json_extract(ref,'$[1]')=?").all(file.identity.workspace, file.identity.id)
  assert.ok(node())
  const parts = chunks()
  assert.ok(parts.length)
  // The fixture uses a local model for notes only. Seed one vector for a genuine indexed passage.
  const { ref } = JSON.parse(String(parts[0]!.payload)) as { ref: { workspace: string, fileId: string, ordinal: number, revision: string, usageVersion: number, policyToken: string } }
  const key = JSON.stringify([ref.workspace, ref.fileId, ref.ordinal, ref.revision, ref.usageVersion, ref.policyToken])
  db.prepare('INSERT INTO memory_file_index_vectors(generation,ref,passage,vector) VALUES(?,?,?,?)').run(0, key, 0, new Uint8Array(new Float32Array([1]).buffer))
  assert.ok(vectors().length)

  await f.owner.handleHost('forgetFile', { args: [{ operationId: randomUUID(), identity: file.identity, version: file.version }] })
  assert.equal(node(), undefined)
  assert.deepEqual(chunks(), [])
  assert.deepEqual(vectors(), [])
  await f.reopen()
  assert.equal(f.owner.runtime.readFile(file.identity), null)
  assert.equal(f.store.readSource(original.messageId)?.text, original.content)
})
