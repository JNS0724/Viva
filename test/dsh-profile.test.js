import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDshProfile } from '../src/main/dsh-profile.js'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pluginDir = (name) => {
    const target = path.join(dir, 'plugins', name)
    fs.mkdirSync(target, { recursive: true })
    return target
  }
  const memory = { name: 'my-agent-memory', dir: pluginDir('memory'), config: { file: path.join(dir, "it's here", 'memory.db'), extract: false } }
  const trace = { name: 'my-agent-trace', dir: pluginDir('trace'), config: { file: path.join(dir, 'trace.db') } }
  const policy = { name: 'my-agent-policy', dir: pluginDir('policy') }
  const options = { dshHome: path.join(dir, 'dsh-home'), profile: 'my-agent', plugins: [memory, trace, policy], persona: { prefix: "你是 '助手'", suffix: '工作目录 {{cwd}}' } }
  return { dir, memory, trace, policy, options }
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
const linked = (dir, name) => fs.realpathSync(path.join(dir, 'node_modules', name))

test('the profile is the ACP composition, the persona, and each plugin with its own config', (t) => {
  const { memory, trace, policy, options } = setup(t)
  const dir = ensureDshProfile(options)

  const manifest = JSON.parse(read(dir, 'package.json'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
  assert.deepEqual(manifest.dependencies, {
    'my-agent-memory': `link:${memory.dir}`, 'my-agent-trace': `link:${trace.dir}`, 'my-agent-policy': `link:${policy.dir}`,
  })
  const patch = read(dir, 'cordis.patch.yml')
  assert.match(patch, /- id: system-prompt\n {2}config:\n {4}personaPrefix: '你是 ''助手'''\n {4}personaSuffix: '工作目录 \{\{cwd\}\}'\n/)
  assert.match(patch, /name: my-agent-memory\n {6}config:\n {8}file: '.*it''s here.*memory\.db'\n {8}extract: false\n/)
  assert.match(patch, /name: my-agent-policy\n(?! {6}config)/, 'no config, no config block')
  assert.equal(read(dir, 'cordis.yml').trim().endsWith('[]'), true)
  for (const plugin of [memory, trace, policy]) assert.equal(linked(dir, plugin.name), fs.realpathSync(plugin.dir))
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
  assert.deepEqual(Object.keys(after.dependencies).sort(), ['my-agent-memory', 'my-agent-trace', 'other-plugin'])
  assert.equal(linked(dir, 'my-agent-memory'), fs.realpathSync(moved))
  assert.equal(fs.existsSync(path.join(dir, 'node_modules', 'my-agent-policy')), false, 'a dropped plugin is not loaded any more')
  assert.doesNotMatch(read(dir, 'cordis.patch.yml'), /my-agent-policy/)
})

test('an unchanged profile is not rewritten', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  const before = fs.statSync(path.join(dir, 'cordis.patch.yml')).mtimeMs
  ensureDshProfile(options)
  assert.equal(fs.statSync(path.join(dir, 'cordis.patch.yml')).mtimeMs, before)
})

test('a real directory where a link goes is reported, never deleted; other names are refused', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  const link = path.join(dir, 'node_modules', 'my-agent-memory')
  fs.unlinkSync(link)
  fs.mkdirSync(link)
  fs.writeFileSync(path.join(link, 'keep.txt'), 'mine')

  assert.throws(() => ensureDshProfile(options), /不是链接/)
  assert.equal(fs.readFileSync(path.join(link, 'keep.txt'), 'utf8'), 'mine')
  assert.throws(() => ensureDshProfile({ ...options, plugins: [{ name: 'left-pad', dir: link }] }), /必须以 my-agent- 开头/)
})

test('an unreadable manifest stops with its path instead of being overwritten', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not json')

  assert.throws(() => ensureDshProfile(options), /package\.json 无法读取/)
  assert.equal(read(dir, 'package.json'), '{ not json')
})
