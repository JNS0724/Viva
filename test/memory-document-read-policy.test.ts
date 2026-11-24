import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createMemoryDocumentReadPolicy } from '../src/memory/core/memory-document-read-policy.ts'
import type { DocumentSnapshot } from '../src/memory/core/ports/documents.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const workspace = hash('workspace')

function fixture() {
  const text = '# Profile\nLocation note.\nUnrelated preference.'
  const source = { id: 'old', token: 'v1', spans: [{ start: 0, end: 10 }] }
  const note = { enabled: true,
    key: 'note', workspace, path: 'daily/2026-11-16/note.md', day: '2026-11-16',
    revision: 1, file_revision: hash(text), fileRevision: hash(text), updatedAt: 1,
    processed: 0, title: 'Profile', markdown: text, document: text,
  }
  const digest: DocumentSnapshot = {
    id: 'digest-1', workspace, path: 'digest/personal/location.md', revision: hash('Current location.'),
    usageVersion: 1, markdown: 'Current location.', sources: [source], enabled: true,
  }
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
    },
    refsCurrent: refs => refs.every(ref => allowed.has(ref.id)),
    materialAllowed: () => true,
    reference: id => ({ namespace: 'canonical', sourceId: id, revision: 1 }),
  })
  return {
    policy, note, digest, allowed,
  }
}

test('a disabled daily file stays readable in management and leaves sibling evidence alone', () => {
  const { policy, note, digest, allowed } = fixture()
  assert(policy.read(workspace, note.path))
  note.enabled = false
  note.revision++
  assert.equal(policy.read(workspace, note.path), null)
  assert.equal(policy.managementRead(workspace, note.path)?.enabled, false)
  assert(policy.read(workspace, digest.path))
  allowed.clear()
  assert.equal(policy.managementRead(workspace, note.path), null)
})

test('disabled digests are excluded from ordinary reads and marked disabled in managementRead', () => {
  const f = fixture()
  f.digest.enabled = false
  assert.equal(f.policy.read(workspace, f.digest.path), null)
  const managed = f.policy.managementRead(workspace, f.digest.path)!
  assert.equal(managed.enabled, false)
  assert.equal(managed.markdown, f.digest.markdown)
})
