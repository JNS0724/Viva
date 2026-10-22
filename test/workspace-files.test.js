import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { canOpen, listFolder, previewFile, PREVIEW_LIMIT, resolveInside } from '../src/main/workspace-files.ts'
import { registerFilesIpc } from '../src/main/files-ipc.js'
import { scratch } from './fixtures/scratch.js'

/** Windows lets only administrators or Developer Mode make symbolic links; without them the link check is skipped. */
function linked(t, target, link) {
  try {
    fs.symlinkSync(target, link)
    return true
  } catch (err) {
    if (err.code !== 'EPERM') throw err
    t.diagnostic('symbolic links are not allowed here: the link check is skipped')
    return false
  }
}

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
  if (linked(t, path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))) {
    assert.throws(() => previewFile(root, 'link.txt'), /不在工作区里/, 'a link pointing out is refused too')
  }
  assert.equal(resolveInside(root, 'notes/day-01.md'), path.join(fs.realpathSync(root), 'notes', 'day-01.md'))
})

test('previews: Markdown and text as text, images inline, binaries and huge files only described', (t) => {
  const { root, write } = workspace(t)
  assert.deepEqual(previewFile(root, 'README.md'), { path: 'README.md', name: 'README.md', size: 16, kind: 'markdown', text: '# 项目\n\n说明', offset: 0, nextOffset: null, openable: true })
  assert.equal(previewFile(root, 'src/app.js').kind, 'code')
  const image = previewFile(root, 'logo.png')
  assert.equal(image.kind, 'image')
  assert.match(image.dataUrl, /^data:image\/png;base64,/)
  assert.deepEqual([previewFile(root, 'data.bin').kind, previewFile(root, 'data.bin').text], ['binary', undefined])

  assert.throws(() => previewFile(root, 'notes'), /不是文件/)
})

test('a long text is read page by page, each cut at a line end', (t) => {
  const { root, write } = workspace(t)
  const line = `${'字'.repeat(99)}\n`
  write('big.log', line.repeat(Math.ceil((PREVIEW_LIMIT * 2.5) / Buffer.byteLength(line))))
  const first = previewFile(root, 'big.log')
  assert.equal(first.kind, 'text')
  assert.ok(first.text.endsWith('\n') && !first.text.includes('\uFFFD'), 'no character is split')
  assert.equal(first.nextOffset, Buffer.byteLength(first.text))
  const second = previewFile(root, 'big.log', { offset: first.nextOffset })
  assert.equal(second.offset, first.nextOffset)
  let page = second
  while (page.nextOffset !== null) page = previewFile(root, 'big.log', { offset: page.nextOffset })
  assert.equal(page.offset + Buffer.byteLength(page.text), fs.statSync(path.join(root, 'big.log')).size, 'the last page ends at the end')
})

test('code is highlighted by its language, its text escaped; CSV is marked as a table', (t) => {
  const { root, write } = workspace(t)
  write('src/x.ts', 'const a: string = "<b>"\n')
  const code = previewFile(root, 'src/x.ts')
  assert.deepEqual([code.kind, code.language], ['code', 'typescript'])
  assert.match(code.html, /<span class="hljs-keyword">const<\/span>/)
  assert.ok(code.html.includes('&lt;b&gt;') && !code.html.includes('<b>'), 'what the file says is never markup')
  write('data/t.csv', 'a,b\n1,2\n')
  assert.deepEqual([previewFile(root, 'data/t.csv').kind, previewFile(root, 'data/t.csv').text], ['csv', 'a,b\n1,2\n'])
  assert.equal(previewFile(root, 'README.md').html, undefined, 'Markdown is laid out by the page')
})

test('programs and scripts are only shown in their folder, never opened', () => {
  for (const name of ['a.md', 'b.pdf', 'c.png', 'd.docx', 'e.txt']) assert.equal(canOpen(name), true, name)
  for (const name of ['run.exe', 'x.bat', 'x.cmd', 'x.ps1', 'x.sh', 'x.command', 'X.APP', 'x.js', 'x.vbs', 'x.lnk', 'x.msi', 'x.jar', 'x.scr']) {
    assert.equal(canOpen(name), false, name)
  }
})

function channels(root, { apps = [] } = {}) {
  const handlers = {}
  const calls = []
  const notified = []
  const watchers = []
  registerFilesIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, {
    root: () => root,
    shell: { openPath: async (file) => { calls.push(['open', file]); return '' }, showItemInFolder: (file) => calls.push(['show', file]) },
    native: {
      applications: async (file) => { calls.push(['apps', file]); return apps },
      openWith: async (file, app) => { calls.push(['open-with', file, app]) },
    },
    watch: (file, onChange) => {
      const watcher = { file, onChange, closed: false, close() { this.closed = true } }
      watchers.push(watcher)
      return watcher
    },
    notify: (event) => notified.push(event),
  })
  const call = (channel, ...args) => handlers[channel]({}, ...args)
  return { call, calls, notified, watchers }
}

test('the channels open documents, only show programs, and refuse paths outside', async (t) => {
  const { root, write } = workspace(t)
  write('tools/run.sh', 'echo hi')
  const { call, calls } = channels(root)

  await call('files:open', 'README.md')
  await call('files:reveal', 'tools/run.sh')
  await assert.rejects(call('files:open', 'tools/run.sh'), /只能在文件夹中显示/)
  await assert.rejects(async () => call('files:preview', '../secret.txt'), /不在工作区里/)
  await assert.rejects(async () => call('files:list', 42), /invalid path/)
  assert.deepEqual(calls.map(([kind, file]) => [kind, path.basename(file)]), [['open', 'README.md'], ['show', 'run.sh']])
})

test('the apps that open a file are listed, and one of them opens it; a program lists none', async (t) => {
  const { root, write } = workspace(t)
  write('tools/run.sh', 'echo hi')
  const apps = [{ id: 'com.apple.TextEdit', name: '文本编辑', default: true, icon: null, extra: 'x' }]
  const { call, calls } = channels(root, { apps })
  assert.deepEqual(await call('files:apps', 'README.md'), [{ id: 'com.apple.TextEdit', name: '文本编辑', default: true, icon: null }])
  assert.deepEqual(await call('files:apps', 'tools/run.sh'), [], 'programs are never offered to open')
  await call('files:open', 'README.md', 'com.apple.TextEdit')
  assert.deepEqual(calls.at(-1).slice(2), ['com.apple.TextEdit'])
  await assert.rejects(async () => call('files:open', 'README.md', 42), /invalid app/)
})

test('a picture a Markdown file shows comes from the workspace only', async (t) => {
  const { root } = workspace(t)
  assert.match(await call0(root, 'files:image', 'logo.png'), /^data:image\/png;base64,/)
  await assert.rejects(async () => call0(root, 'files:image', 'README.md'), /不是图片/)
  await assert.rejects(async () => call0(root, 'files:image', '../secret.txt'), /不在工作区里/)
})
const call0 = (root, channel, ...args) => channels(root).call(channel, ...args)

test('the file on preview is watched, one at a time, and a change is announced', async (t) => {
  const { root } = workspace(t)
  const { call, notified, watchers } = channels(root)
  await call('files:watch', 'README.md')
  await call('files:watch', 'notes/day-01.md')
  assert.deepEqual(watchers.map((w) => [path.basename(w.file), w.closed]), [['README.md', true], ['day-01.md', false]])
  watchers[1].onChange()
  watchers[1].onChange()
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.deepEqual(notified, [{ type: 'files_changed', path: 'notes/day-01.md' }], 'a burst of saves is one change')
  await call('files:watch', null)
  assert.equal(watchers[1].closed, true)
})
