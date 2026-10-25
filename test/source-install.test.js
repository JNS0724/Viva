import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listSourceFolders } from '../src/main/source-folders.ts'
import { clearLeftovers, inspectFolder, installFolder, removeFolder } from '../src/main/source-install.ts'
import { createSourceSettings } from '../src/main/source-settings.ts'
import { openSourcesDb } from '../src/main/sources-db.ts'
import { registerSourcesIpc } from '../src/main/sources-ipc.ts'

const plainCrypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-install-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A source folder as a developer would hand it over: its manifest, its program, and a .git it does not need. */
function writeSource(dir, extra = {}) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref')
  fs.writeFileSync(path.join(dir, 'index.js'), '// v1')
  fs.writeFileSync(path.join(dir, 'viva-source.json'), JSON.stringify({
    contract: 1, id: 'acme', name: 'Acme 告警', kind: 'alert', run: ['node', 'index.js'], reads: '告警名',
    config: { token: { type: 'secret', title: '令牌', required: true } }, ...extra,
  }))
  return dir
}

test('a folder is checked before it is offered: a valid source, not one already in the sources folder', (t) => {
  const base = tempDir(t)
  const root = path.join(base, 'sources')
  const from = writeSource(path.join(base, 'acme-src'))
  const inspected = inspectFolder(from, root)
  assert.deepEqual([inspected.manifest.id, inspected.files], ['acme', 2], '.git is not counted')
  fs.mkdirSync(path.join(base, 'empty'))
  assert.match(inspectFolder(path.join(base, 'empty'), root).problem, /没有 viva-source\.json/)
  fs.mkdirSync(path.join(root, 'x'), { recursive: true })
  assert.match(inspectFolder(path.join(root, 'x'), root).problem, /已经在消息源文件夹里/)
})

test('installing copies the folder in as its id, without .git, and replacing swaps the whole folder', async (t) => {
  const base = tempDir(t)
  const root = path.join(base, 'sources')
  const from = writeSource(path.join(base, 'acme-src'))
  const target = await installFolder(inspectFolder(from, root), root)
  assert.equal(target, path.join(root, 'acme'))
  assert.deepEqual(fs.readdirSync(target).sort(), ['index.js', 'viva-source.json'])

  fs.writeFileSync(path.join(from, 'index.js'), '// v2')
  fs.writeFileSync(path.join(target, 'stale.txt'), 'left from v1')
  await installFolder(inspectFolder(from, root), root)
  assert.deepEqual(fs.readdirSync(target).sort(), ['index.js', 'viva-source.json'])
  assert.equal(fs.readFileSync(path.join(target, 'index.js'), 'utf8'), '// v2')
  assert.deepEqual(fs.readdirSync(root), ['acme'], 'nothing left over beside it')
})

test('a folder that changed after it was shown is not installed, and the old one stays', async (t) => {
  const base = tempDir(t)
  const root = path.join(base, 'sources')
  const from = writeSource(path.join(base, 'acme-src'))
  await installFolder(inspectFolder(from, root), root)
  const shown = inspectFolder(from, root)
  writeSource(from, { id: 'other' })
  await assert.rejects(installFolder(shown, root), /确认之后变了/)
  assert.deepEqual(fs.readdirSync(root), ['acme'])
})

test('leftovers of an install cut short are cleared, and only folders inside the sources folder are removed', async (t) => {
  const base = tempDir(t)
  const root = path.join(base, 'sources')
  fs.mkdirSync(path.join(root, '.installing-1'), { recursive: true })
  fs.mkdirSync(path.join(root, '.old-2'), { recursive: true })
  fs.mkdirSync(path.join(root, 'kept'), { recursive: true })
  // The only copy of a source, left when both renames of an update failed: put back, not lost.
  writeSource(path.join(root, '.old-3'))
  clearLeftovers(root)
  assert.deepEqual(fs.readdirSync(root).sort(), ['acme', 'kept'])
  fs.rmSync(path.join(root, 'acme'), { recursive: true })
  const trashed = []
  const trash = async (dir) => { trashed.push(dir) }
  assert.equal(await removeFolder({ dir: path.join(root, 'kept'), manifest: {} }, root, trash), 'trashed')
  await assert.rejects(removeFolder({ dir: base, manifest: {} }, root, trash), /不在消息源文件夹里/)
  await assert.rejects(removeFolder({ dir: root, manifest: {} }, root, trash), /不在消息源文件夹里/)
  assert.deepEqual(trashed, [path.join(root, 'kept')])
  const noTrash = async () => { throw new Error('no recycle bin on this drive') }
  assert.equal(await removeFolder({ dir: path.join(root, 'kept'), manifest: {} }, root, noTrash), 'deleted')
  assert.deepEqual(fs.readdirSync(root), [], 'with no trash, the copy is deleted')
})

test('settings IPC: choose shows the folder for a yes, install puts it in, remove lets everything about it go', async (t) => {
  const base = tempDir(t)
  const root = path.join(base, 'sources')
  const from = writeSource(path.join(base, 'acme-src'))
  const db = openSourcesDb({ file: path.join(base, 'sources.db') })
  const settings = createSourceSettings({ file: path.join(base, 'source-settings.json'), crypto: plainCrypto })
  let chosen = null
  let running = false
  const trashed = []
  const dropped = []
  const handlers = new Map()
  registerSourcesIpc({ handle: (channel, fn) => handlers.set(channel, async (...args) => fn({}, ...args)) }, {
    list: () => listSourceFolders(root),
    root,
    label: (dir) => path.relative(base, dir),
    settings,
    db,
    poller: { refresh: () => {}, pollNow: async () => {}, isRunning: () => running },
    check: async () => ({ ok: true, value: { ok: true } }),
    openFolder: async () => {},
    chooseFolder: async () => chosen,
    trash: async (dir) => {
      trashed.push(dir)
      fs.rmSync(dir, { recursive: true, force: true })
    },
    dropData: (id) => dropped.push(id),
  })
  const call = (channel, ...args) => handlers.get(channel)(...args)

  assert.equal((await call('sources:choose')).cancelled, true)
  await assert.rejects(call('sources:install'), /先选择/)
  chosen = from
  const offered = await call('sources:choose')
  assert.deepEqual(offered.pending, {
    id: 'acme', name: 'Acme 告警', kind: 'alert', reads: '告警名', command: 'node index.js', fields: ['令牌'],
    from: 'acme-src', files: 2, bytes: offered.pending.bytes, replaces: false,
  })
  assert.equal((await call('sources:cancel-install')).pending, null)

  await call('sources:choose')
  const installed = await call('sources:install')
  assert.deepEqual([installed.installed, installed.pending, installed.sources.map((s) => s.id)], ['Acme 告警', null, ['acme']])

  await call('sources:save', 'acme', { enabled: true, values: { token: 'tok' } })
  assert.equal((await call('sources:choose')).pending.replaces, true)
  running = true
  await assert.rejects(call('sources:install'), /正在拉取/)
  await assert.rejects(call('sources:remove', 'acme'), /正在拉取/)
  running = false
  await call('sources:install')
  assert.equal(settings.get(listSourceFolders(root).sources[0].manifest).enabled, true, 'replacing keeps the settings')

  const removed = await call('sources:remove', 'acme')
  assert.deepEqual([removed.sources, removed.removed, trashed, dropped], [[], 'trashed', [path.join(root, 'acme')], ['acme']])
  assert.equal(fs.readFileSync(path.join(base, 'source-settings.json'), 'utf8').includes('acme'), false)
  // Closed before the folder goes: Windows does not remove a file that is still open.
  db.close()
})
