import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { workDirMenu } from '../src/renderer/selectors.ts'

/** The working directory as the window shows it: the chip, its menu, and the confirmation the first time. */

const known = { current: '/w/site', defaultDir: '/data/workspace', isDefault: false, recent: ['/w/site', '/w/blog', '/data/workspace'] }

test('the folder in use and the ones used lately come from the main process', () => {
  const loaded = reduce(initialState, { type: 'workdir_loaded', view: known })
  assert.deepEqual([loaded.workDir.current, loaded.workDir.recent], ['/w/site', known.recent])
  assert.equal(loaded.workDir.menu, false)
})

test('the menu opens and closes; picking a folder for the first time asks, and answering closes the question', () => {
  const open = reduce(reduce(initialState, { type: 'workdir_loaded', view: known }), { type: 'workdir_menu', open: true })
  assert.equal(open.workDir.menu, true)
  const asking = reduce(open, { type: 'workdir_confirm', dir: '/w/new' })
  assert.deepEqual([asking.workDir.confirm, asking.workDir.menu], ['/w/new', false], 'the menu gives way to the question')
  const answered = reduce(asking, { type: 'workdir_confirm', dir: null })
  assert.equal(answered.workDir.confirm, null)
})

test('while a switch is on its way the chip waits; a refusal says why and changes nothing', () => {
  const loaded = reduce(initialState, { type: 'workdir_loaded', view: known })
  const switching = reduce(loaded, { type: 'workdir_switching' })
  assert.equal(switching.workDir.switching, true)
  const refused = reduce(switching, { type: 'workdir_failed', message: '这是系统的文件夹，不能作为工作目录' })
  assert.deepEqual([refused.workDir.switching, refused.workDir.error, refused.workDir.current], [false, '这是系统的文件夹，不能作为工作目录', '/w/site'])
  const moved = reduce(switching, { type: 'workdir_loaded', view: { ...known, current: '/w/blog' } })
  assert.deepEqual([moved.workDir.switching, moved.workDir.error, moved.workDir.current], [false, null, '/w/blog'])
})

test('the menu lists the folder in use first, then the others used lately, then the app\'s own', () => {
  const items = workDirMenu(known)
  assert.deepEqual(items.map((item) => [item.dir, item.current, item.isDefault]), [
    ['/w/site', true, false], ['/w/blog', false, false], ['/data/workspace', false, true],
  ])
  assert.equal(items[2].name, 'Viva 的文件', 'the app\'s own folder by its name in the window')
  const fresh = workDirMenu({ current: '/data/workspace', defaultDir: '/data/workspace', isDefault: true, recent: [] })
  assert.deepEqual(fresh.map((item) => [item.name, item.current]), [['Viva 的文件', true]])
})
