import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDshProfile, MEMORY_PLUGIN } from '../src/main/dsh-profile.js'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pluginDir = path.join(dir, 'plugins', 'memory')
  fs.mkdirSync(pluginDir, { recursive: true })
  const options = { dshHome: path.join(dir, 'dsh-home'), profile: 'my-agent', pluginDir, memoryFile: path.join(dir, "it's here", 'memory.db') }
  return { dir, pluginDir, options }
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')

test('the profile is the ACP composition plus the memory plugin, configured with the memory.db', (t) => {
  const { pluginDir, options } = setup(t)
  const dir = ensureDshProfile(options)

  const manifest = JSON.parse(read(dir, 'package.json'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
  assert.equal(manifest.dependencies[MEMORY_PLUGIN], `link:${pluginDir}`)
  assert.match(read(dir, 'cordis.patch.yml'), /name: my-agent-memory\n {6}config:\n {8}file: '.*it''s here.*memory\.db'\n/)
  assert.equal(read(dir, 'cordis.yml').trim().endsWith('[]'), true)
  assert.equal(fs.realpathSync(path.join(dir, 'node_modules', MEMORY_PLUGIN)), fs.realpathSync(pluginDir))
})

test('running again changes nothing, keeps what else the manifest says, and follows a moved plugin', (t) => {
  const { dir: root, options } = setup(t)
  const dir = ensureDshProfile(options)
  const manifestFile = path.join(dir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'other-plugin': '1.0.0' } }))
  ensureDshProfile(options)
  const before = fs.statSync(path.join(dir, 'cordis.patch.yml')).mtimeMs

  const moved = path.join(root, 'moved')
  fs.mkdirSync(moved)
  ensureDshProfile({ ...options, pluginDir: moved })

  const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  assert.equal(after.dependencies['other-plugin'], '1.0.0')
  assert.equal(after.dependencies[MEMORY_PLUGIN], `link:${moved}`)
  assert.equal(fs.statSync(path.join(dir, 'cordis.patch.yml')).mtimeMs, before, 'an unchanged patch is not rewritten')
  assert.equal(fs.realpathSync(path.join(dir, 'node_modules', MEMORY_PLUGIN)), fs.realpathSync(moved))
})

test('a real directory where the link goes is reported, never deleted', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  const link = path.join(dir, 'node_modules', MEMORY_PLUGIN)
  fs.unlinkSync(link)
  fs.mkdirSync(link)
  fs.writeFileSync(path.join(link, 'keep.txt'), 'mine')

  assert.throws(() => ensureDshProfile(options), /不是链接/)
  assert.equal(fs.readFileSync(path.join(link, 'keep.txt'), 'utf8'), 'mine')
})

test('an unreadable manifest stops with its path instead of being overwritten', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not json')

  assert.throws(() => ensureDshProfile(options), /package\.json 无法读取/)
  assert.equal(read(dir, 'package.json'), '{ not json')
})
