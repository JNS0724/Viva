import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMemoryMarkdown } from '../src/memory/core/memory-markdown.ts'
import { memoryDocumentLinks } from '../src/memory/core/memory-dream-tools.ts'

const length = (text: string) => new TextEncoder().encode(text).byteLength
function checkSlices(markdown: string, maxBytes: number) {
  const result = parseMemoryMarkdown(markdown, { maxBytes })
  for (const chunk of result.chunks) {
    assert.equal(chunk.text, markdown.slice(chunk.startOffset, chunk.endOffset))
    assert.equal(chunk.startLine, markdown.slice(0, chunk.startOffset).split('\n').length)
    assert.equal(chunk.endLine, markdown.slice(0, chunk.endOffset - 1).split('\n').length)
    assert.ok(length(chunk.text) <= maxBytes, `oversized chunk: ${length(chunk.text)}`)
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(chunk.text))
    assert.ok(!/[\uD800-\uDBFF]$/u.test(chunk.text))
  }
  return result
}

test('AST preserves original CRLF offsets and full-file lines after frontmatter', () => {
  const markdown = '---\r\nname: 项目\r\nextra: true\r\n---\r\n# 项目\r\n\r\n重复内容\r\n\r\n## 子项\r\n重复内容'
  const result = checkSlices(markdown, 60)
  assert.deepEqual(result.metadata, { name: '项目', extra: true })
  assert.equal(result.chunks.map(chunk => chunk.text).join(''), markdown.slice(markdown.indexOf('# 项目')))
  assert.equal(result.chunks[0]!.startLine, 5)
  assert.equal(result.chunks.at(-1)!.endLine, 10)
  assert.deepEqual(result.chunks.at(-1)!.headingPath, ['项目', '子项'])
})

test('heading hierarchy includes setext headings and resets at a shallower sibling', () => {
  const result = parseMemoryMarkdown('Root\n====\nintro\n\n### Child\nbody\n\n## Sibling\nlast\n\n# Other\nfinal')
  assert.deepEqual(result.chunks.map(chunk => chunk.headingPath), [['Root'], ['Root', 'Child'], ['Root', 'Sibling'], ['Other']])
  assert.equal(result.chunks[1]!.searchText, `Root\nChild\n${result.chunks[1]!.text}`)
  assert.ok(!result.chunks[1]!.text.startsWith('Root'))
})

test('tables, nested lists and fenced code remain whole when they fit the budget', () => {
  const blocks = ['| 项目 | 值 |\n| --- | --- |\n| 地点 | 深圳 |\n', '- one\n  - nested\n  - more\n- two\n', '```ts\nconst text = "inside"\n```\n']
  const markdown = blocks.join('\n')
  const result = checkSlices(markdown, 100)
  for (const block of blocks) assert.ok(result.chunks.some(chunk => chunk.text.includes(block.trimEnd())))
  assert.equal(result.chunks.map(chunk => chunk.text).join(''), markdown)
})

test('oversized leaves and single lines retain every Unicode character and the final tail', () => {
  const markdown = '# 长文\n\n' + '中文😀é'.repeat(100) + '\n\n```text\n' + '尾部'.repeat(90) + '\n```\nTAIL-NEEDLE'
  for (const budget of [4, 7, 31, 100]) {
    const result = checkSlices(markdown, budget)
    assert.equal(result.chunks.map(chunk => chunk.text).join(''), markdown)
    assert.ok(result.chunks.at(-1)!.text.endsWith(budget < 12 ? 'E' : 'TAIL-NEEDLE'))
  }
})

test('large lists split between fitting items before splitting an oversized item', () => {
  const markdown = '- first item\n- second item\n- ' + 'long'.repeat(25) + '\n- last item'
  const result = checkSlices(markdown, 30)
  assert.equal(result.chunks.map(chunk => chunk.text).join(''), markdown)
  assert.ok(result.chunks.some(chunk => chunk.text.includes('- first item\n- second item')))
  assert.ok(result.chunks.at(-1)!.text.includes('- last item'))
})

test('wikilinks distinguish path, anchor and label with exact repeated occurrence lines', () => {
  const markdown = '---\nname: "[[ignored.md]]"\n---\n# Title\n[[digest/wiki/a.md#主题|显示]]\n\n[[digest/wiki/a.md#主题|显示]]\n'
  assert.deepEqual(parseMemoryMarkdown(markdown).links, [
    { path: 'digest/wiki/a.md', anchor: '主题', label: '显示', line: 5 },
    { path: 'digest/wiki/a.md', anchor: '主题', label: '显示', line: 7 },
  ])
})

test('AST wikilinks ignore escaped, inline, fenced, indented and nested code', () => {
  const markdown = '\\[[digest/wiki/no.md]] `[[digest/wiki/no.md]]`\n\n```md\n[[digest/wiki/no.md]]\n```\n\n    [[digest/wiki/no.md]]\n\n- item\n  - [[digest/wiki/yes.md]]\n\n  ```md\n  [[digest/wiki/no.md]]\n  ```\n\n> [[digest/wiki/quoted.md]]\n>\n> ```\n> [[digest/wiki/no.md]]\n> ```\n\n[[digest/wiki/yes.md]]'
  assert.deepEqual(parseMemoryMarkdown(markdown).links, [
    { path: 'digest/wiki/yes.md', line: 10 },
    { path: 'digest/wiki/quoted.md', line: 16 },
    { path: 'digest/wiki/yes.md', line: 22 },
  ])
})

test('table cells and emphasis report links without promoting inline code', () => {
  const markdown = '| A | B |\n|---|---|\n| [[digest/wiki/a.md]] | `[[digest/wiki/no.md]]` |\n\n**[[digest/wiki/a.md]]**'
  assert.deepEqual(parseMemoryMarkdown(markdown).links, [
    { path: 'digest/wiki/a.md', line: 3 }, { path: 'digest/wiki/a.md', line: 5 },
  ])
})

test('dream link compatibility validates paths and deduplicates anchor references', () => {
  assert.deepEqual(memoryDocumentLinks('[[../bad.md]] [[digest/wiki/a.md#x|one]] [[digest/wiki/a.md#x|two]] [[daily/2026-11-16.md]]'),
    ['digest/wiki/a.md#x', 'daily/2026-11-16.md'])
})

test('invalid frontmatter and unusable byte budgets are rejected without partial output', () => {
  assert.throws(() => parseMemoryMarkdown('---\nname: broken'), /unclosed-memory-frontmatter/u)
  for (const maxBytes of [0, 3, -1, NaN, Infinity, 3.5]) assert.throws(() => parseMemoryMarkdown('ok', { maxBytes }), /invalid-memory-chunk-budget/u)
  assert.deepEqual(parseMemoryMarkdown(''), { metadata: {}, chunks: [], links: [] })
})


test('table escaped display-label separators retain original line locations', () => {
  const markdown = '| Name |\n| --- |\n| [[digest/wiki/a.md\\|shown]] |'
  assert.deepEqual(parseMemoryMarkdown(markdown).links, [{ path: 'digest/wiki/a.md', label: 'shown', line: 3 }])
})

test('deindented repeated block content maps to the first nested occurrence', () => {
  const markdown = '> first\n> [[digest/wiki/a.md]]\n>\n> first\n> [[digest/wiki/a.md]]\n\nfirst\n[[digest/wiki/a.md]]'
  assert.deepEqual(parseMemoryMarkdown(markdown).links.map(link => link.line), [2, 5, 8])
})


test('tab-indented nested list links map to actual source lines without indexing nested code', () => {
  const markdown = '- a\n\t- [[digest/wiki/nested.md]]\n\n\t```\n\t[[digest/wiki/no.md]]\n\t```'
  assert.deepEqual(parseMemoryMarkdown(markdown).links, [{ path: 'digest/wiki/nested.md', line: 2 }])
})


test('duplicate Markdown reference definitions preserve source partition and following link positions', () => {
  const markdown = '[a]: /one\n\n[a]: /two\n\n[[digest/wiki/yes.md]]\n\n[a]'
  const result = checkSlices(markdown, 30)
  assert.equal(result.chunks.map(chunk => chunk.text).join(''), markdown)
  assert.deepEqual(result.links, [{ path: 'digest/wiki/yes.md', line: 5 }])
})
