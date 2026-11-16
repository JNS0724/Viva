import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryFileEmbeddingPassages, splitMemoryFileEmbeddingPassage } from '../src/memory/core/memory-file-passages.ts'
import { parseMemoryMarkdown } from '../src/memory/core/memory-markdown.ts'
import { formatMemoryDocument } from '../src/memory/core/memory-document.ts'
import { memoryFileLexicalQuery } from '../src/memory/core/search-tokens.ts'
import { rankDailyMemory } from '../src/memory/core/memory-daily-search.ts'

test('the old JUNIPER development example retains its frontmatter subject and heading at every passage boundary', () => {
  const markdown = formatMemoryDocument({ metadata: { name: 'Project JUNIPER-42' },
    body: '# Release controls\n\n' + 'Background recording. '.repeat(150) + '\n\nReleases require sign-off from the infrastructure lead, Maya Chen.' })
  const parsed = parseMemoryMarkdown(markdown)
  const inputs = parsed.chunks.flatMap(chunk => memoryFileEmbeddingPassages(chunk, 'Project JUNIPER-42')!)
  assert.ok(inputs.length > 1)
  assert.ok(inputs.every(input => input.text.startsWith('Project JUNIPER-42\nRelease controls\n\n')))
  assert.ok(inputs.every(input => input.text.length <= 1200))
  assert.ok(inputs.at(-1)!.text.includes('Maya Chen'))
  assert.equal(inputs.map(input => input.body).join(''), parsed.chunks.map(chunk => chunk.text).join(''))
})

test('tokenizer retries split only the body and preserve nested conditional headings and Unicode scalars', () => {
  const original = memoryFileEmbeddingPassages({ text: '甲😀乙😀丙😀丁', headingPath: ['Only in staging', 'Before approval'] }, 'Deployments')![0]!
  const parts = splitMemoryFileEmbeddingPassage(original)!
  assert.equal(parts.map(part => part.body).join(''), original.body)
  for (const part of parts) {
    assert.equal(part.context, original.context)
    assert.ok(part.text.startsWith('Deployments\nOnly in staging\nBefore approval\n\n'))
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(part.body))
    assert.ok(!/[\uD800-\uDBFF]$/u.test(part.body))
  }
  const scalar = memoryFileEmbeddingPassages({ text: '😀', headingPath: [] }, '')![0]!
  assert.equal(splitMemoryFileEmbeddingPassage(scalar), null)
  const short = memoryFileEmbeddingPassages({ text: '😀x', headingPath: [] }, '')![0]!
  assert.deepEqual(splitMemoryFileEmbeddingPassage(short)!.map(part => part.body), ['😀', 'x'])
})

test('unrepresentable full context is explicit rather than silently truncated or indexed without its qualification', () => {
  assert.equal(memoryFileEmbeddingPassages({ text: 'value', headingPath: ['x'.repeat(1200)] }, 'title'), null)
  const chunk = { text: 'body', headingPath: ['Same', 'Child'] }
  assert.equal(memoryFileEmbeddingPassages(chunk, 'Same')![0]!.context, 'Same\nChild\n\n')
})

test('pure lexical normalization is shared by mixed daily ranking without modifying identifiers', () => {
  assert.deepEqual(memoryFileLexicalQuery('the report in the folder').trim().split(/\s+/u), ['report', 'folder'])
  assert.equal(memoryFileLexicalQuery('A-42 plug-in a.b user@a 中文and词 IT'), 'A-42 plug-in a.b user@a 中文and词 IT')
  const documents = [{ key: 'right', text: '每周的工作汇报材料须发送给财务小组。' },
    ...Array.from({length: 6}, (_, i) => ({ key: `weak-${i}`, text: 'the' }))]
  const vector = new Map([['right', 0.99], ...documents.slice(1).map((doc, i): [string, number] => [doc.key, 0.8-i*0.01])])
  const query = 'Who should receive the recurring work summary?'
  const ranked = rankDailyMemory(documents, query, 5, 0, vector)
  assert.equal(ranked.hits[0]!.document.key, 'right')
  assert.equal(ranked.hits[0]!.score, 0.99, 'function-word-only lexical evidence leaves the vector lane unmodified')
})
