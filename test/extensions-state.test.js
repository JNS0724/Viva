import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'

const run = (actions, state = initialState) => actions.reduce(reduce, state)

const SENTRY = { name: 'sentry', type: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp-server'], envNames: ['SENTRY_HOST'], headerNames: [], missingNames: ['SENTRY_TOKEN'] }
const view = { servers: [SENTRY], status: { active: [], dropped: [] }, skills: [], skillDir: '/d', dsh: { defaultLabel: '~/.dsh', lastLabel: '' } }

test('editing a server lists its saved keys and the missing ones, each with its own row id', () => {
  const state = run([{ type: 'extensions_loaded', view }, { type: 'extensions_edit', server: SENTRY }])
  assert.deepEqual(state.extensions.editing, {
    name: 'sentry', type: 'stdio',
    keys: [{ id: 0, name: 'SENTRY_HOST', saved: true }, { id: 1, name: 'SENTRY_TOKEN', saved: false }],
    nextId: 2,
  })
})

test('key rows are added and removed by id, and the type can be switched', () => {
  const editing = run([
    { type: 'extensions_edit', server: SENTRY },
    { type: 'extensions_edit_key_add' },
    { type: 'extensions_edit_key_remove', id: 0 },
    { type: 'extensions_edit_type', kind: 'http' },
  ]).extensions.editing
  assert.deepEqual(editing.keys.map((key) => [key.id, key.name, key.saved]), [[1, 'SENTRY_TOKEN', false], [2, '', false]])
  assert.equal(editing.type, 'http')
  assert.equal(editing.nextId, 3)
})

test('a failed save keeps the form open; a saved one closes it', () => {
  const editing = run([{ type: 'extensions_edit', server: SENTRY }, { type: 'extensions_busy' }, { type: 'extensions_failed', message: '名称不合法' }])
  assert.equal(editing.extensions.editing.name, 'sentry')
  assert.equal(editing.extensions.error, '名称不合法')
  const saved = run([{ type: 'extensions_saved', view, notice: '已保存' }], editing)
  assert.deepEqual([saved.extensions.editing, saved.extensions.notice], [null, '已保存'])
  assert.equal(run([{ type: 'extensions_edit', server: null }], editing).extensions.editing, null, 'cancel')
})

test('the import menu opens and closes; an import shows its note by the servers, cleared by the next change', () => {
  const opened = run([{ type: 'extensions_import_menu' }])
  assert.equal(opened.extensions.importMenu, true)
  assert.equal(run([{ type: 'extensions_import_menu' }], opened).extensions.importMenu, false)
  assert.equal(run([{ type: 'extensions_import_menu', open: false }], opened).extensions.importMenu, false)

  const imported = run([{ type: 'extensions_busy' }, { type: 'extensions_saved', view, notice: null, importNote: '已从 ~/.dsh 导入 1 个：sentry。' }], opened)
  assert.deepEqual([imported.extensions.importMenu, imported.extensions.importNote, imported.extensions.dsh.defaultLabel], [false, '已从 ~/.dsh 导入 1 个：sentry。', '~/.dsh'])
  assert.equal(run([{ type: 'extensions_busy' }], imported).extensions.importNote, null)
})
