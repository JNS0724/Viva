import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { createMemoryDreamTools, memoryDocumentLinks, memoryDreamToolDefinitions, MemoryDreamStaleError, searchMemoryNodes } from '../src/memory/core/memory-dream-tools.ts'
import type { DreamDocumentSnapshot } from '../src/memory/core/memory-dream-tools.ts'
import type { MemoryToolInvocation } from '../src/memory/contracts/service.ts'
import { formatMemoryDocument, parseMemoryDocument } from '../src/memory/core/memory-document.ts'

const daily = 'daily/2026-11-16/work.md'
const oldDaily = 'daily/2026-11-15/work.md'
const target = 'digest/wiki/work.md'
const related = 'digest/wiki/release.md'
const source = { namespace: 'test', sourceId: 'canonical-one', revision: 1 }
const document = (path: string, name: string, body: string, description = name): DreamDocumentSnapshot => ({
  path, revision: `${path}:1`, usageVersion: 1, sources: [source],
  markdown: formatMemoryDocument({ metadata: { name, description, custom: 'retained' }, body }),
})
const unit = { name: 'Deployment', bucket: 'wiki' as const, summary: 'Deployment procedure', paths: [daily] }
const content = (name = 'Deployment', body = `New procedure.\n\n## Sources\nThe decision in [[${daily}]] supports this procedure.`) =>
  formatMemoryDocument({ metadata: { name, description: 'Deployment procedure', custom: 'retained' }, body })
function setup(snapshots: DreamDocumentSnapshot[] = []) {
  const rows = new Map([document(daily, 'Today', 'We changed the deployment process.'), ...snapshots].map(snapshot => [snapshot.path, snapshot]))
  const seen: string[] = []
  const tools = createMemoryDreamTools({ unit, documents: { list: () => [...rows.values()], read: path => rows.get(path) ?? null }, onRead: snapshot => seen.push(snapshot.path) })
  let id = 0
  const call = (name: string, input: MemoryToolInvocation['input']) => tools.executeTool({ callId: String(++id), name, input })
  const search = () => call('node_search', { query: 'Deployment' })
  return { rows, seen, tools, call, search }
}

test('six dream tools expose complete JSON schemas and reject extra arguments and unknown tools', async () => {
  assert.deepEqual(memoryDreamToolDefinitions.map(tool => tool.name), ['node_search', 'read', 'frontmatter_read', 'write', 'edit', 'frontmatter_update'])
  for (const tool of memoryDreamToolDefinitions) {
    assert.equal(z.json().safeParse(tool.schema).success, true)
    assert.equal(typeof tool.schema === 'object' && tool.schema !== null && !Array.isArray(tool.schema) ? tool.schema.type : null, 'object')
  }
  const { call } = setup()
  assert.equal((await call('shell', { command: 'rm' })).state, 'rejected')
  assert.equal((await call('constructor', {})).state, 'rejected')
  assert.equal((await call('read', { path: daily, workspace: 'other-owner' })).state, 'rejected')
  assert.equal((await call('read', { path: '../daily/private.md' })).state, 'rejected')
  assert.equal((await call('write', { path: daily, markdown: 'overwrite source' })).state, 'rejected')
})

test('node_search ranks only digest metadata across the entire authorized workspace', () => {
  const irrelevant = Array.from({ length: 100 }, (_, index) => document(`digest/wiki/noise-${index}.md`, 'Other', 'Deployment appears only in the body.'))
  const exact = document(target, 'Deployment', 'Not returned', 'Release steps')
  const tagged = document(related, 'Release', 'Secret body')
  tagged.markdown = formatMemoryDocument({ metadata: { name: 'Release', description: 'Checks', memory_tags: ['Deployment'] }, body: 'Secret body' })
  const results = searchMemoryNodes([...irrelevant, exact, tagged, document(daily, 'Deployment', 'daily cannot be a node')], 'Deployment', 50)
  assert.deepEqual(new Set(results.map(result => result.snapshot.path)), new Set([target, related]))
  assert.equal(results.every(result => result.score > 0), true)
  assert.deepEqual(searchMemoryNodes([exact], 'unrelated'), [])
  assert.throws(() => searchMemoryNodes([exact], 'Deployment', 51))
})

test('node summaries add sources before returning but never expose bodies', async () => {
  const { search, seen, tools } = setup([document(target, 'Deployment', 'PRIVATE BODY')])
  const response = await search()
  assert.equal(response.state, 'completed')
  assert.equal(response.content.includes('PRIVATE BODY'), false)
  assert.deepEqual(seen, [target])
  assert.deepEqual(response.sources, [source])
  assert.equal(tools.reads()[0]?.path, target)
})

test('read line ranges are independent of paths; frontmatter reads preserve arbitrary fields', async () => {
  const { call, rows } = setup()
  const raw = rows.get(daily)!.markdown
  const result = await call('read', { path: daily, start_line: 2, end_line: 3 })
  assert.deepEqual(JSON.parse(result.content), { path: daily, start_line: 2, end_line: 3, markdown: raw.split('\n').slice(1, 3).join('\n') })
  assert.equal((await call('read', { path: daily, start_line: 3, end_line: 2 })).state, 'rejected')
  assert.equal((await call('read', { path: daily, start_line: 999 })).state, 'rejected')
  assert.equal((await call('read', { path: `${daily}:2` })).state, 'rejected')
  const metadata = JSON.parse((await call('frontmatter_read', { path: daily })).content).metadata as Record<string, unknown>
  assert.equal(metadata.custom, 'retained')
})

test('CREATE is isolated, requires search, and returns all canonical reads for commit', async () => {
  const { tools, call, search, rows, seen } = setup()
  assert.equal((await call('write', { path: target, markdown: content() })).state, 'rejected')
  await search()
  assert.equal((await call('write', { path: target, markdown: content() })).state, 'completed')
  assert.equal(rows.has(target), false)
  const staged = await call('read', { path: target })
  assert.equal(JSON.parse(staged.content).markdown, content())
  const result = tools.finish({ action: 'CREATE', target_path: target, note: 'Created from the deployment decision.' })
  assert.equal(result.before, null)
  assert.equal(result.markdown, content())
  assert.deepEqual(result.reads.map(read => read.path), [daily])
  assert.deepEqual(seen, [daily])
  assert.equal(rows.has(target), false)
})

test('existing digest needs actual body read, and all six tools operate on one draft', async () => {
  const original = document(target, 'Deployment', `Old step.\n\n## Sources\n[[${oldDaily}]] supports the old step.\nRelated: [[${related}#Checks|release checks]].`)
  const { call, search, tools, rows } = setup([original])
  await search()
  await call('frontmatter_read', { path: target })
  assert.equal((await call('write', { path: target, markdown: original.markdown })).content, 'memory-dream-read-target-first')
  await call('read', { path: target })
  assert.equal((await call('edit', { path: target, old_text: 'Old step.', new_text: `New step based on [[${daily}]].` })).state, 'completed')
  assert.equal((await call('frontmatter_update', { path: target, patch: { description: 'Updated procedure', memory_tags: ['Release'] } })).state, 'completed')
  const result = tools.finish({ action: 'REFINE', target_path: target, note: 'Clarified the same procedure.' })
  const parsed = parseMemoryDocument(result.markdown)
  assert.equal(parsed.metadata.custom, 'retained')
  assert.equal(parsed.metadata.description, 'Updated procedure')
  assert.deepEqual(parsed.metadata.memory_tags, ['Release'])
  assert.equal(parsed.body.includes(`[[${related}#Checks|release checks]]`), true)
  assert.equal(rows.get(target)!.markdown, original.markdown)
  assert.equal((await call('write', { path: related, markdown: content() })).content, 'memory-dream-single-target-required')
})

test('ambiguous exact edits and malformed drafts do not poison the previous draft', async () => {
  const original = document(target, 'Deployment', `repeat repeat\n[[${daily}]] supports this.`)
  const { call, search, tools } = setup([original])
  await search(); await call('read', { path: target })
  assert.equal((await call('edit', { path: target, old_text: 'repeat', new_text: 'changed' })).content, 'memory-dream-edit-not-unique')
  assert.equal((await call('edit', { path: target, old_text: 'missing', new_text: 'changed' })).state, 'rejected')
  await call('write', { path: target, markdown: original.markdown })
  assert.equal((await call('write', { path: target, markdown: '---\nnot closed' })).state, 'rejected')
  assert.equal(tools.finish({ action: 'CORROBORATE', target_path: target, note: 'New source agrees.' }).markdown, original.markdown)
})

test('finish verifies action, target bucket, required metadata, and original supporting links', async () => {
  const { call, search, tools } = setup()
  await search(); await call('write', { path: 'digest/personal/work.md', markdown: content() })
  assert.throws(() => tools.finish({ action: 'REFINE', target_path: 'digest/personal/work.md', note: 'Wrong action' }), /action-target/)
  assert.throws(() => tools.finish({ action: 'CREATE', target_path: 'digest/personal/work.md', note: 'Wrong bucket' }), /create-bucket/)
  assert.throws(() => tools.finish({ action: 'CREATE', target_path: target, note: 'Wrong target' }), /target-mismatch/)
  const existing = setup([document(target, 'Deployment', `Old source [[${oldDaily}]].` )])
  await existing.search(); await existing.call('read', { path: target })
  await existing.call('write', { path: target, markdown: content() })
  assert.throws(() => existing.tools.finish({ action: 'REFINE', target_path: target, note: 'Lost old source' }), /existing-link-removed/)
  await existing.call('write', { path: target, markdown: `No metadata. [[${oldDaily}]] [[${daily}]]` })
  assert.throws(() => existing.tools.finish({ action: 'REFINE', target_path: target, note: 'No summaries' }), /summary-required/)
})

test('wikilink validation ignores code/escapes and requires explicit full paths', async () => {
  assert.deepEqual(memoryDocumentLinks(`\`[[${daily}]]\`\n\`\`\`md\n[[${oldDaily}]]\n\`\`\`\n\\[[${target}]]\n[[${related}#Checks|label]]\n[[daily/2026-11-16/work]]`), [`${related}#Checks`])
  const { call, search, tools } = setup()
  await search(); await call('write', { path: target, markdown: content('Deployment', `Only a code example: \`[[${daily}]]\``) })
  assert.throws(() => tools.finish({ action: 'CREATE', target_path: target, note: 'Not an actual evidence link' }), /unit-source-missing/)
})

test('new read dependencies and usage versions invalidate next tool call and commit', async () => {
  const { call, search, tools, rows } = setup([document(target, 'Deployment', `[[${daily}]] supports this.`)])
  await search(); await call('read', { path: target })
  await call('write', { path: target, markdown: content() })
  rows.set(target, { ...rows.get(target)!, usageVersion: 2 })
  assert.equal(tools.current(), false)
  await assert.rejects(call('node_search', { query: 'Deployment' }), MemoryDreamStaleError)
  assert.throws(() => tools.finish({ action: 'REFINE', target_path: target, note: 'stale' }), MemoryDreamStaleError)
})

test('disappeared sources, a newly-created target, and onRead barrier failures never become ordinary tool errors', async () => {
  const first = setup()
  await first.search(); await first.call('read', { path: daily }); await first.call('write', { path: target, markdown: content() })
  first.rows.delete(daily)
  await assert.rejects(first.call('frontmatter_read', { path: target }), MemoryDreamStaleError)
  const second = setup()
  await second.search(); await second.call('write', { path: target, markdown: content() })
  second.rows.set(target, document(target, 'Concurrent create', 'Other content'))
  assert.throws(() => second.tools.finish({ action: 'CREATE', target_path: target, note: 'stale' }), MemoryDreamStaleError)
  const failure = new Error('dispatch-denied')
  const snapshot = document(target, 'Deployment', 'body')
  const guarded = createMemoryDreamTools({ unit, documents: { list: () => [snapshot], read: () => snapshot }, onRead: () => { throw failure } })
  await assert.rejects(guarded.executeTool({ callId: '1', name: 'node_search', input: { query: 'Deployment' } }), error => error === failure)
})

test('superseded content carries trusted applicability outside Markdown and status changes invalidate the readset', async () => {
  const supersession = { path: target, revision: 'old-revision', startLine: 7, endLine: 7, text: 'Old claim', condition: 'current location', time: 'since today',
    sourceDocumentId: 'old-doc', documentId: 'replacement-id', replacementRevision: 'replacement-revision', operationId: 'correction-operation' }
  const snapshot = { ...document(target, 'Deployment', 'Old claim'), applicability: { state: 'superseded' as const, supersessions: [supersession] } }
  const { call, search, rows, tools } = setup([snapshot])
  const result = JSON.parse((await search()).content) as Array<{ applicability: DreamDocumentSnapshot['applicability'] }>
  assert.deepEqual(result, [])
  const raw = JSON.parse((await call('read', { path: target })).content) as { markdown: string, applicability: DreamDocumentSnapshot['applicability'] }
  assert.equal(raw.markdown, snapshot.markdown)
  assert.deepEqual(raw.applicability, snapshot.applicability)
  const frontmatter = JSON.parse((await call('frontmatter_read', { path: target })).content) as { applicability: DreamDocumentSnapshot['applicability'] }
  assert.deepEqual(frontmatter.applicability, snapshot.applicability)
  rows.set(target, { ...snapshot, applicability: { state: 'unavailable', supersessions: [supersession] } })
  assert.equal(tools.current(), false)
  await assert.rejects(call('read', { path: target }), MemoryDreamStaleError)
  const unavailable = setup([{ ...snapshot, applicability: { state: 'unavailable', supersessions: [supersession] } }])
  assert.deepEqual(JSON.parse((await unavailable.search()).content), [])
  assert.equal((await unavailable.call('read', { path: target })).state, 'rejected')
})

test('node search omits superseded metadata while annotated evidence reads remain available', async () => {
  const old = { ...document(target, 'Deployment', 'Old deployment.'), policyToken: 'old-policy',
    applicability: { state: 'superseded' as const, supersessions: [] } }
  const { search, call } = setup([old])
  const result = await search()
  assert.equal(result.content.includes(target), false)
  const evidence = JSON.parse((await call('read', { path: target })).content)
  assert.ok(evidence.markdown.includes('Old deployment.'))
  assert.equal(evidence.applicability.state, 'superseded')
})

test('a transitive applicability policy change invalidates tool reads even with identical direct metadata and sources', async () => {
  const observed = { ...document(target, 'Deployment', 'Original evidence.'), policyToken: 'A-B',
    applicability: { state: 'superseded' as const, supersessions: [] } }
  const { rows, tools, call } = setup([observed])
  assert.equal((await call('read', { path: target })).state, 'completed')
  assert.equal(tools.current(), true)
  rows.set(target, { ...observed, policyToken: 'A-B-C' })
  assert.equal(tools.current(), false)
  await assert.rejects(call('read', { path: target }), MemoryDreamStaleError)
})

test('dream evidence reads use the shared original line map for lone CR files', async () => {
  const { rows, call } = setup()
  const original = rows.get(daily)!
  rows.set(daily, { ...original, markdown: original.markdown.replaceAll('\n', '\r') })
  const lines = original.markdown.split('\n'), line = lines.findIndex(value => value === 'We changed the deployment process.') + 1
  const result = await call('read', { path: daily, start_line: line, end_line: line })
  assert.equal(result.state, 'completed')
  assert.equal(JSON.parse(result.content).markdown, lines[line - 1])
})
