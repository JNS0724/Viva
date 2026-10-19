import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDshProfile } from '../src/main/dsh-profile.js'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pluginDir = (name) => {
    const target = path.join(dir, 'plugins', name)
    fs.mkdirSync(target, { recursive: true })
    return target
  }
  const memory = { name: 'viva-memory', dir: pluginDir('memory'), config: { file: path.join(dir, "it's here", 'memory.db'), extract: false } }
  const trace = { name: 'viva-trace', dir: pluginDir('trace'), config: { file: path.join(dir, 'trace.db') } }
  const policy = { name: 'viva-policy', dir: pluginDir('policy') }
  const options = { dshHome: path.join(dir, 'dsh-home'), profile: 'viva', plugins: [memory, trace, policy], persona: { prefix: "你是 '助手'", suffix: '工作目录 {{cwd}}' } }
  return { dir, memory, trace, policy, options }
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
/** Where the forwarding package dsh loads for `name` points. */
const linked = (dir, name) => {
  const index = fs.readFileSync(path.join(dir, 'node_modules', name, 'index.js'), 'utf8')
  return path.dirname(fileURLToPath(/export \* from "(.*)"/.exec(index)[1]))
}

test('the profile is the ACP composition, the persona, and each plugin with its own config', (t) => {
  const { memory, trace, policy, options } = setup(t)
  const dir = ensureDshProfile(options)

  const manifest = JSON.parse(read(dir, 'package.json'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
  assert.deepEqual(manifest.dependencies, {
    'viva-memory': `link:${memory.dir}`, 'viva-trace': `link:${trace.dir}`, 'viva-policy': `link:${policy.dir}`,
  })
  const patch = read(dir, 'cordis.patch.yml')
  assert.match(patch, /- id: system-prompt\n {2}config:\n {4}personaPrefix: '你是 ''助手'''\n {4}personaSuffix: '工作目录 \{\{cwd\}\}'\n/)
  assert.match(patch, /name: viva-memory\n {6}config:\n {8}file: '.*it''s here.*memory\.db'\n {8}extract: false\n/)
  assert.match(patch, /name: viva-policy\n(?! {6}config)/, 'no config, no config block')
  assert.equal(read(dir, 'cordis.yml').trim().endsWith('[]'), true)
  for (const plugin of [memory, trace, policy]) assert.equal(linked(dir, plugin.name), plugin.dir)
  assert.equal(JSON.parse(read(dir, 'node_modules/viva-memory/package.json')).name, 'viva-memory')
})

test('running again keeps the rest of the manifest, follows moved plugins and drops the ones no longer listed', (t) => {
  const { dir: root, memory, trace, options } = setup(t)
  const dir = ensureDshProfile(options)
  const manifestFile = path.join(dir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'other-plugin': '1.0.0' } }))

  const moved = path.join(root, 'moved')
  fs.mkdirSync(moved)
  ensureDshProfile({ ...options, plugins: [{ ...memory, dir: moved }, trace] })

  const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  assert.deepEqual(Object.keys(after.dependencies).sort(), ['other-plugin', 'viva-memory', 'viva-trace'])
  assert.equal(linked(dir, 'viva-memory'), moved)
  assert.equal(fs.existsSync(path.join(dir, 'node_modules', 'viva-policy')), false, 'a dropped plugin is not loaded any more')
  assert.doesNotMatch(read(dir, 'cordis.patch.yml'), /viva-policy/)
})

test('an unchanged profile is not rewritten', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  const before = fs.statSync(path.join(dir, 'cordis.patch.yml')).mtimeMs
  ensureDshProfile(options)
  assert.equal(fs.statSync(path.join(dir, 'cordis.patch.yml')).mtimeMs, before)
})

test('a link left by an earlier version becomes a forwarding package; a folder the app did not write stays', (t) => {
  const { memory, options } = setup(t)
  const dir = ensureDshProfile(options)
  const entry = path.join(dir, 'node_modules', 'viva-memory')
  fs.rmSync(entry, { recursive: true })
  fs.symlinkSync(memory.dir, entry, process.platform === 'win32' ? 'junction' : 'dir')
  ensureDshProfile(options)
  assert.equal(fs.lstatSync(entry).isSymbolicLink(), false)
  assert.equal(linked(dir, 'viva-memory'), memory.dir)

  fs.rmSync(entry, { recursive: true })
  fs.mkdirSync(entry)
  fs.writeFileSync(path.join(entry, 'keep.txt'), 'mine')
  assert.throws(() => ensureDshProfile(options), /不是 Viva 写的/)
  assert.equal(fs.readFileSync(path.join(entry, 'keep.txt'), 'utf8'), 'mine')
  assert.throws(() => ensureDshProfile({ ...options, plugins: [{ name: 'left-pad', dir: entry }] }), /必须以 viva- 开头/)
})

test('an unreadable manifest stops with its path instead of being overwritten', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not json')

  assert.throws(() => ensureDshProfile(options), /package\.json 无法读取/)
  assert.equal(read(dir, 'package.json'), '{ not json')
})
