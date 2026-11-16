import assert from 'node:assert/strict'
import { test } from 'node:test'
import { availableDocumentSourceSpans, documentSourceRestricted, projectDocumentSource } from '../src/memory/core/memory-document-restrictions.ts'
import type { DocumentSourceRef } from '../src/memory/core/ports/documents.ts'

const source = { id: 'canonical-input', token: 'original-version' }
const restricted: DocumentSourceRef[] = [{ ...source, spans: [{ start: 2, end: 5 }] }]

test('document restrictions bind original identity/version and intersect exact evidence spans', () => {
  assert.equal(documentSourceRestricted(source, restricted), true)
  assert.equal(documentSourceRestricted({ ...source, spans: [{ start: 0, end: 2 }] }, restricted), false)
  assert.equal(documentSourceRestricted({ ...source, spans: [{ start: 5, end: 7 }] }, restricted), false)
  assert.equal(documentSourceRestricted({ ...source, spans: [{ start: 1, end: 3 }] }, restricted), true)
  assert.equal(documentSourceRestricted({ ...source, spans: [{ start: 4, end: 6 }] }, restricted), true)
  assert.equal(documentSourceRestricted({ ...source, spans: [{ start: 0, end: 2 }, { start: 5, end: 7 }] }, restricted), false)
  assert.equal(documentSourceRestricted({ ...source, id: 'new-independent-input' }, restricted), false)
  assert.equal(documentSourceRestricted({ ...source, token: 'new-version' }, restricted), false)
  assert.equal(documentSourceRestricted({ ...source, spans: [{ start: 7, end: 9 }] }, [source]), true)
})

test('model projection masks disabled text while keeping Unicode UTF-16 offsets and line breaks', () => {
  const text = '好🙂\r\n秘密abc\nother'
  const blocked = [{ ...source, spans: [{ start: 1, end: 7 }] }]
  const projected = projectDocumentSource(text, source, blocked)
  assert.equal(projected, '好  \r\n  abc\nother')
  assert.equal(projected.length, text.length)
  assert.equal(projected.indexOf('abc'), text.indexOf('abc'))
  assert.equal(projected.indexOf('other'), text.indexOf('other'))
  assert.equal(projectDocumentSource(text, { ...source, id: 'new-independent-input' }, blocked), text)
  assert.equal(projectDocumentSource(text, { ...source, token: 'new-version' }, blocked), text)
  assert.equal(projectDocumentSource(text, source, [source]), '   \r\n     \n     ')
})

test('multiple restrictions merge without mutating stored spans; disjoint context remains usable', () => {
  const text = '0123456789'
  const restrictions = [{ ...source, spans: [{ start: 6, end: 8 }, { start: 2, end: 4 }] },
    { ...source, spans: [{ start: 3, end: 5 }] }]
  const before = structuredClone(restrictions)
  assert.equal(projectDocumentSource(text, source, restrictions), '01   5  89')
  assert.deepEqual(restrictions, before)
  const adjacent = { ...source, spans: [{ start: 8, end: 10 }] }
  assert.equal(documentSourceRestricted(adjacent, restrictions), false)
  // A source ref selecting an allowed claim does not expose disabled neighboring context.
  assert.equal(projectDocumentSource(text, adjacent, restrictions), '01   5  89')
})

test('invalid restriction ranges fail closed instead of clipping potentially stale provenance', () => {
  for (const spans of [[], [{ start: -1, end: 2 }], [{ start: 2, end: 2 }], [{ start: 1.5, end: 3 }]]) {
    assert.throws(() => documentSourceRestricted(source, [{ ...source, spans }]), /invalid-document-restriction/)
    assert.throws(() => projectDocumentSource('test', source, [{ ...source, spans }]), /invalid-document-restriction/)
  }
  assert.throws(() => projectDocumentSource('test', source, [{ ...source, spans: [{ start: 1, end: 5 }] }]), /invalid-document-restriction/)
  assert.throws(() => documentSourceRestricted({ ...source, spans: [] }, restricted), /invalid-document-source/)
})

test('daily rebuilding subtracts restricted ranges from the original authorized evidence without widening it', () => {
  const text = '0123456789abcdefghij'
  const ref = { ...source, spans: [{ start: 0, end: 8 }, { start: 10, end: 18 }] }
  const restrictions = [{ ...source, spans: [{ start: 2, end: 5 }, { start: 7, end: 12 }] },
    { ...source, spans: [{ start: 15, end: 17 }] }]
  const frozen = structuredClone({ ref, restrictions })
  assert.deepEqual(availableDocumentSourceSpans(text, ref, restrictions), [
    { start: 0, end: 2 }, { start: 5, end: 7 }, { start: 12, end: 15 }, { start: 17, end: 18 },
  ])
  assert.deepEqual({ ref, restrictions }, frozen)
  assert.deepEqual(availableDocumentSourceSpans(text, ref, [{ ...source, token: 'old-version' }]), ref.spans)
  assert.deepEqual(availableDocumentSourceSpans(text, ref, [source]), [])
  assert.deepEqual(availableDocumentSourceSpans(text, source, []), [{ start: 0, end: text.length }])
  assert.deepEqual(availableDocumentSourceSpans('', source, []), [])
})

test('available evidence coalesces overlaps, preserves UTF-16 boundaries, and rejects stale oversized ranges', () => {
  const text = 'a🙂bc'
  const ref = { ...source, spans: [{ start: 3, end: 5 }, { start: 0, end: 4 }] }
  assert.deepEqual(availableDocumentSourceSpans(text, ref, [{ ...source, spans: [{ start: 1, end: 3 }] }]), [{ start: 0, end: 1 }, { start: 3, end: 5 }])
  assert.throws(() => availableDocumentSourceSpans(text, { ...source, spans: [{ start: 0, end: 9 }] }, []), /invalid-document-source/)
  assert.throws(() => availableDocumentSourceSpans(text, source, [{ ...source, spans: [{ start: 0, end: 9 }] }]), /invalid-document-restriction/)
})
