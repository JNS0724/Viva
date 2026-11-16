import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryFileJournal } from '../src/memory/node/memory-file-journal.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import { parseMemoryDocument } from '../src/memory/core/memory-document.ts'
import { scratch } from './fixtures/scratch.js'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { runToCrash } from './fixtures/memory-crash-process.ts'
import type { TestContext } from 'node:test'

function setup(t: TestContext) {
  const { dir, defer } = scratch(t, 'viva-note-files-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text && !store.readSource(id)?.withdrawn))
  const source = noteSource(store)
  const key = notes.add('session', '2026-11-14', [source], '先检查版本')!
  function commit(title = '发布流程', markdown = '先核对版本，再发布。', generation = 1) {
    const rows = notes.pending(key)
    return notes.commit(key, rows, { status: 'write', title, markdown }, generation, Date.now(),
      notes.snapshot([...notes.sources(key), ...rows.flatMap(row => row.sourceIds)]), notes.read(key))
  }
  return { dir, store, notes, source, key, commit }
}

test('session JSONL owns role-separated source versions; request replay is idempotent and rejects changed input', t => {
  const { store, notes, source, key } = setup(t)
  assert.equal(notes.add('session', '2026-11-14', [source], '先检查版本'), null)
  assert.throws(() => notes.add('session', '2026-11-14', [source], '另一条答案'), /input-mismatch/u)
  assert.equal(notes.pending(key).length, 1)
  const [workspace] = readdirSync(store.fileRoot)
  const [file] = readdirSync(join(store.fileRoot, workspace!, 'session/dialog'))
  const rows = readFileSync(join(store.fileRoot, workspace!, 'session/dialog', file!), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].messages.map((item: { role: string }) => item.role), ['user', 'assistant'])
  assert.equal(rows[0].messages[0].version, 1)
  assert.equal(rows[0].messages[0].sourceId, source.id)
  assert.equal(rows[0].messages[0].at, source.at)
  assert.equal(dbColumns(store, 'memory_note_turns').includes('assistant'), false)
})
const dbColumns = (store: ReturnType<typeof openMemoryStore>, table: string) =>
  (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)

test('daily content is a file, its index and receipt commit together, and source metadata cannot come from model frontmatter', t => {
  const { store, notes, key, commit } = setup(t)
  assert.equal(commit(), true)
  const note = notes.read(key)!
  assert.equal(note.markdown, '先核对版本，再发布。')
  const path = join(store.fileRoot, note.workspace, note.path)
  const document = parseMemoryDocument(readFileSync(path, 'utf8'))
  assert.equal(document.metadata.session_id, 'session')
  assert.equal(dbColumns(store, 'memory_daily_notes').includes('markdown'), false)
  assert.match(readFileSync(join(store.fileRoot, note.workspace, 'daily/2026-11-14.md'), 'utf8'), new RegExp(note.path.replaceAll('.', '\\.')))
  assert.equal(notes.pending(key).length, 0)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM memory_file_intents WHERE state='done' AND plan IS NULL").get()?.n, 2)
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

test('withdrawal hides immediately then purges card, index and the source/assistant transcript copy durably', t => {
  const { store, notes, source, key, commit } = setup(t)
  commit()
  const note = notes.read(key)!
  store.tx(() => notes.withdraw(source.id))
  assert.equal(notes.read(key), undefined)
  notes.recover()
  const files = readdirSync(join(store.fileRoot, note.workspace, 'session/dialog'))
  assert.deepEqual(files, [])
  assert.deepEqual(readdirSync(join(store.fileRoot, note.workspace, 'daily/2026-11-14')), [])
  assert(!readFileSync(join(store.fileRoot, note.workspace, 'daily/2026-11-14.md'), 'utf8').includes(note.path))
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

test('long Chinese names fit the filesystem and filename collisions are resolved without adopting foreign content', t => {
  const { store, notes, key, commit } = setup(t)
  commit('发布核对'.repeat(100))
  const old = notes.read(key)!
  assert(Buffer.byteLength(old.path.split('/').at(-1)!) < 255)
  const next = noteSource(store, { session: 'new-session' })
  const nextKey = notes.add('new-session', old.day, [next], '')!
  const expected = `daily/${old.day}/collision-${memoryFileRevision('new-session')}.md`
  const location = join(store.fileRoot, old.workspace, expected)
  writeFileSync(location, 'foreign card')
  notes.commit(nextKey, notes.pending(nextKey), { status: 'write', title: 'collision', markdown: 'new content' }, 2, Date.now(), notes.snapshot([next.id]), undefined)
  assert.equal(notes.read(nextKey)?.path, expected.replace('.md', '-1.md'))
  assert.equal(notes.read(key)?.path, old.path)
  assert.equal(readFileSync(location, 'utf8'), 'foreign card')
})

test('purge operation IDs are not reused after earlier cleanup receipts have completed', t => {
  const { store, notes, key, source, commit } = setup(t)
  commit()
  notes.withdraw(source.id)
  notes.recover()
  const second = noteSource(store)
  notes.add('session', '2026-11-14', [second], '')
  commit('second', 'another card', 3)
  notes.withdraw(second.id)
  notes.recover()
  assert.equal(notes.read(key), undefined)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_note_purges').get()?.n, 0)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM memory_file_intents WHERE id LIKE 'notes:purge:%' AND state='done'").get()?.n, 2)
})

test('a session append intent survives process death before its transcript write and replays once', async t => {
  const { dir, store } = setup(t)
  const source = noteSource(store, { session: 'new-session' })
  await runToCrash(new URL('./fixtures/memory-session-crash.ts', import.meta.url), 'intent', dir, source.id)
  const notes = openMemoryNotes(store, () => true)
  const group = notes.pendingGroups().find(row => row.session === 'new-session')!
  assert.equal(notes.pending(group.note)[0]?.assistant, '已完成这个回合')
  assert.equal(notes.add('new-session', '2026-11-14', [source], '已完成这个回合'), null)
  assert.equal(notes.pending(group.note).length, 1)
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
    notes.add('session', '2026-11-14', [noteSource(first)], 'test-only answer')
    assert(existsSync(firstRoot))
    assert.deepEqual(readdirSync(secondRoot), [])
  } finally { first.close(); second.close() }
  assert.equal(existsSync(firstRoot), false)
  assert.equal(existsSync(secondRoot), false)
})


test('withdrawing a turn without a card never treats an unrelated missing.md as its card', t => {
  const { store, notes, source, key } = setup(t)
  const [workspace] = readdirSync(store.fileRoot)
  assert.ok(workspace)
  const directory = join(store.fileRoot, workspace, 'daily/2026-11-14')
  mkdirSync(directory, { recursive: true })
  const unrelated = join(directory, 'missing.md')
  writeFileSync(unrelated, 'A different document owns this path.')
  store.tx(() => notes.withdraw(source.id))
  notes.recover()
  assert.equal(readFileSync(unrelated, 'utf8'), 'A different document owns this path.')
  assert.equal(notes.read(key), undefined)
  assert.deepEqual(readdirSync(join(store.fileRoot, workspace, 'session/dialog')), [])
})

test('withdrawal erases an externally rewritten managed card instead of allowing a hash change to evade cleanup', t => {
  const { store, notes, source, key, commit } = setup(t)
  commit()
  const card = notes.read(key)!
  const file = join(store.fileRoot, card.workspace, card.path)
  store.tx(() => notes.withdraw(source.id))
  writeFileSync(file, card.document + '\nAn external append still belongs to this managed identity.')
  notes.recover()
  const reopened = openMemoryNotes(store, () => true)
  assert.equal(existsSync(file), false)
  assert.equal(reopened.pendingCleanup(), 0)
  assert.equal(reopened.read(key), undefined)
})

test('a third-hash note conflict overlapping a purge does not prevent reopening or another workspace from committing', async t => {
  const { dir, store, notes, source, key, commit } = setup(t)
  commit('发布流程', 'The original procedure before the next update.')
  const before = notes.read(key)!
  const next = noteSource(store)
  notes.add('session', before.day, [next], 'A second completed turn')
  await runToCrash(new URL('./fixtures/memory-note-crash.ts', import.meta.url), 'replace', dir, key)
  const file = join(store.fileRoot, before.workspace, before.path)
  writeFileSync(file, 'External third hash after the interrupted write.')
  store.tx(() => notes.withdraw(source.id))
  const recovered = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  assert.equal(recovered.read(key), undefined)
  assert.equal(existsSync(file), false)
  assert.equal(recovered.jobState(key, 7), 'cancelled')
  const other = noteSource(store, { session: 'another-session', project: { kind: 'project', id: 'another-workspace' } })
  const otherKey = recovered.add('another-session', before.day, [other], 'Independent work can continue')!
  assert.ok(otherKey)
  assert.equal(recovered.commit(otherKey, recovered.pending(otherKey), { status: 'write', title: 'Independent card',
    markdown: 'Other workspace content.' }, 8, Date.now(), recovered.snapshot([other.id]), undefined), true)
  assert.equal(recovered.read(otherKey)?.markdown, 'Other workspace content.')
  assert.equal(existsSync(file), false)
})

for (const crash of [false, true]) test(`a ${crash ? 'recovered' : 'completed'} title update preserves inbound card versions for later withdrawal`, async t => {
  const { dir, store, notes, source, key, commit } = setup(t)
  commit('旧目标标题')
  const targetBefore = notes.read(key)!
  const inboundSource = noteSource(store, { session: 'inbound-session' })
  const inboundKey = notes.add('inbound-session', targetBefore.day, [inboundSource], '')!
  notes.commit(inboundKey, notes.pending(inboundKey), { status: 'write', title: '入链卡片',
    markdown: `Use the procedure in [[${targetBefore.path}#检查|旧流程]] before releasing.` },
  2, Date.now(), notes.snapshot([inboundSource.id]), undefined)
  const inboundBefore = notes.read(inboundKey)!
  const next = noteSource(store)
  notes.add('session', targetBefore.day, [next], '更新目标名称')
  if (crash) {
    await runToCrash(new URL('./fixtures/memory-note-crash.ts', import.meta.url), 'replace', dir, key)
  } else {
    notes.commit(key, notes.pending(key), { status: 'write', title: '发布流程', markdown: '先核对版本，再发布。' },
      7, Date.now(), notes.snapshot([source.id, next.id]), notes.read(key))
  }
  const recovered = openMemoryNotes(store, () => true)
  const targetAfter = recovered.read(key)!
  const inboundAfter = recovered.read(inboundKey)!
  assert.equal(targetAfter.path, targetBefore.path)
  assert.notEqual(targetAfter.fileRevision, targetBefore.fileRevision)
  assert.equal(inboundAfter.path, inboundBefore.path)
  assert.equal(inboundAfter.fileRevision, inboundBefore.fileRevision)
  assert.equal(inboundAfter.markdown, `Use the procedure in [[${targetAfter.path}#检查|旧流程]] before releasing.`)
  assert.equal(inboundAfter.file_revision, inboundAfter.fileRevision)
  const inboundFile = join(store.fileRoot, inboundAfter.workspace, inboundAfter.path)
  store.tx(() => recovered.withdraw(inboundSource.id))
  recovered.recover()
  assert.equal(existsSync(inboundFile), false)
  assert.equal(recovered.read(inboundKey), undefined)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_note_purges').get()?.n, 0)
  assert.equal(recovered.read(key)?.path, targetAfter.path)
})


test('a different registered identity at a former managed path is never erased by the old purge', t => {
  const { store, notes, source, key, commit } = setup(t)
  commit(); const old = notes.read(key)!
  const independent = noteSource(store, { session: 'new-owner' })
  const otherKey = notes.add('new-owner', old.day, [independent], '')!
  notes.commit(otherKey, notes.pending(otherKey), { status: 'write', title: 'Independent', markdown: 'New independent content.' }, 2, Date.now(), notes.snapshot([independent.id]), undefined)
  const other = notes.read(otherKey)!
  store.tx(() => notes.withdraw(source.id))
  renameSync(join(store.fileRoot, old.workspace, other.path), join(store.fileRoot, old.workspace, old.path))
  assert.equal(notes.reconcileRename({ operationId: 'different-owner', workspace: old.workspace, id: otherKey, from: other.path,
    to: old.path, revision: other.fileRevision, usageVersion: other.revision }), true)
  notes.recover()
  assert.equal(notes.read(otherKey)?.markdown, 'New independent content.')
  assert.equal(notes.pendingCleanup(), 0)
})


test('note replica erasure remains pending while a WAL reader retains its before-image', t => {
  const { dir, store, notes, source, key, commit } = setup(t)
  const marker = 'Private derived peppermint preference retained only in a note.'
  commit('Tea', marker)
  const note = notes.read(key)!, file = join(store.fileRoot, note.workspace, note.path)
  writeFileSync(file, note.document + '\nExternal appended text.')
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const reader = new DatabaseSync(join(dir, 'memory.db'))
  try {
    reader.exec('BEGIN'); reader.prepare('SELECT * FROM memory_daily_notes').all()
    store.tx(() => notes.withdraw(source.id)); notes.recover()
    assert.equal(existsSync(file), false)
    assert.ok(notes.pendingCleanup() > 0)
    reader.exec('COMMIT'); notes.recover()
    assert.equal(notes.pendingCleanup(), 0)
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    assert.equal(readFileSync(join(dir, 'memory.db')).includes(Buffer.from(marker)), false)
  } finally { reader.close() }
})
