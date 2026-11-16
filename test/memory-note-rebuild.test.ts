import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'

test('daily rebuild can replay contributed, skipped and pending turns without crossing a day or session', t => {
  const { dir, defer } = scratch(t, 'memory-note-rebuild-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  const first = noteSource(store), second = noteSource(store), third = noteSource(store), anotherDay = noteSource(store), otherSession = noteSource(store, { session: 'other' })
  const key = notes.add('session', '2026-11-14', [first], 'first')!
  notes.commit(key, notes.pending(key), { status: 'write', title: '核对', markdown: '旧笔记' }, 1, Date.now(), notes.snapshot([first.id]), undefined)
  notes.add('session', '2026-11-14', [second], 'skip')
  notes.commit(key, notes.pending(key), { status: 'skip' }, 2, Date.now(), notes.snapshot([second.id]), notes.read(key))
  notes.add('session', '2026-11-14', [third], 'new')
  notes.add('session', '2026-11-15', [anotherDay], 'tomorrow')
  notes.add('other', '2026-11-14', [otherSession], 'other')
  const rows = notes.rebuildRows(key)
  assert.deepEqual(rows.map(row => row.written), [1, 2, 0])
  assert.deepEqual(rows.flatMap(row => row.sourceIds), [first.id, second.id, third.id])
  assert.deepEqual(rows.map(row => row.assistant), ['first', 'skip', 'new'])
})

test('rebuilt daily persists exact allowed source fragments and a rebuild skip removes obsolete content', t => {
  const { dir, defer } = scratch(t, 'memory-note-rebuild-spans-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  const source = noteSource(store)
  const key = notes.add('session', '2026-11-14', [source], '')!
  notes.commit(key, notes.pending(key), { status: 'write', title: '核对', markdown: '完整来源笔记' }, 1, Date.now(), notes.snapshot([source.id]), undefined)
  const safe = notes.snapshot([source.id]).map(ref => ({ ...ref, spans: [{ start: 3, end: source.text!.length }] }))
  notes.commit(key, notes.rebuildRows(key), { status: 'write', title: '核对', markdown: '仅保留允许的部分' }, 2, Date.now(), safe, notes.read(key), { rebuild: true })
  assert.deepEqual(openMemoryNotes(store, id => Boolean(store.readSource(id)?.text)).references(key), safe)
  const current = notes.read(key)!
  assert.equal(current.markdown, '仅保留允许的部分')
  assert.throws(() => notes.commit(key, notes.rebuildRows(key), { status: 'write', title: 'bad', markdown: 'bad' }, 3, Date.now(), [{ ...safe[0]!, spans: [{ start: 0, end: 999 }] }], current, { rebuild: true }), /source-version/)
  notes.commit(key, notes.rebuildRows(key), { status: 'skip' }, 4, Date.now(), [], current, { rebuild: true })
  assert.equal(notes.read(key), undefined)
  assert.equal(existsSync(join(store.fileRoot, current.workspace, current.path)), false)
  assert.deepEqual(notes.references(key), [])
  assert(!readFileSync(join(store.fileRoot, current.workspace, 'daily/2026-11-14.md'), 'utf8').includes(current.path))
})


test('daily title and filename updates never mutate a linked digest outside its revision journal', t => {
  const { dir, defer } = scratch(t, 'memory-daily-stable-path-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  const first = noteSource(store)
  const key = notes.add('session', '2026-11-14', [first], '')!
  notes.commit(key, notes.pending(key), { status: 'write', title: '旧标题', markdown: '原始流程' }, 1, Date.now(), notes.snapshot([first.id]), undefined)
  const oldNote = notes.read(key)!
  const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, source(id) {
    const source = store.readSource(id)
    return source?.text ? { token: memorySourceToken(source), workspace: memorySourceWorkspace(source), text: source.text } : undefined
  } })
  const body = `发布时使用这个流程。\n\n## Sources\n原始步骤来自 [[${oldNote.path}#步骤|日记]]。`
  const digest = documents.commit({ operationId: 'digest', workspace: oldNote.workspace, path: 'digest/procedure/release.md', expectedRevision: null, action: 'CREATE', markdown: body, sources: notes.snapshot([first.id]), reads: [] })
  const second = noteSource(store)
  notes.add('session', '2026-11-14', [second], '')
  notes.commit(key, notes.pending(key), { status: 'write', title: '新标题', filename: '另一个文件名', markdown: '更新后的原始流程' }, 2, Date.now(), notes.snapshot([first.id, second.id]), notes.read(key))
  const newNote = notes.read(key)!
  assert.equal(newNote.path, oldNote.path)
  assert.equal(newNote.title, '新标题')
  assert.notEqual(newNote.fileRevision, oldNote.fileRevision)
  assert.equal(documents.read(oldNote.workspace, digest.path)?.revision, digest.revision)
  assert.equal(documents.read(oldNote.workspace, digest.path)?.markdown, body)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 1)
})

test('withdrawn question context remains invalid even after canonical question text is scrubbed', t => {
  const { dir, defer } = scratch(t, 'memory-question-provenance-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  const origin = noteSource(store)
  const answer = noteSource(store, { author: 'answer', text: '是', question: '按之前的发布规则吗？' })
  const key = notes.add('session', '2026-11-14', [answer], '', answer.id, [], '', { questionSources: [origin.id], questionCurrent: true })!
  assert.equal(notes.pending(key)[0]?.questionCurrent, true)
  assert.equal(notes.sourceQuestionContext(answer.id).current, true)
  notes.withdraw(origin.id)
  notes.recover()
  store.db.prepare('UPDATE memory_sources SET question=NULL WHERE id=?').run(answer.id)
  assert.equal(notes.sourceQuestionContext(answer.id).current, false)
  const row = notes.rebuildRows(key)[0]!
  assert.equal(row.questionCurrent, false)
  assert.deepEqual(row.sourceIds, [])
  const independent = noteSource(store)
  notes.add('session', '2026-11-14', [independent], '')
  assert.deepEqual(notes.rebuildRows(key).flatMap(row => row.sourceIds), [independent.id])
})
