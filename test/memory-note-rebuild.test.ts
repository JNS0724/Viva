import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryFileRestrictions } from '../src/memory/node/memory-file-restrictions.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'

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

test('an empty daily projection preserves its allocation across restart and a later independent turn', t => {
  const { dir, defer } = scratch(t, 'memory-empty-daily-')
  const file = join(dir, 'memory.db'), day = '2026-11-14'
  let store = openMemoryStore(file)
  defer(() => store.close())
  const open = () => openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  const notes = open(), first = noteSource(store)
  const key = notes.add('session', day, [first], '')!
  notes.commit(key, notes.pending(key), { status: 'write', title: 'Old title', markdown: 'Old projection' },
    1, Date.now(), notes.snapshot([first.id]), undefined)
  const old = notes.read(key)!
  notes.commit(key, notes.rebuildRows(key), { status: 'skip' }, 2, Date.now(), [], old, { rebuild: true })
  store.close()
  store = openMemoryStore(file)
  const reopened = open()
  assert.equal(reopened.read(key), undefined)
  assert.equal(reopened.blocked(key), false)
  assert.equal(reopened.registered().length, 0, 'empty projections are not accepted files')
  const index = join(store.fileRoot, old.workspace, `daily/${day}.md`)
  assert.ok(!readFileSync(index, 'utf8').includes(old.path))
  const fresh = noteSource(store, { text: 'This is an unrelated new turn.' })
  assert.equal(reopened.add('session', day, [fresh], ''), key)
  reopened.commit(key, reopened.pending(key), { status: 'write', title: 'New title', filename: 'new-file', markdown: fresh.text! },
    3, Date.now(), reopened.snapshot([fresh.id]), undefined)
  const projected = reopened.read(key)!
  assert.equal(projected.path, old.path)
  assert.ok(projected.revision > old.revision + 1)
  assert.equal(projected.markdown, fresh.text)
  assert.deepEqual(reopened.sources(key), [fresh.id])
  assert.ok(readFileSync(index, 'utf8').includes(old.path))
})


test('withdrawing a source does not erase external bytes at an empty daily allocation', t => {
  const { dir, defer } = scratch(t, 'memory-empty-daily-external-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text)), source = noteSource(store)
  const key = notes.add('session', '2026-11-14', [source], '')!
  notes.commit(key, notes.pending(key), { status: 'write', title: 'Previously accepted', markdown: 'Accepted body' },
    1, Date.now(), notes.snapshot([source.id]), undefined)
  const old = notes.read(key)!, path = join(store.fileRoot, old.workspace, old.path)
  notes.commit(key, notes.rebuildRows(key), { status: 'skip' }, 2, Date.now(), [], old, { rebuild: true })
  writeFileSync(path, 'An independent external file.')
  assert.equal(notes.read(key), undefined)
  const fresh = noteSource(store, { text: 'A new turn.' })
  notes.add('session', '2026-11-14', [fresh], '')
  assert.throws(() => notes.commit(key, notes.pending(key), { status: 'write', title: 'New', markdown: fresh.text! },
    3, Date.now(), notes.snapshot([fresh.id]), undefined), /memory-file-version/)
  notes.withdraw(source.id)
  notes.recover()
  assert.equal(readFileSync(path, 'utf8'), 'An independent external file.')
  assert.deepEqual(notes.rebuildRows(key).flatMap(row => row.sourceIds), [fresh.id])
})


test('external bytes at an empty daily allocation cannot anchor a digest correction', t => {
  const { dir, defer } = scratch(t, 'memory-empty-daily-anchor-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text)), source = noteSource(store)
  const key = notes.add('session', '2026-11-14', [source], '')!
  notes.commit(key, notes.pending(key), { status: 'write', title: 'Daily', markdown: 'Accepted body' },
    1, Date.now(), notes.snapshot([source.id]), undefined)
  const old = notes.read(key)!
  notes.commit(key, notes.rebuildRows(key), { status: 'skip' }, 2, Date.now(), [], old, { rebuild: true })
  const external = 'Unaccepted body'
  writeFileSync(join(store.fileRoot, old.workspace, old.path), external)
  const documents = openMemoryDocuments({ db: store.db, root: store.fileRoot, source(id) {
    const row = store.readSource(id)
    return row?.text ? { text: row.text, workspace: memorySourceWorkspace(row), token: memorySourceToken(row) } : undefined
  } })
  const input = { workspace: old.workspace, path: 'digest/wiki/independent.md', sources: notes.snapshot([source.id]), reads: [] }
  const first = documents.commit({ ...input, operationId: 'create', expectedRevision: null, action: 'CREATE', markdown: 'Current digest' })
  assert.throws(() => documents.commit({ ...input, operationId: 'unsafe-correction', expectedRevision: first.revision, action: 'CORRECT', markdown: 'Suspect change',
    corrections: [{ path: old.path, revision: memoryFileRevision(external), startLine: 1, endLine: 1, text: external, condition: '', time: '' }],
  }), /memory-correction-source-identity/)
  assert.equal(documents.read(old.workspace, first.path)?.revision, first.revision)
})


test('withdrawal removes an empty rebuild before-image even when an external index change blocks ordinary recovery', t => {
  const { dir, defer } = scratch(t, 'memory-empty-daily-withdrawal-')
  const store = openMemoryStore(join(dir, 'memory.db')), day = '2026-11-14'
  defer(() => store.close())
  let crash = false
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text), point => {
    if (crash && point === 'intent') throw new Error('simulated interruption')
  })
  const source = noteSource(store), body = 'Private before-image of the daily card.'
  const key = notes.add('session', day, [source], '')!
  notes.commit(key, notes.pending(key), { status: 'write', title: 'Previous card', markdown: body },
    1, Date.now(), notes.snapshot([source.id]), undefined)
  const old = notes.read(key)!
  crash = true
  assert.throws(() => notes.commit(key, notes.rebuildRows(key), { status: 'skip' }, 2, Date.now(), [], old, { rebuild: true }), /simulated interruption/)
  crash = false
  const index = join(store.fileRoot, old.workspace, `daily/${day}.md`)
  writeFileSync(index, 'Index changed externally')
  const plans = () => store.db.prepare("SELECT plan FROM memory_file_intents WHERE plan IS NOT NULL").all()
  assert.ok(JSON.stringify(plans()).includes(body))
  notes.withdraw(source.id)
  notes.recover()
  assert.ok(!JSON.stringify(plans()).includes(body))
  assert.equal(existsSync(join(store.fileRoot, old.workspace, old.path)), false)
  assert.equal(notes.pendingCleanup(), 0)
})


test('withdrawal cleans a shared day index without erasing a different card from a prepared plan', t => {
  const { dir, defer } = scratch(t, 'memory-shared-day-index-')
  const store = openMemoryStore(join(dir, 'memory.db')), day = '2026-11-14'
  defer(() => store.close())
  let crash = false
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text), point => {
    if (crash && point === 'intent') throw new Error('simulated interruption')
  })
  const first = noteSource(store), second = noteSource(store, { session: 'unrelated' })
  const firstKey = notes.add('session', day, [first], '')!, secondKey = notes.add('unrelated', day, [second], '')!
  notes.commit(firstKey, notes.pending(firstKey), { status: 'write', title: 'A', markdown: 'The first note' },
    1, Date.now(), notes.snapshot([first.id]), undefined)
  const saved = notes.read(firstKey)!
  crash = true
  assert.throws(() => notes.commit(secondKey, notes.pending(secondKey), { status: 'write', title: 'B', markdown: 'The second note' },
    1, Date.now(), notes.snapshot([second.id]), undefined), /simulated interruption/)
  crash = false
  const index = join(store.fileRoot, saved.workspace, `daily/${day}.md`)
  writeFileSync(index, 'Index edited externally')
  notes.withdraw(first.id)
  notes.recover()
  assert.equal(notes.pendingCleanup(), 0)
  const surviving = notes.read(secondKey)!
  assert.equal(surviving.markdown, 'The second note')
  assert.deepEqual(notes.sources(secondKey), [second.id])
  assert.equal(existsSync(join(store.fileRoot, saved.workspace, saved.path)), false)
  assert.doesNotMatch(readFileSync(index, 'utf8'), new RegExp(saved.path))
  assert.ok(readFileSync(index, 'utf8').includes(surviving.path))
})

test('a prepared daily rebuild cannot recover using a previous workspace restriction snapshot', t => {
  const { dir, defer } = scratch(t, 'memory-stale-note-restrictions-')
  const store = openMemoryStore(join(dir, 'memory.db')), day = '2026-11-14'
  defer(() => store.close())
  let crash = false
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text), point => {
    if (crash && point === 'intent') throw new Error('simulated interruption')
  })
  const source = noteSource(store), key = notes.add('session', day, [source], '')!
  const refs = notes.snapshot([source.id])
  notes.commit(key, notes.pending(key), { status: 'write', title: 'Earlier', markdown: 'Original' }, 1, Date.now(), refs, undefined)
  const prior = notes.read(key)!
  crash = true
  assert.throws(() => notes.commit(key, notes.rebuildRows(key), { status: 'skip' }, 2, Date.now(), [], prior, { rebuild: true }), /simulated interruption/)
  crash = false
  openMemoryFileRestrictions(store.db).add({ id: 'new-scope', kind: 'digest', key: 'other-card', workspace: prior.workspace,
    contentRevision: prior.fileRevision, usageVersion: 1, sources: refs })
  notes.recover()
  assert.equal(notes.jobState(key, 2), 'cancelled')
  assert.equal(notes.read(key)?.fileRevision, prior.fileRevision)
})
