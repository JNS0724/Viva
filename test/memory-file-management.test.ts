import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createMemoryFileManagement } from '../src/memory/core/memory-file-management.ts'
import { createMemoryDocumentReadPolicy } from '../src/memory/core/memory-document-read-policy.ts'
import type { DocumentSnapshot, DocumentUndoCandidate, DocumentSupersession } from '../src/memory/core/ports/documents.ts'
import { memoryFileDetail, memoryFileIdentity, memoryFileListRequest, memoryFileListResult } from '../src/memory/contracts/file-management.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const allow = () => true
function fixture() {
  const workspace = 'opaque:workspace/value', refs = [{ id: 'source', token: 'private-source-token' }]
  const doc: DocumentSnapshot = { id: 'opaque:digest/value', workspace, path: 'digest/wiki/original.md', revision: 'r1', usageVersion: 1,
    markdown: '---\nname: Original\n---\nAccepted private body.', sources: refs, enabled: true, corrections: [] }
  const note = { key: 'internal-session-key', workspace, path: 'daily/2026-11-17/card.md', day: '2026-11-17', revision: 1,
    file_revision: 'daily-r1', fileRevision: 'daily-r1', updatedAt: 1, processed: 0, title: 'Daily',
    markdown: 'Daily body.', document: '---\nname: Daily\n---\nDaily body.' }
  const docs = [doc], supersessions: DocumentSupersession[] = [], unavailable = new Set<string>(), forgotten = new Set<string>()
  let sourceAllowed = true, candidate: DocumentUndoCandidate | null = { changeId: 'original-change', revision: doc.revision, usageVersion: doc.usageVersion }
  const policy = createMemoryDocumentReadPolicy({ hash,
    notes: { registered: () => [{ ...note, state: 'active', sources: refs }],
      registeredAt: (scope, path) => scope === workspace && path === note.path ? note : undefined,
      read: () => note, references: () => refs,
      snapshot: () => refs, sources: () => refs.map(ref => ref.id) },
    documents: {
      registered: () => docs.map(item => ({ ...item, state: forgotten.has(item.id) ? 'forgotten' : item.enabled ? 'active' : 'disabled' })),
      read: (_workspace, path, options) => docs.find(item => item.path === path && !forgotten.has(item.id)
        && !unavailable.has(item.id) && (item.enabled || options?.includeDisabled)) ?? null,
      sourceRestrictions: () => [], supersessions: (_workspace, path) => supersessions.filter(item => item.path === path),
    }, refsCurrent: () => sourceAllowed, materialAllowed: () => sourceAllowed,
    reference: id => ({ namespace: 'canonical', sourceId: id, revision: 1 }),
  })
  const service = createMemoryFileManagement({ policy, documents: { registered: () => [], undoCandidate: () => candidate,
    fileRegistry: () => docs.map(({ id, workspace, path, revision, usageVersion, enabled }) =>
      ({ id, workspace, path, revision, usageVersion, state: forgotten.has(id) ? 'forgotten' : enabled ? 'active' : 'disabled' })),
  }, workspaces: () => [workspace], hash })
  const identity = { kind: 'digest' as const, workspace, id: doc.id }
  return { service, policy, doc, docs, refs, note, identity, unavailable, forgotten, supersessions,
    denySource() { sourceAllowed = false }, setUndo(value: DocumentUndoCandidate | null) { candidate = value } }
}

test('disabled management details retain authorized accepted content without enabling model reads', () => {
  const f = fixture(); f.doc.enabled = false
  assert.equal(f.policy.read(f.identity.workspace, f.doc.path), null)
  assert.equal(f.policy.list(f.identity.workspace, 'digest').length, 0)
  const detail = f.service.detail(f.identity, allow)!
  assert.equal(detail.markdown, f.doc.markdown)
  assert.equal(detail.enabled, false)
  assert.equal(f.service.resolve(f.identity, allow)?.currentMarkdown, null)
  assert.deepEqual(detail.actions, { setEnabled: true, edit: false, forget: true, undo: { changeId: 'original-change' } })
  memoryFileDetail.parse(detail)
})

test('management never bypasses caller authorization, source withdrawal, forgotten state or unverified external content', () => {
  const f = fixture()
  assert.equal(f.service.detail(f.identity, () => false), null)
  assert.equal(f.service.list({}, () => false).items.length, 0)
  assert.equal(f.service.detail({ ...f.identity, workspace: 'other-scope' }, allow), null)
  f.unavailable.add(f.doc.id); assert.equal(f.service.detail(f.identity, allow), null)
  f.unavailable.clear(); f.forgotten.add(f.doc.id); assert.equal(f.service.detail(f.identity, allow), null)
  f.forgotten.clear(); f.denySource(); assert.equal(f.service.detail(f.identity, allow), null)
})

test('opaque file identity survives rename but never resolves another identity reusing its old path', () => {
  const f = fixture(), oldPath = f.doc.path
  f.doc.path = 'digest/wiki/renamed.md'
  assert.equal(f.service.detail(f.identity, allow)?.path, f.doc.path)
  f.docs.splice(0, 1, { ...f.doc, id: 'another-id', path: oldPath })
  assert.equal(f.service.detail(f.identity, allow), null)
  assert.equal(f.service.detail({ ...f.identity, id: 'another-id' }, allow)?.path, oldPath)
  assert.deepEqual(memoryFileIdentity.parse(f.identity), f.identity)
})

test('write validation binds policy-only changes as well as content, usage and exact undo action', () => {
  const f = fixture(), detail = f.service.detail(f.identity, allow)!
  const command = { action: 'setEnabled' as const, operationId: randomUUID(), identity: f.identity, version: detail.version, enabled: false }
  assert.equal(f.service.validate(command, allow).view.id, f.doc.id)
  f.refs[0]!.token = 'new-source-policy-token'
  assert.equal(f.service.detail(f.identity, allow)!.version.contentRevision, detail.version.contentRevision)
  assert.throws(() => f.service.validate(command, allow), { code: 'revision.conflict' })
  const latest = f.service.detail(f.identity, allow)!
  assert.throws(() => f.service.validate({ action: 'undo', operationId: randomUUID(), identity: f.identity,
    version: latest.version, changeId: 'wrong-change' }, allow), { code: 'revision.conflict' })
  assert.equal(f.service.validate({ action: 'undo', operationId: randomUUID(), identity: f.identity,
    version: latest.version, changeId: 'original-change' }, allow).undo?.changeId, 'original-change')
  f.setUndo(null)
  assert.equal(f.service.detail(f.identity, allow)?.actions.undo, null)
})

test('daily management advertises no unsupported writes or undo', () => {
  const f = fixture(), item = f.service.list({ kind: 'daily' }, allow).items[0]!
  assert.deepEqual(item.actions, { setEnabled: false, edit: false, forget: false, undo: null })
  assert.throws(() => f.service.validate({ action: 'setEnabled', operationId: randomUUID(), identity: item.identity,
    version: item.version, enabled: false }, allow), { code: 'invalid.text' })
})

test('replacement applicability invalidates management CAS without exposing unavailable replacement identities', () => {
  const f = fixture(), original = f.service.detail(f.identity, allow)!
  f.supersessions.push({ sourceDocumentId: f.doc.id, documentId: 'private-replacement', operationId: 'private-correction',
    replacementRevision: 'replacement-r1', path: f.doc.path, revision: f.doc.revision, startLine: 4, endLine: 4,
    text: 'Accepted private body.', condition: 'after the move', time: 'from tomorrow' })
  const changed = f.service.detail(f.identity, allow)!
  assert.equal(changed.applicability, 'unavailable')
  assert.equal(changed.version.contentRevision, original.version.contentRevision)
  assert.notEqual(changed.version.policyToken, original.version.policyToken)
  assert.ok(!JSON.stringify(changed).includes('private-replacement'))
  assert.ok(!JSON.stringify(changed).includes('private-correction'))
  assert.throws(() => f.service.validate({ action: 'setEnabled', operationId: randomUUID(), identity: f.identity,
    version: original.version, enabled: false }, allow), { code: 'revision.conflict' })
})

test('list pages are deterministic, redact bodies and tokens, and reject a changed snapshot or filter', () => {
  const f = fixture(), first = f.service.list({ limit: 1 }, allow)
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor)
  const second = f.service.list({ limit: 1, cursor: first.nextCursor }, allow)
  assert.equal(second.status, 'ok'); assert.equal(second.items.length, 1)
  assert.notEqual(second.items[0]!.identity.id, first.items[0]!.identity.id)
  assert.equal(second.nextCursor, null)
  assert.ok(!JSON.stringify(first).includes('private-source-token'))
  assert.ok(!JSON.stringify(first).includes('Accepted private body'))
  assert.ok(!JSON.stringify(first).includes('sourceTokens'))
  memoryFileListResult.parse(first)
  assert.equal(f.service.list({ limit: 1, kind: 'digest', cursor: first.nextCursor }, allow).status, 'stale')
  f.doc.usageVersion++
  assert.deepEqual(f.service.list({ cursor: first.nextCursor }, allow).items, [])
  assert.equal(f.service.list({ cursor: first.nextCursor }, allow).status, 'stale')
})

test('paged title and path filters continue after bounded empty pages without exposing quarantined documents', async () => {
  const f = fixture()
  f.docs.splice(0, 1, ...Array.from({ length: 109 }, (_, index) => ({
    ...f.doc, id: `item-${String(index).padStart(3, '0')}`, path: `digest/wiki/file-${index}.md`,
    markdown: `---\nname: ${[0, 3, 107].includes(index) ? 'Search Key' : 'Routine'}\n---\nPrivate body`,
    enabled: index !== 0,
  })))
  f.unavailable.add('item-003')
  const scanned = new Set<string>()
  const options = { revision: () => 1, async load(files: readonly { path: string }[]) {
    files.forEach(file => scanned.add(file.path)); return f.policy.managementRead
  } }
  const request = { kind: 'digest' as const, state: 'enabled' as const, query: 'SEARCH KEY', limit: 2 }
  const first = await f.service.listPage(request, allow, [], options)
  assert.deepEqual(first.items, [])
  assert.ok(first.nextCursor)
  assert.equal(scanned.size, 100)
  assert(!scanned.has('digest/wiki/file-0.md'), 'the disabled digest is filtered before physical verification')
  const result = await f.service.listPage({ ...request, cursor: first.nextCursor }, allow, [], options)
  assert.deepEqual(result.items.map(row => row.identity.id), ['item-107'])
  assert.equal(result.nextCursor, null)
  assert.doesNotMatch(JSON.stringify(result), /Private body|private-source-token/u)
  const byPath = await f.service.listPage({ ...request, query: 'file-7.md' }, allow, [], options)
  assert.deepEqual(byPath.items.map(row => row.identity.id), ['item-007'])
})

test('a later page retries an unobserved file without dropping or duplicating its healthy siblings', async () => {
  const f = fixture()
  f.docs.splice(0, 1, ...['a', 'b', 'c'].map(id => ({ ...f.doc, id, path: `digest/wiki/${id}.md` })))
  let blocked = true
  const options = { revision: () => 1, async load() {
    return (workspace: string, path: string) => blocked && path.endsWith('/a.md') ? undefined : f.policy.managementRead(workspace, path)
  } }
  const first = await f.service.listPage({ limit: 2 }, allow, [], options)
  assert.deepEqual(first.items.map(item => item.identity.id), ['b', 'c'])
  assert.ok(first.partial && first.nextCursor)
  memoryFileListResult.parse(first)
  blocked = false
  const rest = await f.service.listPage({ limit: 2, cursor: first.nextCursor }, allow, [], options)
  assert.deepEqual(rest.items.map(item => item.identity.id), ['a'])
  assert.equal(rest.nextCursor, null)
})

test('management filters apply before paging and input rejects asserted authorization or internal paths', () => {
  const f = fixture(); f.doc.enabled = false
  assert.equal(f.service.list({ state: 'disabled', query: 'original' }, allow).items.length, 1)
  assert.equal(f.service.list({ state: 'enabled', kind: 'digest' }, allow).items.length, 0)
  assert.throws(() => memoryFileListRequest.parse({ authorized: true }))
  assert.throws(() => memoryFileIdentity.parse({ ...f.identity, path: '/private/file' }))
  assert.throws(() => memoryFileListRequest.parse({ limit: 0 }))
})


test('deletion relies on the accepted file identity and version, independently of source ranges', () => {
  const f = fixture()
  assert.equal(f.service.detail(f.identity, allow)?.actions.forget, true)
  assert.equal(f.service.list({ kind: 'digest' }, allow).items[0]?.actions.forget, true)
  f.doc.enabled = false
  assert.equal(f.service.detail(f.identity, allow)?.actions.forget, true)
  f.doc.sources = []
  assert.equal(f.service.detail(f.identity, allow)?.actions.forget, true)
  const detail = f.service.detail(f.identity, allow)!
  assert.equal(f.service.deletionTarget({ operationId: randomUUID(), identity: f.identity, version: detail.version }, allow).id, f.identity.id)
  assert.throws(() => f.service.forgetEvidence({ operationId: randomUUID(), identity: f.identity, version: detail.version }, allow),
    { code: 'revision.conflict' })
})
