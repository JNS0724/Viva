import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createMemoryDocumentReadPolicy } from '../src/memory/core/memory-document-read-policy.ts'
import type { DocumentSnapshot, DocumentSourceRef, DocumentSupersession } from '../src/memory/core/ports/documents.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const workspace = hash('workspace')
function fixture() {
  const text = '# Profile\nOld location.\nUnrelated preference.'
  const source = { id: 'old', token: 'v1', spans: [{ start: 0, end: 10 }] }
  const note = { key: 'note', workspace, path: 'daily/2026-11-16/note.md', day: '2026-11-16',
    revision: 1, file_revision: hash(text), fileRevision: hash(text), updatedAt: 1, processed: 0, title: 'Profile', markdown: text, document: text }
  const replacement: DocumentSnapshot = { id: 'replacement', workspace, path: 'digest/personal/location.md', revision: hash('New location.'),
    usageVersion: 2, markdown: 'New location.', sources: [{ id: 'new', token: 'v2' }], enabled: true, corrections: [] }
  const correction: DocumentSupersession = { sourceDocumentId: 'original', documentId: replacement.id, operationId: 'correct',
    replacementRevision: replacement.revision, path: note.path, revision: note.fileRevision,
    startLine: 2, endLine: 2, text: 'Old location.', condition: 'primary home', time: 'from now' }
  replacement.corrections.push(correction)
  const extra: DocumentSnapshot[] = [], corrections = [correction]
  let restrictions: DocumentSourceRef[] = [], replacementVisible = true
  const allowed = new Set(['old', 'new'])
  const policy = createMemoryDocumentReadPolicy({ hash,
    notes: { read: () => note, registeredAt: (scope, path) => scope === note.workspace && path === note.path ? note : undefined, registered: () => [{ ...note, sources: [source], state: 'active' as const }], references: () => [source], snapshot: () => [source], sources: () => ['old'] },
    documents: {
      read: (_workspace, path) => [...replacementVisible ? [replacement] : [], ...extra].find(doc => doc.enabled && doc.path === path) ?? null,
      registered: () => [...replacementVisible ? [replacement] : [], ...extra].map(doc => ({ ...doc, state: doc.enabled ? 'active' as const : 'disabled' as const })), sourceRestrictions: () => restrictions,
      supersessions: (_workspace, path) => corrections.filter(item => item.path === path),
    },
    refsCurrent: refs => refs.every(ref => allowed.has(ref.id)), materialAllowed: () => true,
    reference: id => ({ namespace: 'canonical', sourceId: id, revision: 1 }),
  })
  return { policy, note, replacement, correction, allowed, extra, corrections,
    restrict(refs: DocumentSourceRef[]) { restrictions = refs },
    hideReplacement() { replacementVisible = false },
  }
}

test('current file projection masks only exact superseded lines and keeps original offsets for unaffected evidence', () => {
  const f = fixture(), view = f.policy.read(workspace, f.note.path)!
  assert.equal(view.applicability.state, 'superseded')
  assert.equal(view.markdown, f.note.document)
  assert.equal(view.currentMarkdown?.length, f.note.document.length)
  assert(!view.currentMarkdown?.includes('Old location.'))
  assert(view.currentMarkdown?.includes('Unrelated preference.'))
  assert.equal(view.currentMarkdown?.indexOf('Unrelated'), f.note.document.indexOf('Unrelated'))
  assert.deepEqual(view.sourceTokens.map(ref => ref.id), ['old', 'new'])
})

test('an unavailable or unauthorized correction cannot restore old content or carry its private source identifiers', () => {
  const f = fixture(), initial = f.policy.read(workspace, f.note.path)!
  f.allowed.delete('new')
  const inaccessible = f.policy.read(workspace, f.note.path)!
  assert.equal(inaccessible.applicability.state, 'unavailable')
  assert.notEqual(inaccessible.policyToken, initial.policyToken)
  assert.deepEqual(inaccessible.sourceTokens.map(ref => ref.id), ['old'])
  assert(!inaccessible.currentMarkdown?.includes('Old location.'))
  assert(inaccessible.currentMarkdown?.includes('Unrelated preference.'))
  f.hideReplacement()
  assert(!f.policy.read(workspace, f.note.path)?.currentMarkdown?.includes('Old location.'))
})

test('changed fragment anchors quarantine current text rather than silently dropping supersession', () => {
  const f = fixture()
  f.note.document = '# Inserted\n' + f.note.document
  f.note.fileRevision = hash(f.note.document)
  f.note.file_revision = f.note.fileRevision // Simulate an accepted edit; anchor validation is still independent.
  const view = f.policy.read(workspace, f.note.path)!
  assert.equal(view.applicability.state, 'unavailable')
  assert.equal(view.currentMarkdown, null)
})

test('source restrictions use exact identity/version/spans and invalidate every file view consistently', () => {
  const f = fixture()
  f.restrict([{ id: 'old', token: 'v1', spans: [{ start: 10, end: 20 }] }])
  assert(f.policy.read(workspace, f.note.path))
  f.restrict([{ id: 'old', token: 'v1', spans: [{ start: 9, end: 20 }] }])
  assert.equal(f.policy.read(workspace, f.note.path), null)
  assert(!f.policy.list(workspace).some(view => view.path === f.note.path))
  f.restrict([]); f.allowed.delete('old')
  assert.equal(f.policy.read(workspace, f.note.path), null)
})


test('transitive replacements bind the terminal correction and never present an intermediate old body as current', () => {
  const f = fixture()
  const terminal: DocumentSnapshot = { ...f.replacement, id: 'terminal', path: 'digest/personal/latest.md',
    markdown: 'Latest location.', revision: hash('Latest location.'), sources: [{ id: 'latest', token: 'v3' }], corrections: [] }
  const correction: DocumentSupersession = { ...f.correction, operationId: 'correct-again', sourceDocumentId: f.replacement.id,
    documentId: terminal.id, replacementRevision: terminal.revision, path: f.replacement.path, revision: f.replacement.revision,
    startLine: 1, endLine: 1, text: f.replacement.markdown }
  terminal.corrections.push(correction); f.corrections.push(correction); f.extra.push(terminal); f.allowed.add('latest')
  const view = f.policy.read(workspace, f.note.path)!
  assert.equal(view.applicability.state, 'superseded')
  assert.deepEqual(new Set(view.sourceTokens.map(ref => ref.id)), new Set(['old', 'new', 'latest']))
  assert(!view.supporting.some(doc => doc.markdown.includes('New location.')))
  assert(view.supporting.some(doc => doc.markdown === 'Latest location.'))
  terminal.enabled = false
  const disabled = f.policy.read(workspace, f.note.path)!
  assert.equal(disabled.applicability.state, 'unavailable')
  assert.notEqual(disabled.policyToken, view.policyToken)
  assert(!disabled.supporting.some(doc => doc.markdown.includes('New location.')))
  assert(!disabled.currentMarkdown?.includes('Old location.'))
  terminal.enabled = true; f.allowed.delete('latest')
  assert.equal(f.policy.read(workspace, f.note.path)?.applicability.state, 'unavailable')
  f.allowed.add('latest')
  const cycle = { ...correction, operationId: 'cycle', sourceDocumentId: terminal.id, documentId: f.replacement.id,
    path: terminal.path, revision: terminal.revision, text: terminal.markdown }
  f.replacement.corrections.push(cycle); f.corrections.push(cycle)
  assert.equal(f.policy.read(workspace, f.note.path)?.applicability.state, 'unavailable')
})
