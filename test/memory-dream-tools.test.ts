import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryDreamTools, MemoryDreamStaleError, memoryDocumentLinks, searchMemoryNodes } from '../src/memory/core/memory-dream-tools.ts'
import type { DreamDocumentSnapshot } from '../src/memory/core/memory-dream-tools.ts'
import { formatMemoryDocument } from '../src/memory/core/memory-document.ts'

const source = (id: string) => ({ namespace: 'canonical' as const, sourceId: id, revision: 1 })
const doc = (path: string, name: string, description: string, body: string, revision = 'r1'): DreamDocumentSnapshot => ({
  path, revision, usageVersion: 1, policyToken: `p-${revision}`, sources: [source(`src-${path}`)],
  markdown: formatMemoryDocument({ metadata: { name, description }, body }),
})

test('read-only dream tools expose only node_search and read and reject unknown tools', async () => {
  const existing = doc('digest/wiki/deploy.md', 'Deploy', 'Release steps', 'Step 1\nStep 2\nStep 3')
  const tools = createMemoryDreamTools({ documents: { list: () => [existing], read: p => p === existing.path ? existing : null } })
  assert.deepEqual(tools.tools?.map(t => t.name), ['node_search', 'read'])

  const rejected = await tools.executeTool({ callId: 'c1', name: 'write', input: { path: existing.path, markdown: 'x' } })
  assert.equal(rejected.state, 'rejected')
  assert.equal(rejected.content, 'memory-dream-tool-not-allowed')
})

test('node_search excludes bodies, tracks partial pages, and read enforces line bounds and bodyRead', async () => {
  const first = doc('digest/wiki/alpha.md', 'Alpha Guide', 'Release notes', 'Secret body keyword: unicorn\nLine 2')
  const second = doc('digest/wiki/beta.md', 'Beta Guide', 'Release notes', 'Beta body')
  const pages: number[] = []
  const tools = createMemoryDreamTools({
    documents: {
      list: () => [first, second],
      read: p => [first, second].find(item => item.path === p) ?? null,
      async load(_paths, search) {
        if (!search) return { list: () => [], read: p => [first, second].find(item => item.path === p) ?? null }
        const offset = search.page?.offset ?? 0
        pages.push(offset)
        if (offset === 0) return { list: () => [first], read: p => [first, second].find(item => item.path === p) ?? null, partial: true, next: { fingerprint: 'fp', offset: 1 } }
        return { list: () => [second], read: p => [first, second].find(item => item.path === p) ?? null, partial: false }
      },
    },
  })

  // Body-only term must never match node_search.
  assert.deepEqual(searchMemoryNodes([first, second], 'unicorn'), [])

  const page1 = await tools.executeTool({ callId: 's1', name: 'node_search', input: { query: 'Release' } })
  assert.equal(page1.state, 'completed')
  assert.equal(tools.searched(), true)
  assert.equal(tools.searchIncomplete(), true)
  assert.equal(tools.bodyRead(first.path), false)
  assert.deepEqual(JSON.parse(page1.content).partial, true)

  const page2 = await tools.executeTool({ callId: 's2', name: 'node_search', input: { query: 'Release' } })
  assert.equal(page2.state, 'completed')
  assert.equal(tools.searchIncomplete(), false)
  assert.deepEqual(pages, [0, 1])

  const readRes = await tools.executeTool({ callId: 'r1', name: 'read', input: { path: first.path, start_line: 1, end_line: 2 } })
  assert.equal(readRes.state, 'completed')
  assert.equal(tools.bodyRead(first.path), true)
  assert.equal(tools.observed(first.path)?.revision, 'r1')

  const badRange = await tools.executeTool({ callId: 'r2', name: 'read', input: { path: first.path, start_line: 5, end_line: 2 } })
  assert.equal(badRange.state, 'rejected')
  assert.equal(badRange.content, 'memory-dream-line-range')
})

test('concurrent revision change on an observed document triggers MemoryDreamStaleError', async () => {
  let currentDoc = doc('digest/wiki/deploy.md', 'Deploy', 'Release steps', 'Original', 'r1')
  const tools = createMemoryDreamTools({
    documents: { list: () => [currentDoc], read: p => p === currentDoc.path ? currentDoc : null },
  })
  assert.equal((await tools.executeTool({ callId: 'r1', name: 'read', input: { path: currentDoc.path } })).state, 'completed')
  assert.equal(tools.current(), true)

  currentDoc = doc('digest/wiki/deploy.md', 'Deploy', 'Release steps', 'Changed externally', 'r2')
  assert.equal(tools.current(), false)
  assert.equal(tools.current(undefined, new Set([currentDoc.path])), true)
  await assert.rejects(tools.executeTool({ callId: 'r2', name: 'read', input: { path: currentDoc.path } }), MemoryDreamStaleError)
})

test('memoryDocumentLinks ignores wikilinks inside code blocks and preserves anchors', () => {
  const md = 'See [[digest/wiki/guide.md#Spring]] and `[[digest/wiki/fake.md]]`.\n```md\n[[daily/2026-11-16/code.md]]\n```'
  assert.deepEqual(memoryDocumentLinks(md), ['digest/wiki/guide.md#Spring'])
})

test('dream node_search preserves pre-ranked hybrid semantic scores without leaking body content', async () => {
  const semanticDoc = doc('digest/wiki/opaque.md', 'Opaque Node', 'General note', 'SECRET_BODY_VALUE')
  const otherDoc = doc('digest/wiki/other.md', 'Other Node', 'Another note', 'Nothing relevant')
  const tools = createMemoryDreamTools({
    documents: {
      list: () => [semanticDoc, otherDoc],
      read: p => [semanticDoc, otherDoc].find(item => item.path === p) ?? null,
      async load(_paths, search) {
        if (!search) return { list: () => [], read: p => [semanticDoc, otherDoc].find(item => item.path === p) ?? null }
        return {
          list: () => [semanticDoc, otherDoc],
          read: p => [semanticDoc, otherDoc].find(item => item.path === p) ?? null,
          scored: new Map([[semanticDoc.path, 0.92]]),
        }
      },
    },
  })

  const res = await tools.executeTool({ callId: 'sem-1', name: 'node_search', input: { query: 'completely paraphrased concept' } })
  assert.equal(res.state, 'completed')
  const parsed = JSON.parse(res.content) as Array<{ path: string, name: string, description: string }>
  assert.deepEqual(parsed.map(n => n.path), [semanticDoc.path])
  assert.equal(res.content.includes('SECRET_BODY_VALUE'), false)
})
