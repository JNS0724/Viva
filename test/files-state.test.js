import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { touchedPaths } from '../src/renderer/files-state.js'

const run = (actions, from = initialState) => actions.reduce(reduce, from)
const entry = (path, kind = 'file') => ({ name: path.split('/').pop(), path, kind, size: 1, heavy: false })

test('folders load, open and close; a preview lands only for the file still selected', () => {
  const listed = run([
    { type: 'files_listed', path: '', entries: [entry('notes', 'folder'), entry('README.md')] },
    { type: 'files_toggled', path: 'notes' },
    { type: 'files_listed', path: 'notes', entries: [entry('notes/a.md')] },
  ])
  assert.deepEqual(Object.keys(listed.files.folders), ['', 'notes'])
  assert.deepEqual(listed.files.expanded, ['notes'])
  assert.deepEqual(reduce(listed, { type: 'files_toggled', path: 'notes' }).files.expanded, [])

  const picked = run([{ type: 'files_selected', path: 'README.md' }, { type: 'files_selected', path: 'notes/a.md' }], listed)
  assert.equal(picked.files.loading, 'notes/a.md')
  const stale = reduce(picked, { type: 'files_previewed', preview: { path: 'README.md', kind: 'text', text: 'x' } })
  assert.equal(stale.files.preview, null, 'an answer for an earlier pick is dropped')
  const shown = reduce(picked, { type: 'files_previewed', preview: { path: 'notes/a.md', kind: 'markdown', text: '# a' } })
  assert.deepEqual([shown.files.preview.path, shown.files.loading], ['notes/a.md', null])
})

test('after a turn the folders are read again, keeping what is open and selected', () => {
  const open = run([
    { type: 'files_listed', path: '', entries: [entry('notes', 'folder')] },
    { type: 'files_toggled', path: 'notes' },
    { type: 'files_selected', path: 'notes/a.md' },
    { type: 'files_stale' },
  ])
  assert.deepEqual([open.files.folders, open.files.expanded, open.files.selected], [{}, ['notes'], 'notes/a.md'])
  assert.equal(run([{ type: 'files_failed', message: '这个位置不在工作区里' }]).files.error, '这个位置不在工作区里')
})

test('the files the agent touched, as workspace paths, on either platform', () => {
  const tool = (id, path) => ({ type: 'acp_update', at: 1, update: { sessionUpdate: 'tool_call', toolCallId: id, title: 't', status: 'completed', locations: [{ path }] } })
  const mac = run([{ type: 'ready', info: { mode: 'live', cwd: '/Users/me/workspace' } }, tool('a', '/Users/me/workspace/notes/a.md'), tool('b', '/etc/hosts')])
  assert.deepEqual([...touchedPaths(mac)], ['notes/a.md'])
  const win = run([{ type: 'ready', info: { mode: 'live', cwd: 'C:\\Users\\me\\workspace' } }, tool('a', 'C:\\Users\\me\\workspace\\notes\\a.md')])
  assert.deepEqual([...touchedPaths(win)], ['notes/a.md'])
})

const page = (offset, text, nextOffset, extra = {}) => ({ path: 'big.log', name: 'big.log', size: 30, kind: 'text', text, offset, nextOffset, openable: true, ...extra })

test('later pages join the first; a page for another place, or a stale one, is dropped; a change starts over', () => {
  const picked = run([{ type: 'files_selected', path: 'big.log' }, { type: 'files_previewed', preview: page(0, 'one\n', 4) }])
  const more = run([{ type: 'files_more' }, { type: 'files_previewed', preview: page(4, 'two\n', 8) }], picked)
  assert.deepEqual([more.files.preview.text, more.files.preview.nextOffset, more.files.loadingMore], ['one\ntwo\n', 8, false])
  assert.equal(reduce(more, { type: 'files_previewed', preview: page(4, 'two\n', 8) }).files.preview.text, 'one\ntwo\n', 'the same page twice joins once')
  const code = run([{ type: 'files_selected', path: 'big.log' }, { type: 'files_previewed', preview: page(0, 'a\n', 2, { kind: 'code', html: '<span>a</span>\n' }) },
    { type: 'files_previewed', preview: page(2, 'b\n', null, { kind: 'code', html: '<span>b</span>\n' }) }])
  assert.equal(code.files.preview.html, '<span>a</span>\n<span>b</span>\n')
  assert.equal(reduce(more, { type: 'files_previewed', preview: page(0, 'new\n', null) }).files.preview.text, 'new\n', 'the file read again replaces what was shown')
})

test('the apps for a file, the open menu and the table view are kept per preview', () => {
  const state = run([
    { type: 'files_selected', path: 'a.csv' },
    { type: 'files_apps', path: 'a.csv', apps: [{ id: 'x', name: 'Numbers', default: true, icon: null }] },
    { type: 'files_menu', open: true },
    { type: 'files_view', mode: 'text' },
  ])
  assert.deepEqual([state.files.apps['a.csv'][0].name, state.files.menu, state.files.view], ['Numbers', true, 'text'])
  const next = reduce(state, { type: 'files_selected', path: 'b.md' })
  assert.deepEqual([next.files.menu, next.files.view], [false, 'table'], 'a new file starts with the menu closed and tables as tables')
})
