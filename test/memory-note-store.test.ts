import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { openMemoryFileJournal } from '../src/memory/node/memory-file-journal.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import { parseMemoryDocument } from '../src/memory/core/memory-document.ts'
import { scratch } from './fixtures/scratch.js'
import { legacyDailyRename, noteSource } from './fixtures/memory-note-fixture.ts'
import { runToCrash } from './fixtures/memory-crash-process.ts'
import type { TestContext } from 'node:test'

function setup(t: TestContext) {
  const { dir, defer } = scratch(t, 'viva-note-files-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  const source = noteSource(store)
  const key = notes.add('session', '2026-11-14', [source], '先检查版本')!
  function commit(title = '发布流程', markdown = '先核对版本，再发布。', generation = 1) {
    const rows = notes.pending(key)
    return notes.commit(key, rows, { status: 'write', title, markdown }, generation, Date.now(),
      notes.snapshot([...notes.sources(key), ...rows.flatMap(row => row.sourceIds)]), notes.read(key))
  }
  return { dir, store, notes, source, key, commit }
}

test('deleting a daily file survives interrupted cleanup and preserves source and sibling files without writing session/dialog', t => {
  const { store, notes, source, key, commit } = setup(t)
  assert.ok(commit())
  const note = notes.read(key)!
  const sibling = noteSource(store, { session: 'sibling', text: 'Independent meeting note.' })
  const siblingKey = notes.add('sibling', note.day, [sibling], '')!
  assert.ok(notes.commit(siblingKey, notes.pending(siblingKey), { status: 'write', title: note.title, markdown: 'Independent note.' },
    1, Date.now(), notes.snapshot([sibling.id]), undefined))
  const kept = notes.read(siblingKey)!
  assert.deepEqual({ ...notes.registeredAt(note.workspace, note.path) }, { key, file_revision: note.fileRevision })
  assert.deepEqual(notes.registeredForSources([source.id, source.id]), [{ workspace: note.workspace, path: note.path }])
  const workspaceRoot = join(store.fileRoot, note.workspace)
  assert.equal(existsSync(join(workspaceRoot, 'session/dialog')), false, 'Phase 4A never writes session/dialog/*.jsonl')
  const originalSource = store.readSource(source.id)
  assert.throws(() => notes.deleteFile(note.workspace, key, note.revision + 1), /version/)
  assert.equal(notes.deleteFile(note.workspace, key, note.revision), note.revision + 1)
  assert.equal(notes.read(key), undefined)
  assert.equal(notes.registeredAt(note.workspace, note.path), undefined)
  assert.deepEqual(notes.registeredForSources([source.id, sibling.id]), [{ workspace: kept.workspace, path: kept.path }])
  assert.equal(notes.needsRecovery(), false)
  const id = `daily:${memoryFileRevision(key)}`
  assert.equal(notes.deletedFileCleanupPending(note.workspace, id), true)
  assert.equal(notes.deletedFileCleanupPending(note.workspace, `daily:${memoryFileRevision(siblingKey)}`), false)
  assert.deepEqual(notes.pending(key), [])
  assert.throws(() => openMemoryNotes(store, () => true, (point, path) => {
    if (point === 'replace' && path === note.path) throw new Error('stop after deleting card')
  }), /stop after deleting card/)
  const recovered = openMemoryNotes(store, () => true)
  assert.equal(existsSync(join(workspaceRoot, note.path)), false)
  assert.equal(recovered.deletedFileCleanupPending(note.workspace, id), false)
  assert.deepEqual(store.readSource(source.id), originalSource)
  assert.deepEqual(recovered.read(siblingKey), kept)
  const index = readFileSync(join(workspaceRoot, `daily/${note.day}.md`), 'utf8')
  assert.ok(index.includes(kept.path))
  assert.equal(index.includes(note.path), false)
  assert.equal(recovered.add('session', note.day, [source], '先检查版本'), null)
  assert.equal(recovered.commit(key, [{ id: source.id }], { status: 'write', title: 'stale', markdown: 'stale' },
    2, Date.now(), notes.snapshot([source.id]), undefined), false)
  const next = noteSource(store, { text: 'A new turn.' })
  const newKey = recovered.add('session', note.day, [next], '')!
  assert.notEqual(newKey, key)
  assert.deepEqual(recovered.pending(newKey).map(row => row.sourceIds), [[next.id]])
  assert.equal(recovered.previous(newKey, next.id), undefined)
  assert.ok(recovered.commit(newKey, recovered.pending(newKey), { status: 'write', title: 'New', markdown: 'A new turn.' },
    1, Date.now(), notes.snapshot([next.id]), undefined))
  assert.notEqual(recovered.read(newKey)!.path, note.path)
})

test('existing three-part daily identities keep their path and turn history when opening the deletion ledger', t => {
  const { store, notes, key, source, commit } = setup(t)
  assert.ok(commit())
  const saved = notes.read(key)!
  assert.deepEqual(JSON.parse(key), [saved.workspace, 'session', saved.day])
  store.db.exec('DROP TABLE memory_deleted_daily_notes')
  const restored = openMemoryNotes(store, () => true)
  assert.deepEqual(restored.read(key), saved)
  assert.deepEqual(restored.sources(key), [source.id])
  const next = noteSource(store, { text: 'A subsequent update.' })
  assert.equal(restored.add('session', saved.day, [next], ''), key)
  assert.equal(restored.deleteFile(saved.workspace, key, saved.revision), saved.revision + 1)
  restored.recoverDeletedFiles()
  assert.equal(restored.pendingGroups().length, 0)
  assert.equal(existsSync(join(store.fileRoot, saved.workspace, saved.path)), false)
})
test('memory_note_ranges stores range metadata without duplicating transcripts or assistant text in SQLite', t => {
  const { store, notes, source, key } = setup(t)
  assert.equal(notes.add('session', '2026-11-14', [source], '先检查版本'), null)
  assert.equal(notes.pending(key).length, 1)
  assert.equal(dbColumns(store, 'memory_note_ranges').includes('assistant'), false)
  assert.equal(existsSync(join(store.fileRoot, memorySourceWorkspace(source), 'session/dialog')), false)
})
const dbColumns = (store: ReturnType<typeof openMemoryStore>, table: string) =>
  (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)

test('daily content is a file, its index and receipt commit together, and source_conversation is omitted from new Daily Notes', t => {
  const { store, notes, key, commit } = setup(t)
  assert.equal(commit(), true)
  const note = notes.read(key)!
  assert.equal(note.markdown, '先核对版本，再发布。')
  const path = join(store.fileRoot, note.workspace, note.path)
  const document = parseMemoryDocument(readFileSync(path, 'utf8'))
  assert.equal(document.metadata.session_id, 'session')
  assert.equal(document.metadata.source_conversation, undefined, 'new Daily Notes omit source_conversation')
  assert.equal(dbColumns(store, 'memory_daily_notes').includes('markdown'), false)
  assert.match(readFileSync(join(store.fileRoot, note.workspace, 'daily/2026-11-14.md'), 'utf8'), new RegExp(note.path.replaceAll('.', '\\.')))
  assert.equal(notes.pending(key).length, 0)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM memory_file_intents WHERE state='done' AND plan IS NULL").get()?.n, 1)
  writeFileSync(path, readFileSync(path, 'utf8').replace('先核对版本，再发布。', '外部修改了文件正文。'))
  assert.equal(notes.read(key), undefined, 'external changes remain unavailable until independently verified')
})

test('same session/day updates one stable path; title changes preserve index and inbound links', t => {
  const { store, notes, key, commit } = setup(t)
  commit()
  const old = notes.read(key)!
  const second = noteSource(store)
  notes.add('session', old.day, [second], '补一条依据')
  const root = join(store.fileRoot, old.workspace)
  const inbound = join(root, 'daily/2026-11-13.md')
  writeFileSync(inbound, `旧记录 [[${old.path}#步骤|流程]]\n`)
  commit('上线校验', '核对版本和发布人。', 2)
  const updated = notes.read(key)!
  assert.equal(updated.path, old.path)
  assert.equal(updated.title, '上线校验')
  assert.equal(notes.list(null, null).length, 1)
  assert.equal(readdirSync(join(root, 'daily/2026-11-14')).length, 1)
  assert.equal(readFileSync(inbound, 'utf8'), `旧记录 [[${updated.path}#步骤|流程]]\n`)
  assert(readFileSync(join(root, 'daily/2026-11-14.md'), 'utf8').includes(old.path))
})

test('identical titles from different sessions and scopes cannot overwrite each other', t => {
  const { store, notes, key, commit } = setup(t)
  commit()
  for (const [session, project] of [['second', null], ['session', { kind: 'project' as const, id: 'project-b' }]] as const) {
    const source = noteSource(store, { session, project })
    const next = notes.add(session, '2026-11-14', [source], '')!
    assert.notEqual(next, key)
    notes.commit(next, notes.pending(next), { status: 'write', title: '发布流程', markdown: '另一个授权范围的流程' }, 2, Date.now(), notes.snapshot([source.id]), undefined)
  }
  const cards = notes.list(null, null)
  assert.equal(cards.length, 3)
  assert.equal(new Set(cards.map(row => `${row.workspace}/${row.path}`)).size, 3)
})

for (const point of ['intent', 'replace', 'receipt', 'checkpoint']) test(`real process death at ${point} recovers card, index and turn checkpoint without rerunning model`, async t => {
  const { dir, store, key } = setup(t)
  await runToCrash(new URL('./fixtures/memory-note-crash.ts', import.meta.url), point, dir, key)
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  const note = notes.read(key)!
  assert.equal(note.markdown, '先核对版本，再发布。')
  assert.equal(notes.pending(key).length, 0)
  assert.equal(notes.list(null, null).length, 1)
  const index = readFileSync(join(store.fileRoot, note.workspace, 'daily/2026-11-14.md'), 'utf8')
  assert.equal(index.split(note.path).length - 1, 1)
  notes.recover()
  assert.equal(notes.read(key)?.revision, 7)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_file_intents WHERE plan IS NOT NULL').get()?.n, 0)
})

test('a third hash on recovery is preserved and the entire unfinished plan stays hidden', t => {
  const { store } = setup(t)
  const workspace = memoryFileRevision('conflict')
  let fail = true
  const journal = openMemoryFileJournal({ db: store.db, root: store.fileRoot, valid: () => true, finish: () => {},
    checkpoint(point) { if (point === 'replace' && fail) { fail = false; throw new Error('simulated-stop') } } })
  const paths = ['daily/2026-11-14/a.md', 'daily/2026-11-14.md']
  assert.throws(() => journal.commit('conflict', 'same', () => ({ workspace, data: null,
    changes: paths.map(path => ({ path, before: null, after: 'planned' })) })), /simulated-stop/u)
  const files = journal.files(workspace)
  files.write(paths[0]!, 'external', files.read(paths[0]!)!.revision)
  journal.recover()
  assert.equal(files.read(paths[0]!)?.markdown, 'external')
  assert.equal(files.read(paths[1]!), null)
  assert(paths.every(path => !journal.visible(workspace, path)))
  assert.throws(() => journal.commit('other', 'other', () => ({ workspace, data: null,
    changes: [{ path: paths[1]!, before: null, after: 'another' }] })), /busy/u)
  assert.equal(journal.needsRecovery(), false, 'unchanged external bytes keep the plan quarantined')
  files.remove(paths[0]!, files.read(paths[0]!)!.revision)
  assert.equal(journal.needsRecovery(), true)
  journal.recover()
  assert.equal(files.read(paths[1]!)?.markdown, 'planned')
})

test('invalidated source rolls back partially replaced files and does not checkpoint its turns', async t => {
  const { dir, store, source, key } = setup(t)
  await runToCrash(new URL('./fixtures/memory-note-crash.ts', import.meta.url), 'replace', dir, key)
  store.db.prepare('UPDATE memory_sources SET version=version+1 WHERE id=?').run(source.id)
  const notes = openMemoryNotes(store, () => true)
  assert.equal(notes.read(key), undefined)
  assert.throws(() => notes.pending(key), /source-version/u)
  assert.equal(store.db.prepare("SELECT state FROM memory_file_intents WHERE id LIKE 'notes:note:%'").get()?.state, 'cancelled')
})

test('skip is a successful receipt with no card; a newer source version or file snapshot cannot commit', t => {
  const { store, notes, source, key } = setup(t)
  const rows = notes.pending(key)
  const refs = notes.snapshot([source.id])
  store.db.prepare('UPDATE memory_sources SET version=version+1 WHERE id=?').run(source.id)
  assert.throws(() => notes.commit(key, rows, { status: 'skip' }, 1, Date.now(), refs, undefined), /source-version/u)
  assert.throws(() => notes.pending(key), /source-version/u)
  store.db.prepare('UPDATE memory_sources SET version=version-1 WHERE id=?').run(source.id)
  assert.equal(notes.commit(key, rows, { status: 'skip' }, 2, Date.now(), notes.snapshot([source.id]), undefined), true)
  assert.equal(notes.pending(key).length, 0)
  assert.equal(notes.list(null, null).length, 0)
  assert.equal(store.readSource(source.id)?.outcome, 'note-skipped')
})


test('an external edit between members of a plan is rechecked, not overwritten by the second write', t => {
  const { store } = setup(t)
  const workspace = memoryFileRevision('between-files')
  const first = 'daily/2026-11-14/a.md', second = 'daily/2026-11-14.md'
  const journal = openMemoryFileJournal({ db: store.db, root: store.fileRoot, valid: () => true, finish: () => {},
    checkpoint(point, path) {
      if (point === 'replace' && path === first) journal.files(workspace).write(second, 'external change', null)
    } })
  assert.throws(() => journal.commit('between', 'same', () => ({ workspace, data: null,
    changes: [first, second].map(path => ({ path, before: null, after: 'planned' })) })), /plan-conflict/u)
  assert.equal(journal.files(workspace).read(second)?.markdown, 'external change')
  assert.equal(journal.visible(workspace, first), false)
})

test('daily locators contain no title and collisions are resolved without adopting foreign content', t => {
  const { store, notes, key, commit } = setup(t)
  commit('发布核对'.repeat(100))
  const old = notes.read(key)!
  assert(!old.path.includes('发布核对'))
  assert.equal(old.title, '发布核对'.repeat(100))
  const next = noteSource(store, { session: 'new-session' })
  const nextKey = notes.add('new-session', old.day, [next], '')!
  const expected = `daily/${old.day}/note-${memoryFileRevision(nextKey)}.md`
  const location = join(store.fileRoot, old.workspace, expected)
  writeFileSync(location, 'foreign card')
  notes.commit(nextKey, notes.pending(nextKey), { status: 'write', title: 'collision', markdown: 'new content' }, 2, Date.now(), notes.snapshot([next.id]), undefined)
  assert.equal(notes.read(nextKey)?.path, expected.replace('.md', '-1.md'))
  assert.equal(notes.read(key)?.path, old.path)
  assert.equal(readFileSync(location, 'utf8'), 'foreign card')
})


test('a crashed title update recovers one stable card and preserves incoming links and index', async t => {
  const { dir, store, notes, key, commit } = setup(t)
  commit('旧标题')
  const before = notes.read(key)!
  const root = join(store.fileRoot, before.workspace)
  writeFileSync(join(root, 'daily/2026-11-13.md'), `来源 [[${before.path}|原记录]]`)
  const source = noteSource(store)
  notes.add('session', before.day, [source], '确认新的流程')
  await runToCrash(new URL('./fixtures/memory-note-crash.ts', import.meta.url), 'replace', dir, key)
  const recovered = openMemoryNotes(store, () => true)
  const after = recovered.read(key)!
  assert.equal(after.path, before.path)
  assert.equal(after.title, '发布流程')
  assert.deepEqual(readdirSync(join(root, 'daily/2026-11-14')), [after.path.split('/').at(-1)!])
  assert.equal(readFileSync(join(root, 'daily/2026-11-13.md'), 'utf8'), `来源 [[${after.path}|原记录]]`)
  assert.equal(recovered.pending(key).length, 0)
  assert.equal(readFileSync(join(root, 'daily/2026-11-14.md'), 'utf8').includes(before.path), true)
})


test('in-memory stores get isolated temporary file roots which are removed with the database', () => {
  const first = openMemoryStore(':memory:'), second = openMemoryStore(':memory:')
  const firstRoot = first.fileRoot, secondRoot = second.fileRoot
  try {
    assert.notEqual(firstRoot, secondRoot)
    const notes = openMemoryNotes(first, () => true)
    const src = noteSource(first)
    const noteKey = notes.add('session', '2026-11-14', [src], 'test-only answer')!
    notes.commit(noteKey, notes.pending(noteKey), { status: 'write', title: 'Temp', markdown: 'Temp note' }, 1, Date.now(), notes.snapshot([src.id]), undefined)
    assert(existsSync(firstRoot))
    assert.deepEqual(readdirSync(secondRoot), [])
  } finally { first.close(); second.close() }
  assert.equal(existsSync(firstRoot), false)
  assert.equal(existsSync(secondRoot), false)
})
