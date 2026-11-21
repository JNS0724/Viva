import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createMemoryDocumentReadPolicy } from '../src/memory/core/memory-document-read-policy.ts'
import type { DocumentSnapshot, DocumentSourceRef } from '../src/memory/core/ports/documents.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const workspace = hash('workspace')

function fixture() {
  const text = '# Profile\nLocation note.\nUnrelated preference.'
  const source = { id: 'old', token: 'v1', spans: [{ start: 0, end: 10 }] }
  const note = {
    key: 'note', workspace, path: 'daily/2026-11-16/note.md', day: '2026-11-16',
    revision: 1, file_revision: hash(text), fileRevision: hash(text), updatedAt: 1,
    processed: 0, title: 'Profile', markdown: text, document: text,
  }
  const digest: DocumentSnapshot = {
    id: 'digest-1', workspace, path: 'digest/personal/location.md', revision: hash('Current location.'),
    usageVersion: 1, markdown: 'Current location.', sources: [source], enabled: true,
  }
  let restrictions: DocumentSourceRef[] = []
  const allowed = new Set(['old'])
  const policy = createMemoryDocumentReadPolicy({
    hash,
    notes: {
      read: () => note,
      registeredAt: (scope, path) => scope === note.workspace && path === note.path ? note : undefined,
      registered: () => [{ ...note, sources: [source], state: 'active' as const }],
      references: () => [source],
      snapshot: () => [source],
      sources: () => ['old'],
    },
    documents: {
      read: (_workspace, path, options) => (digest.enabled || options?.includeDisabled) && digest.path === path ? digest : null,
      registered: () => [{ ...digest, state: digest.enabled ? 'active' as const : 'disabled' as const }],
      sourceRestrictions: () => restrictions,
    },
    refsCurrent: refs => refs.every(ref => allowed.has(ref.id)),
    materialAllowed: () => true,
    reference: id => ({ namespace: 'canonical', sourceId: id, revision: 1 }),
  })
  return {
    policy, note, digest, allowed,
    restrict(refs: DocumentSourceRef[]) { restrictions = refs },
  }
}

test('source restrictions use exact identity/version/spans and invalidate model views while retaining management views', () => {
  const f = fixture()
  f.restrict([{ id: 'old', token: 'v1', spans: [{ start: 10, end: 20 }] }])
  assert.equal(f.policy.read(workspace, f.note.path)?.markdown, f.note.document)

  f.restrict([{ id: 'old', token: 'v1', spans: [{ start: 9, end: 20 }] }])
  assert.equal(f.policy.read(workspace, f.note.path), null)
  assert(!f.policy.list(workspace).some(view => view.path === f.note.path))
  const managed = f.policy.managementRead(workspace, f.note.path)!
  assert.equal(managed.enabled, false)
  assert.equal(managed.markdown, f.note.document)

  f.restrict([])
  f.allowed.delete('old')
  assert.equal(f.policy.read(workspace, f.note.path), null)
  assert.equal(f.policy.managementRead(workspace, f.note.path), null)
})

test('disabled digests are excluded from ordinary reads and marked disabled in managementRead', () => {
  const f = fixture()
  f.digest.enabled = false
  assert.equal(f.policy.read(workspace, f.digest.path), null)
  const managed = f.policy.managementRead(workspace, f.digest.path)!
  assert.equal(managed.enabled, false)
  assert.equal(managed.markdown, f.digest.markdown)
})
