import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { canOpen, listFolder, previewFile, PREVIEW_LIMIT, resolveInside } from '../src/main/workspace-files.js'
import { registerFilesIpc } from '../src/main/files-ipc.js'
import { scratch } from './fixtures/scratch.js'

function workspace(t) {
  const { dir } = scratch(t, 'workspace-files-')
  const root = path.join(dir, 'workspace')
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  write('README.md', '# 项目\n\n说明')
  write('notes/day-01.md', '第一天')
  write('src/app.js', 'console.log(1)\n')
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
  write('data.bin', Buffer.from([1, 2, 0, 3, 4]))
  write('node_modules/x/index.js', '')
  write('.git/HEAD', 'ref')
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside')
  return { root, outside: dir, write }
}

test('a folder lists its folders first, then its files, by name; heavy folders are marked', (t) => {
  const { root } = workspace(t)
  const top = listFolder(root, '')
  assert.deepEqual(top.entries.map((e) => [e.name, e.kind]), [
    ['.git', 'folder'], ['node_modules', 'folder'], ['notes', 'folder'], ['src', 'folder'],
    ['data.bin', 'file'], ['logo.png', 'file'], ['README.md', 'file'],
  ])
  assert.deepEqual(top.entries.filter((e) => e.heavy).map((e) => e.name), ['.git', 'node_modules'])
  assert.deepEqual(listFolder(root, 'notes').entries.map((e) => e.path), ['notes/day-01.md'])
})

test('nothing outside the workspace can be listed or read, however the path is written', (t) => {
  const { root, outside } = workspace(t)
  for (const rel of ['../secret.txt', '/etc/passwd', 'notes/../../secret.txt', path.join(outside, 'secret.txt')]) {
    assert.throws(() => resolveInside(root, rel), /不在工作区里/, rel)
  }
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
  assert.throws(() => previewFile(root, 'link.txt'), /不在工作区里/, 'a link pointing out is refused too')
  assert.equal(resolveInside(root, 'notes/day-01.md'), path.join(fs.realpathSync(root), 'notes', 'day-01.md'))
})

test('previews: Markdown and text as text, images inline, binaries and huge files only described', (t) => {
  const { root, write } = workspace(t)
  assert.deepEqual(previewFile(root, 'README.md'), { path: 'README.md', name: 'README.md', size: 16, kind: 'markdown', text: '# 项目\n\n说明', truncated: false, openable: true })
  assert.equal(previewFile(root, 'src/app.js').kind, 'text')
  const image = previewFile(root, 'logo.png')
  assert.equal(image.kind, 'image')
  assert.match(image.dataUrl, /^data:image\/png;base64,/)
  assert.deepEqual([previewFile(root, 'data.bin').kind, previewFile(root, 'data.bin').text], ['binary', undefined])

  write('big.log', 'x'.repeat(PREVIEW_LIMIT + 10))
  const big = previewFile(root, 'big.log')
  assert.deepEqual([big.kind, big.text.length, big.truncated], ['text', PREVIEW_LIMIT, true])
  assert.throws(() => previewFile(root, 'notes'), /不是文件/)
})

test('programs and scripts are only shown in their folder, never opened', () => {
  for (const name of ['a.md', 'b.pdf', 'c.png', 'd.docx', 'e.txt']) assert.equal(canOpen(name), true, name)
  for (const name of ['run.exe', 'x.bat', 'x.cmd', 'x.ps1', 'x.sh', 'x.command', 'X.APP', 'x.js', 'x.vbs', 'x.lnk', 'x.msi', 'x.jar', 'x.scr']) {
    assert.equal(canOpen(name), false, name)
  }
})

test('the channels open documents, only show programs, and refuse paths outside', async (t) => {
  const { root, write } = workspace(t)
  write('tools/run.sh', 'echo hi')
  const handlers = {}
  const calls = []
  const shell = { openPath: async (file) => { calls.push(['open', file]); return '' }, showItemInFolder: (file) => calls.push(['show', file]) }
  registerFilesIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, { root: () => root, shell })
  const call = (channel, rel) => handlers[channel]({}, rel)

  await call('files:open', 'README.md')
  await call('files:reveal', 'tools/run.sh')
  await assert.rejects(call('files:open', 'tools/run.sh'), /只能在文件夹中显示/)
  await assert.rejects(async () => call('files:preview', '../secret.txt'), /不在工作区里/)
  await assert.rejects(async () => call('files:list', 42), /invalid path/)
  assert.deepEqual(calls.map(([kind, file]) => [kind, path.basename(file)]), [['open', 'README.md'], ['show', 'run.sh']])
})
