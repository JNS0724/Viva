import assert from 'node:assert/strict'
import { constants, DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import path from 'node:path'
import { memoryIdentifierTokens, memoryIndexMatches, openMemoryIndex } from '../src/memory/node/memory-index.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import type { MemoryInterval } from '../src/memory/core/memory-intervals.ts'
import type { MemoryScope } from '../src/memory/contracts/memory-contract.ts'
import { scratch } from './fixtures/scratch.js'

const user = { kind: 'user' } as const
const project = { kind: 'project', id: 'scope-a' } as const
const interval = { from: null, to: null }

function fixture(t: TestContext) {
  const { dir, defer } = scratch(t, 'viva-memory-index-')
  const file = path.join(dir, 'memory.db')
  const store = openMemoryStore(file)
  defer(() => store.close())
  const add = (text: string, scope: MemoryScope = user, keywords: string[] = [], windows: MemoryInterval = interval) => {
    const revision = store.nextRevision()
    const id = store.insert({ text, scope, keywords, kind: 'fact', modality: 'asserted', conditional: false,
      source: 'agent', conversationId: null }, revision, 1, windows)
    return { id, revision }
  }
  return { store, file, add }
}

test('lexical candidates cover short names and mixed project codes in the current scope', t => {
  const { store, add } = fixture(t)
  const global = add('交接联系人是李四，负责Cafe\u0301和ＥＵ－ＱＡ＿７')
  const scoped = add('负责服务Viva/QA.2，王审阅', project, ['release-candidate'])
  add('研究Viva/QA.2', { kind: 'task', id: project.id })
  const index = openMemoryIndex(store.db)
  for (const query of ['李四', '李', 'Café', 'eu-qa_7']) {
    assert.deepEqual(index.search(query, undefined, 10), { hits: [global], truncated: false })
  }
  for (const query of ['viva/qa.2', '王', 'release-candidate']) {
    assert.deepEqual(index.search(query, project, 10), { hits: [scoped], truncated: false })
    assert.deepEqual(index.search(query, undefined, 10), { hits: [], truncated: false })
  }
  assert.deepEqual(index.search('"王" OR )', project, 10)?.hits, [scoped])
  assert.equal(memoryIndexMatches('王审阅Viva/QA.2', '王 Ｖｉｖａ／ＱＡ．２'), true)
  assert.equal(memoryIndexMatches('王审阅账单', '王 Ｖｉｖａ／ＱＡ．２'), false)
  assert.equal(memoryIndexMatches('王审阅账单', 'release-candidate', ['release-candidate']), true)
  assert.equal(memoryIndexMatches('Cafe\u0301', 'CAFÉ'), true)
  assert.deepEqual(memoryIdentifierTokens('负责Viva/QA.2 和ＥＵ－ＱＡ＿７'), ['viva/qa.2', 'eu-qa_7'])
  assert.equal(store.db.prepare('SELECT terms FROM memory_lexical_fts WHERE rowid=?').get(global.id)?.terms, null)
})

test('exact lexical matches outrank short partial matches and date boundaries apply before the limit', t => {
  const { store, add } = fixture(t)
  const current = add('alpha beta 研发与质量保障的全量验收历史记录，包含验收负责人、对接联系人与交付路径')
  const historical = add('alpha beta', user, [], { from: 5, to: 10 })
  add('alpha')
  add('beta')
  const index = openMemoryIndex(store.db)

  assert.deepEqual(index.search('alpha beta', undefined, 1)?.hits, [historical])
  assert.deepEqual(index.search('alpha beta', undefined, 1, { from: 10, to: 11 }), { hits: [current], truncated: true })
  assert.deepEqual(index.search('alpha beta', undefined, 1, { from: 4, to: 5 })?.hits, [current])
  assert.deepEqual(index.search('alpha beta', undefined, 1, { from: 9, to: 10 })?.hits, [historical])
})

test('stale index receipts do not compete with valid rows even when their tokens match', t => {
  const { store, add } = fixture(t)
  const valid = add('model handoff instructions')
  const edited = add('model handoff')
  const moved = add('model handoff')
  const deleted = add('model handoff')
  const index = openMemoryIndex(store.db)
  assert.ok(index.refresh())
  store.db.exec('DROP TRIGGER memory_lexical_update; DROP TRIGGER memory_lexical_delete')
  store.db.prepare('UPDATE memories SET revision=? WHERE id=?').run(edited.revision + 1, edited.id)
  store.db.prepare('UPDATE memories SET scope=? WHERE id=?').run(JSON.stringify(project), moved.id)
  store.remove(deleted.id)
  assert.deepEqual(index.search('model handoff', undefined, 1), { hits: [valid], truncated: false })
})

test('lexical hits follow committed revisions, forgetting, restoration, and deletion across reopen', t => {
  const { store, file, add } = fixture(t)
  const saved = add('我的地点在上海')
  let index = openMemoryIndex(store.db)
  assert.deepEqual(index.search('上海', user, 3)?.hits, [saved])

  assert.throws(() => store.tx(() => {
    store.project(saved.id, { text: '我的地点在苏州', state: 'active', windows: [interval], invalidAt: null, invalidatedBy: null }, store.nextRevision())
    assert.notEqual(index.search('苏州', user, 3)?.hits.length, 0)
    throw new Error('rollback')
  }), /rollback/)
  assert.deepEqual(index.search('上海', user, 3)?.hits, [saved])
  assert.deepEqual(index.search('苏州', user, 3)?.hits, [])

  const revision = store.nextRevision()
  store.project(saved.id, { text: '我的地点在苏州', state: 'active', windows: [interval], invalidAt: null, invalidatedBy: null }, revision)
  const second = openMemoryStore(file)
  try {
    index = openMemoryIndex(second.db)
    assert.deepEqual(index.search('上海', user, 3)?.hits, [])
    assert.deepEqual(index.search('苏州', user, 3)?.hits, [{ id: saved.id, revision }])
    store.forgetEntry(saved.id, store.nextRevision())
    assert.deepEqual(index.search('苏州', user, 3)?.hits, [])
    const restored = store.nextRevision()
    store.restoreEntry(saved.id, restored)
    assert.deepEqual(index.search('苏州', user, 3)?.hits, [{ id: saved.id, revision: restored }])
    store.remove(saved.id)
    assert.deepEqual(index.search('苏州', user, 3)?.hits, [])
    assert.equal(second.db.prepare('SELECT count(*) AS count FROM memory_lexical_fts').get()?.count, 0)
  } finally { second.close() }
})

test('lexical rebuilding is durable and an unfinished batch requests canonical fallback', t => {
  const { store, add } = fixture(t)
  store.tx(() => { for (let index = 0; index < 257; index++) add(`固定研发记录 ${index}`) })
  const index = openMemoryIndex(store.db)
  assert.equal(index.search('研发', user, 5), null)
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM memory_meta WHERE key LIKE 'lexical-dirty:%'").get()?.count, 1)
  const complete = index.search('研发', user, 5)
  assert.equal(complete?.hits.length, 5)
  assert.equal(complete?.truncated, true)

  store.db.prepare("UPDATE memory_lexical_meta SET value='older' WHERE key='version'").run()
  const reopened = openMemoryIndex(store.db)
  assert.equal(reopened.search('研发', user, 5), null)
  assert.deepEqual(reopened.search('研发', user, 5), complete)
  assert.equal(reopened.rebuild(), true, 'an explicit rebuild queues work successfully')
  assert.equal(reopened.search('研发', user, 5), null)
  assert.deepEqual(reopened.search('研发', user, 5), complete)
})

test('a malformed derived schema is replaced on startup or explicit rebuild', t => {
  const { store, add } = fixture(t)
  const saved = add('保留苏州别名')
  store.db.exec('CREATE VIEW memory_lexical_fts AS SELECT id FROM memories')
  let index = openMemoryIndex(store.db)
  assert.deepEqual(index.search('苏州', user, 3)?.hits, [saved])
  store.db.exec('DROP TABLE memory_lexical_rows')
  index = openMemoryIndex(store.db)
  const added = add('上海的运维联系方式')
  assert.deepEqual(index.search('上海', user, 3)?.hits, [added])
  store.db.exec(`DROP TABLE memory_lexical_fts;
    CREATE TABLE memory_lexical_fts (terms TEXT, scope TEXT);
    CREATE TABLE memory_lexical_dirty(id INTEGER PRIMARY KEY, invalid TEXT NOT NULL)`)
  assert.equal(index.search('上海', user, 3), null)
  assert.equal(index.rebuild(), true)
  store.remove(saved.id)
  assert.deepEqual(index.search('苏州', user, 3)?.hits, [])
  assert.deepEqual(index.search('上海', user, 3)?.hits, [added])
})

test('an index schema failure does not gate canonical writes and fallback requests rebuild', t => {
  const { store, add } = fixture(t)
  const index = openMemoryIndex(store.db)
  const saved = add('保留苏州别名')
  assert.deepEqual(index.search('苏州', user, 3)?.hits, [saved])
  store.db.exec('DROP TABLE memory_lexical_rows')
  store.forgetEntry(saved.id, store.nextRevision())
  assert.equal(store.get(saved.id)?.retention, 'forgotten')
  const committed = add('提交前的杭州地址')
  assert.equal(store.get(committed.id)?.text, '提交前的杭州地址')
  assert.equal(index.search('杭州', user, 3), null)
  store.db.setAuthorizer(code => code === constants.SQLITE_CREATE_VTABLE ? constants.SQLITE_DENY : constants.SQLITE_OK)
  try { assert.equal(index.rebuild(), false) }
  finally { store.db.setAuthorizer(null) }
  const added = add('上海的运维联系方式')
  assert.equal(store.get(added.id)?.text, '上海的运维联系方式')
  assert.equal(index.search('上海', user, 3), null)
  assert.equal(index.rebuild(), true)
  assert.deepEqual(index.search('杭州', user, 3)?.hits, [committed])
  assert.deepEqual(index.search('上海', user, 3)?.hits, [added])

  const unsupported = new DatabaseSync(':memory:')
  try {
    assert.equal(openMemoryIndex(unsupported).search('苏州', user, 3), null)
  } finally { unsupported.close() }
})
