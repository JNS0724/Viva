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
