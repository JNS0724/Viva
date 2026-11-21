import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemoryFileStore, MemoryFileError } from '../src/memory/node/memory-file-store.ts'
import { formatMemoryDocument, memoryDocumentLines, parseMemoryDocument, readMemoryLines, updateMemoryFrontmatter } from '../src/memory/core/memory-document.ts'
import { parseDreamOperations, validMemoryPath } from '../src/memory/contracts/memory-file-contract.ts'

const a = 'daily/2026-11-15/project.md'
const b = 'daily/2026-11-15/decision.md'
const target = 'digest/procedure/rebuild.md'
const errorCode = (code: MemoryFileError['code']) => (error: unknown) => error instanceof MemoryFileError && error.code === code

test('file memory roundtrips Markdown and survives reopening without database copies', t => {
  const root = mkdtempSync(join(tmpdir(), 'viva-memory-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = openMemoryFileStore(root)
  const markdown = formatMemoryDocument({ metadata: { name: '重建索引', description: '安全重建', memory_tags: ['Viva'] },
    body: '# 重建索引\n\n先检查模型版本。\n\n## Sources\n依据来自 [[daily/2026-11-15/project.md]]。\n' })
  const saved = store.write(target, markdown, null)
  assert.equal(readFileSync(join(root, target), 'utf8'), markdown)
  assert.deepEqual(openMemoryFileStore(root).read(target), saved)
  assert.deepEqual(readdirSync(join(root, 'digest/procedure')), ['rebuild.md'])
  assert.deepEqual(store.write(target, markdown, saved.revision), saved)
})

test('a stale compute result cannot overwrite an updated memory or claim a missing target', t => {
  const root = mkdtempSync(join(tmpdir(), 'viva-memory-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = openMemoryFileStore(root)
  const original = store.write(a, 'old', null)
  const updated = store.write(a, 'new', original.revision)
  assert.throws(() => store.write(a, 'stale result', original.revision), errorCode('version'))
  assert.throws(() => store.write(a, 'duplicate create', null), errorCode('version'))
  assert.throws(() => store.write(b, 'missing update', original.revision), errorCode('version'))
  assert.deepEqual(store.read(a), updated)
  assert.equal(store.read(b), null)
})

test('a direct file edit changes its version and invalidates an older snapshot', t => {
  const root = mkdtempSync(join(tmpdir(), 'viva-memory-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = openMemoryFileStore(root)
  const old = store.write(a, 'before edit', null)
  writeFileSync(join(root, a), 'manual edit')
  assert.throws(() => store.write(a, 'computed from old', old.revision), errorCode('version'))
  assert.equal(store.read(a)?.markdown, 'manual edit')
})

test('paths cannot escape the workspace or access unrelated application files', t => {
  const root = mkdtempSync(join(tmpdir(), 'viva-memory-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = openMemoryFileStore(root)
  for (const path of ['/etc/passwd', '../outside.md', 'daily/../outside.md', 'daily//a.md', 'daily\\x.md',
    'C:/x.md', 'daily/2026-11-15/a.md\u0000', 'digest/wiki/CON.md', 'digest/wiki/name. /a.md',
    'metadata/private.md', 'session/dialog/private.jsonl']) {
    assert.throws(() => store.write(path, 'invalid', null), errorCode('path'), path)
    assert.throws(() => store.read(path), errorCode('path'), path)
  }
  assert.deepEqual(readdirSync(root), [])
  assert(validMemoryPath('digest/wiki/中文主题.md'))
})

test('existing and dangling symlinks cannot redirect reads or writes', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'viva-memory-files-'))
  const outside = mkdtempSync(join(tmpdir(), 'viva-memory-outside-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  const store = openMemoryFileStore(root)
  mkdirSync(join(root, 'digest'))
  symlinkSync(outside, join(root, 'digest/wiki'))
  assert.throws(() => store.write('digest/wiki/escape.md', 'bad', null), errorCode('path'))
  assert.throws(() => store.read('digest/wiki/escape.md'), errorCode('path'))
  mkdirSync(join(root, 'digest/personal'))
  symlinkSync(join(outside, 'missing.md'), join(root, 'digest/personal/dangling.md'))
  assert.throws(() => store.write('digest/personal/dangling.md', 'bad', null), errorCode('path'))
  assert.deepEqual(readdirSync(outside), [])
})

test('invalid YAML is rejected without changing the stored file', t => {
  const root = mkdtempSync(join(tmpdir(), 'viva-memory-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = openMemoryFileStore(root)
  const saved = store.write(a, '# valid', null)
  for (const malformed of ['---\nname: [\n---\nbody', '---\nname: a\nname: b\n---\nbody', '---\nname: a']) {
    assert.throws(() => store.write(a, malformed, saved.revision))
  }
  assert.deepEqual(store.read(a), saved)
})

test('frontmatter edits preserve source fields, custom metadata and body', () => {
  const body = '# 内容\n\n```yaml\n---\n```\n来源 [[daily/2026-11-15/project.md|项目记录]]。\n'
  const original = formatMemoryDocument({ metadata: { name: '项目', source_conversation: '[[session/dialog/a.jsonl]]',
    custom: { flags: [true, false] }, memory_tags: ['旧标签'] }, body })
  const updated = parseMemoryDocument(updateMemoryFrontmatter(original, { memory_tags: ['新标签'] }))
  assert.equal(updated.body, body)
  assert.equal(updated.metadata.source_conversation, '[[session/dialog/a.jsonl]]')
  assert.deepEqual(updated.metadata.custom, { flags: [true, false] })
  assert.deepEqual(updated.metadata.memory_tags, ['新标签'])
})

test('line reads preserve original CRLF and frontmatter offsets', () => {
  const markdown = '---\r\nname: 测试\r\n---\r\n# 标题\r\n正文\r\n'
  const document = parseMemoryDocument(markdown)
  assert.equal(document.bodyStartLine, 4)
  assert.equal(readMemoryLines(markdown, 4, 5), '# 标题\r\n正文')
  assert.equal(readMemoryLines(markdown, 4), document.body)
  assert.equal(readMemoryLines(markdown, 99), '')
  for (const [start, end] of [[0, 2], [3, 2], [1.5, 3], [1, Infinity]]) {
    assert.throws(() => readMemoryLines(markdown, start, end), /invalid-memory-line-range/)
  }
})

test('dream consolidation validates paths, source membership, target uniqueness and budget', () => {
  const op = { action: 'CREATE' as const, path: target, name: 'Rebuild', description: 'Safe rebuild',
    body: 'Rebuild safely', dailyPaths: [a, a], sourceIds: ['s1', 's1'] }
  assert.deepEqual(parseDreamOperations({ operations: [op] }, new Set([a, b]), new Set(['s1']), 5), [{
    ...op, dailyPaths: [a], sourceIds: ['s1'],
  }])
  assert.throws(() => parseDreamOperations({ operations: [op, { ...op, action: 'REFINE' }] }, new Set([a]), new Set(['s1']), 5), /duplicate-dream-target/)
  assert.throws(() => parseDreamOperations({ operations: [op] }, new Set([b]), new Set(['s1']), 5), /unknown-dream-daily/)
  assert.throws(() => parseDreamOperations({ operations: [op] }, new Set([a]), new Set(['s2']), 5), /unknown-dream-source/)
  assert.throws(() => parseDreamOperations({ operations: [op] }, new Set([a]), new Set(['s1']), 0))
  assert.throws(() => parseDreamOperations({ operations: [{ ...op, dailyPaths: [] }] }, new Set([a]), new Set(['s1']), 5))
  assert.throws(() => parseDreamOperations({ operations: [{ ...op, sourceIds: [] }] }, new Set([a]), new Set(['s1']), 5))
  assert.throws(() => parseDreamOperations({ operations: [{ ...op, path: a }] }, new Set([a]), new Set(['s1']), 5))
  assert.throws(() => parseDreamOperations({ operations: [{ ...op, body: ' ' }] }, new Set([a]), new Set(['s1']), 5))
  const refineEdits = { action: 'REFINE' as const, path: target, name: 'Rebuild', description: 'Safe rebuild',
    edits: [{ oldText: 'old line', newText: 'new line' }], dailyPaths: [a], sourceIds: ['s1'] }
  assert.deepEqual(parseDreamOperations({ operations: [refineEdits] }, new Set([a]), new Set(['s1']), 5), [refineEdits])
  assert.throws(() => parseDreamOperations({ operations: [{ ...refineEdits, body: 'both' }] }, new Set([a]), new Set(['s1']), 5))
  assert.throws(() => parseDreamOperations({ operations: [{ action: 'REFINE', path: target, name: 'Rebuild', description: 'Safe rebuild', dailyPaths: [a], sourceIds: ['s1'] }] }, new Set([a]), new Set(['s1']), 5))
  assert.throws(() => parseDreamOperations({ operations: [] }, new Set(), new Set(), -1))
  assert.deepEqual(parseDreamOperations({ operations: [] }, new Set(), new Set(), 0), [])
})


test('shared line ranges preserve complete UTF16 content and each kind of newline', () => {
  const markdown = '😀first\r\nsecond\rthird\n'
  const positions = memoryDocumentLines(markdown)
  assert.deepEqual(positions, [
    { startOffset: 0, contentEndOffset: 7, endOffset: 9 },
    { startOffset: 9, contentEndOffset: 15, endOffset: 16 },
    { startOffset: 16, contentEndOffset: 21, endOffset: 22 },
    { startOffset: 22, contentEndOffset: 22, endOffset: 22 },
  ])
  assert.equal(positions.map(line => markdown.slice(line.startOffset, line.endOffset)).join(''), markdown)
  assert.equal(readMemoryLines(markdown, 1, 3), '😀first\r\nsecond\rthird')
  assert.equal(readMemoryLines(markdown), markdown)
  assert.equal(readMemoryLines(markdown, 2, 2), 'second')
})

test('frontmatter booleans and body separators agree for LF, CRLF and lone CR', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const body = ['first', 'needle'].join(newline)
    const markdown = ['---', 'name: title', 'enabled: true', '---', body].join(newline)
    const parsed = parseMemoryDocument(markdown)
    assert.deepEqual(parsed.metadata, { name: 'title', enabled: true })
    assert.equal(parsed.bodyStartLine, 5)
    assert.equal(parsed.body, body)
    assert.equal(readMemoryLines(markdown, 6, 6), 'needle')
  }
})
