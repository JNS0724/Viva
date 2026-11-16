import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { createMemoryRuntime } from '../src/memory/core/memory-runtime.ts'
import { openMemoryRuntimeResources } from '../src/memory/node/runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import type { MemoryDocuments } from '../src/memory/core/ports/documents.ts'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'

const origin = { conversation: 'document-conversation', session: 'document-session' }
function fixture(t: TestContext) {
  const { dir, defer } = scratch(t, 'memory-document-runtime-')
  const now = () => Date.parse('2026-11-16T12:00:00Z')
  const store = openMemoryStore(join(dir, 'memory.db'), now)
  const resources = openMemoryRuntimeResources({ store, now })
  const openDocuments = resources.openDocuments
  let documents!: MemoryDocuments
  let failCleanup = false
  resources.openDocuments = (...args) => {
    documents = openDocuments(...args)
    return { ...documents, recover() { if (failCleanup) throw new Error('test-cleanup-unavailable'); documents.recover() } }
  }
  const calls: MemoryCompute[] = []
  const memory = createMemoryRuntime({ store, resources, now, timezone: () => 'UTC', dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    compute(job) {
      calls.push(job)
      if (job.stage !== 'note') return null
      const input = JSON.parse(job.input) as { existing?: {markdown:string}, turns: Array<{ user: Array<{ text: string }> }> }
      return Promise.resolve(JSON.stringify({ status: 'write', title: '个人资料', markdown: [input.existing?.markdown ?? '', ...input.turns.flatMap(turn => turn.user.map(source => source.text))].filter(Boolean).join('\n') }))
    },
  })
  defer(() => memory.close())
  function ref(id: string) {
    const source = store.readSource(id)!
    return { workspace: memorySourceWorkspace(source), reference: { id, token: memorySourceToken(source) } }
  }
  return { file: join(dir, 'memory.db'), store, memory, documents, calls, ref, setCleanupFailure: (value: boolean) => { failCleanup = value } }
}

test('runtime rebuilds mixed daily notes from permitted fragments and keeps unrelated new input usable', async t => {
  const f = fixture(t), sourceId = randomUUID(), text = '我住深圳。我喜欢茶。'
  f.memory.accept(text, origin, sourceId)
  f.memory.recordNoteTurn!(origin.session, [sourceId], '明白')
  await f.memory.wake()
  const { workspace, reference } = f.ref(sourceId)
  const home = f.documents.commit({ operationId: 'home', workspace, path: 'digest/personal/home.md', expectedRevision: null, action: 'CREATE', markdown: '深圳', sources: [{ ...reference, spans: [{ start: 0, end: 5 }] }], reads: [] })
  const tea = f.documents.commit({ operationId: 'tea', workspace, path: 'digest/personal/tea.md', expectedRevision: null, action: 'CREATE', markdown: '喜欢茶', sources: [{ ...reference, spans: [{ start: 5, end: text.length }] }], reads: [] })
  const before = JSON.parse(f.memory.handle({ op: 'recall', session: origin.session, query: '深圳' }, origin)) as { notes?: unknown[] }
  assert.equal(before.notes?.length, 1)
  const revision = f.memory.revision()
  await f.memory.setDocumentEnabled({ operationId: 'stop-home', workspace, documentId: home.documentId, expectedRevision: home.revision!, expectedUsageVersion: home.usageVersion, enabled: false })
  assert(f.memory.revision() > revision)
  assert.equal(f.memory.readDocument!(workspace, home.path), null)
  assert.equal(f.memory.readDocument!(workspace, tea.path)?.markdown, '喜欢茶')
  const after = JSON.parse(f.memory.handle({ op: 'recall', session: origin.session, query: '深圳' }, origin)) as { notes?: unknown[] }
  assert.equal(after.notes?.length ?? 0, 0)
  const noteCalls = f.calls.filter(call => call.stage === 'note').length
  const next = randomUUID()
  f.memory.accept('今天还有一个安排', origin, next)
  f.memory.recordNoteTurn!(origin.session, [next], '继续')
  await f.memory.wake()
  const laterCalls = f.calls.filter(call => call.stage === 'note').slice(1)
  assert(f.calls.filter(call => call.stage === 'note').length > noteCalls, 'unrelated new input must still produce a note')
  assert(laterCalls.every(call => !call.input.includes('深圳')), 'stopped fragments and the old mixed summary must not enter a model request')
  assert(laterCalls.some(call => call.input.includes('喜欢茶')))
  assert(laterCalls.some(call => call.input.includes('今天还有一个安排')))
  const safe = JSON.parse(f.memory.handle({ op: 'recall', session: origin.session, query: '安排' }, origin)) as { notes?: Array<{markdown:string}> }
  assert(safe.notes?.some(note => note.markdown.includes('今天还有一个安排')))
  const teaRecall = JSON.parse(f.memory.handle({ op: 'recall', session: origin.session, query: '喜欢茶' }, origin)) as { notes?: Array<{markdown:string}> }
  assert(teaRecall.notes?.some(note => note.markdown.includes('喜欢茶')))
  assert(teaRecall.notes?.every(note => !note.markdown.includes('深圳')))
})

test('runtime undo advances the request revision, preserves disabled status and refuses stale usage versions', async t => {
  const f = fixture(t), id = randomUUID()
  f.memory.accept('我住深圳，后来搬到上海', origin, id)
  const { workspace, reference } = f.ref(id)
  const first = f.documents.commit({ operationId: 'home', workspace, path: 'digest/personal/home.md', expectedRevision: null, action: 'CREATE', markdown: '深圳', sources: [reference], reads: [] })
  const changed = f.documents.commit({ operationId: 'edit', workspace, path: first.path, expectedRevision: first.revision, action: 'REFINE', markdown: '上海', sources: [reference], reads: [] })
  const stopped = await f.memory.setDocumentEnabled({ operationId: 'stop', workspace, documentId: changed.documentId, expectedRevision: changed.revision!, expectedUsageVersion: changed.usageVersion, enabled: false })
  const revision = f.memory.revision()
  await assert.rejects(f.memory.undoDocument({ operationId: 'stale', workspace, documentId: changed.documentId, revision: changed.revision!, usageVersion: changed.usageVersion }), /version/)
  const undone = await f.memory.undoDocument({ operationId: 'undo-current', workspace, documentId: changed.documentId, revision: stopped.revision!, usageVersion: stopped.usageVersion })
  assert(f.memory.revision() > revision)
  assert.equal(f.memory.readDocument!(workspace, first.path), null)
  assert.equal(f.memory.readDocument!(workspace, first.path, { includeDisabled: true })?.enabled, false)
  assert.equal(f.memory.readDocument!(workspace, first.path, { includeDisabled: true })?.markdown, '深圳')
  assert(undone.usageVersion > stopped.usageVersion)
})

test('runtime deletion reports stopped until document replicas are physically cleared', async t => {
  const f = fixture(t)
  const memory = f.memory.addMemory('我的项目代号是青岚')!
  const { workspace, reference } = f.ref(memory.evidence[0]!.sourceId)
  const document = f.documents.commit({ operationId: 'digest', workspace, path: 'digest/wiki/project.md', expectedRevision: null, action: 'CREATE', markdown: '项目代号青岚', sources: [reference], reads: [] })
  f.setCleanupFailure(true)
  const result = await f.memory.deleteMemory(memory.id, memory.revision, randomUUID())
  assert.equal(result.status, 'stopped')
  assert(f.memory.cleanupPending() > 0)
  assert.equal(f.memory.readDocument!(workspace, document.path), null)
  assert(existsSync(join(f.store.fileRoot, workspace, document.path)))
  f.setCleanupFailure(false)
  f.documents.recover()
  assert.equal(f.documents.pendingCleanup(), 0)
  assert.equal(existsSync(join(f.store.fileRoot, workspace, document.path)), false)
})

test('an answer without assistant text cannot reintroduce stopped context through its question', async t => {
  const f = fixture(t), id = randomUUID()
  f.memory.accept('我住深圳', origin, id)
  f.memory.recordNoteTurn!(origin.session, [id], '')
  await f.memory.wake()
  const { workspace, reference } = f.ref(id)
  const first = f.documents.commit({ operationId: 'home', workspace, path: 'digest/personal/home.md', expectedRevision: null, action: 'CREATE', markdown: '深圳', sources: [reference], reads: [] })
  await f.memory.setDocumentEnabled({ operationId: 'disable', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion, enabled: false })
  await f.memory.wake()
  const before = f.calls.length
  const answerId = randomUUID()
  f.memory.accept('是', origin, answerId, { requestId: 'question-request', questionId: 'question', question: '你还住深圳吗？', custom: true })
  f.memory.recordNoteTurn!(origin.session, [answerId], '')
  await f.memory.wake()
  assert(f.calls.slice(before).every(call => !call.input.includes('深圳')), 'question context is derived even when there is no assistant message')
})


test('a cleared deletion leaves no digest plaintext in the database WAL', async t => {
  const f = fixture(t), marker = '我喜欢在周三下午整理蓝色笔记本里的旅行照片'
  const entry = f.memory.addMemory(marker)!
  const { workspace, reference } = f.ref(entry.evidence[0]!.sourceId)
  f.documents.commit({ operationId: 'digest', workspace, path: 'digest/wiki/project.md', expectedRevision: null, action: 'CREATE', markdown: marker, sources: [reference], reads: [] })
  const result = await f.memory.deleteMemory(entry.id, entry.revision, randomUUID())
  assert.equal(result.status, 'cleared')
  for (const file of [f.file, `${f.file}-wal`]) {
    if (existsSync(file)) assert.equal(readFileSync(file).includes(marker), false, file)
  }
})

test('a forgotten question context never promotes its old short answer and does not block later independent notes', async t => {
  const f = fixture(t), original = randomUUID()
  f.memory.accept('我住深圳', origin, original)
  f.memory.recordNoteTurn!(origin.session, [original], '')
  await f.memory.wake()
  const answer = randomUUID()
  f.memory.accept('是', origin, answer, { requestId: 'question-request', questionId: 'question', question: '你还住深圳吗？', custom: true })
  f.memory.recordNoteTurn!(origin.session, [answer], '')
  await f.memory.wake()
  f.memory.withdraw({ ids: [original], conversation: origin.conversation, onlySources: true })
  await f.memory.wake()
  const before = f.calls.length
  const fresh = randomUUID()
  f.memory.accept('我喜欢收集植物标本', origin, fresh)
  f.memory.recordNoteTurn!(origin.session, [fresh], '')
  await f.memory.wake()
  const inputs = f.calls.slice(before).filter(call => call.stage === 'note').map(call => JSON.parse(call.input) as { turns: Array<{ user: Array<{sourceId:string,text:string}> }> })
  assert(inputs.some(input => input.turns.some(turn => turn.user.some(source => source.sourceId === fresh))))
  assert(inputs.every(input => input.turns.every(turn => turn.user.every(source => source.sourceId !== answer))))
  const recalled = JSON.parse(f.memory.handle({ op: 'recall', session: origin.session, query: '植物标本' }, origin)) as { notes?: Array<{markdown:string}> }
  assert(recalled.notes?.some(note => note.markdown.includes('植物标本')))
  assert(recalled.notes?.every(note => !note.markdown.includes('深圳')))
})

test('a question erased before delayed first intake never turns its short answer into standalone evidence', async t => {
  const f = fixture(t), answerId = randomUUID()
  f.memory.accept('是', origin, answerId, { requestId: 'late-question', questionId: 'late-card', question: '你仍住在紫藤城吗？', custom: true })
  assert.deepEqual(f.store.clearSourceQuestions(), [answerId])
  f.memory.recordNoteTurn!(origin.session, [answerId], '')
  await f.memory.wake()
  assert.equal(f.calls.filter(call => call.stage === 'note').length, 0)
  const turn = f.store.db.prepare('SELECT question_valid,written FROM memory_note_turns WHERE id=?').get(answerId)
  assert.equal(turn?.question_valid, 0)
  assert.equal(turn?.written, 2)
  const next = randomUUID()
  f.memory.accept('我喜欢轻松的园艺活动', origin, next)
  f.memory.recordNoteTurn!(origin.session, [next], '')
  await f.memory.wake()
  const call = f.calls.find(call => call.stage === 'note')
  assert.ok(call)
  assert.match(call.input, /园艺/)
  assert.equal(call.input.includes('紫藤城'), false)
  assert.equal((JSON.parse(call.input) as { turns: Array<{ user: Array<{ sourceId: string }> }> }).turns.flatMap(turn => turn.user).some(user => user.sourceId === answerId), false)
})
