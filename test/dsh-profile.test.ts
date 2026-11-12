import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureDshProfile, patchFor, pluginEntry, SAFETY_ROWS, SUBAGENT_TOOLS, VIVA_LAYER_MARK, vivaLayerFile, WEB_SEARCH_OFF } from '../src/backend/dsh-profile.ts'

const ROOT = path.join(import.meta.dirname, '..')
const DSH_BASE_PATCH = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml')

type Plugin = { name: string, dir: string, config?: Record<string, unknown>, stock?: Array<{ id: string, name: string }> }

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pluginDir = (name: string) => {
    const target = path.join(dir, 'plugins', name)
    fs.mkdirSync(target, { recursive: true })
    return target
  }
  const memory: Plugin = { name: 'viva-memory', dir: pluginDir('memory'), config: { file: path.join(dir, "it's here", 'memory.db'), extract: false } }
  const trace: Plugin = { name: 'viva-trace', dir: pluginDir('trace'), config: { file: path.join(dir, 'trace.db') } }
  const history: Plugin = { name: 'viva-history', dir: pluginDir('history') }
  const dshHome = path.join(dir, 'dsh-home')
  const options = { dshHome, profile: 'viva', plugins: [memory, trace, history], persona: { prefix: "你是 '助手'", suffix: '工作目录 {{cwd}}' } }
  return { dir, dshHome, memory, trace, history, options }
}

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8')
const fileUrl = (plugin: Plugin) => pathToFileURL(pluginEntry(plugin.dir)).href

test('a plugin is entered by its TypeScript source where it has one, by the built index.js otherwise', (t) => {
  const { memory } = setup(t)
  assert.equal(pluginEntry(memory.dir), path.join(memory.dir, 'index.js'), 'built: out/plugins has only JavaScript')
  fs.writeFileSync(path.join(memory.dir, 'index.ts'), 'export const name = "viva-memory"\n')
  assert.equal(pluginEntry(memory.dir), path.join(memory.dir, 'index.ts'), 'from the sources, as the tests run it')
})

test('the app\'s layer holds the persona and each plugin by file URL with its config; the user\'s layer starts empty', (t) => {
  const { dshHome, memory, trace, history, options } = setup(t)
  const dir = ensureDshProfile(options)

  const manifest = JSON.parse(read(dir, 'package.json'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
  assert.deepEqual(manifest.dependencies, {}, 'the app\'s plugins are no dependencies of the profile')
  assert.equal(read(dir, 'cordis.patch.yml'), '[]\n')
  const layer = fs.readFileSync(vivaLayerFile(dshHome), 'utf8')
  assert.ok(layer.startsWith(VIVA_LAYER_MARK))
  assert.match(layer, /- id: system-prompt\n {2}config:\n {4}personaPrefix: '你是 ''助手'''\n {4}personaSuffix: '工作目录 \{\{cwd\}\}'\n/)
  for (const plugin of [memory, trace, history]) assert.ok(layer.includes(`    - id: ${plugin.name}\n      name: '${fileUrl(plugin).replaceAll("'", "''")}'\n`), plugin.name)
  assert.match(layer, /\n {8}file: '.*it''s here.*memory\.db'\n {8}extract: false\n/)
  assert.ok(!layer.includes(`name: '${fileUrl(history)}'\n      config`), 'no config, no config block')
  assert.match(layer, /- id: hmr\n {2}name: '@deepseek-ai\/dsh-hmr'\n {2}disabled: false\n/, 'plugins switch while dsh runs')
  assert.match(layer, /- id: tool-plugin-manager\n {2}disabled: false\n/)
  assert.ok(layer.endsWith(SAFETY_ROWS))
})

test('the plugin manager is given the app\'s pnpm when there is one', () => {
  assert.match(patchFor({ plugins: [], pnpmCommand: '/data/bin/pnpm' }), /- id: plugin-manager\n {2}config: \{"pnpmCommand":"\/data\/bin\/pnpm"\}\n/)
  assert.doesNotMatch(patchFor({ plugins: [] }), /id: plugin-manager\n/)
  assert.match(patchFor({ plugins: [], pnpmCommand: '/data/bin/pnpm', registry: 'https://npm.example.com/' }), /- id: plugin-manager\n {2}config: \{"pnpmCommand":"\/data\/bin\/pnpm","registry":"https:\/\/npm\.example\.com\/","fallbackRegistries":\[\]\}\n/,
    'a company registry is asked alone: no public one to fall back to')
})

test('the user\'s layer is kept from one launch to the next', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  const userLayer = '- id: some-plugin\n  disabled: true\n'
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), userLayer)
  ensureDshProfile(options)
  assert.equal(read(dir, 'cordis.patch.yml'), userLayer)
})

test('the user\'s plugins stay in the manifest', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  const manifestFile = path.join(dir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, dependencies: { 'other-plugin': '1.0.0' } }))
  ensureDshProfile(options)
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).dependencies, { 'other-plugin': '1.0.0' })
})

test('an unchanged layer is not rewritten; plugin names must start with viva-', (t) => {
  const { dshHome, options } = setup(t)
  ensureDshProfile(options)
  const before = fs.statSync(vivaLayerFile(dshHome)).mtimeMs
  ensureDshProfile(options)
  assert.equal(fs.statSync(vivaLayerFile(dshHome)).mtimeMs, before)
  assert.throws(() => ensureDshProfile({ ...options, plugins: [{ name: 'left-pad', dir: '/x' }] }), /必须以 viva- 开头/)
})

test('an unreadable manifest stops with its path instead of being overwritten', (t) => {
  const { options } = setup(t)
  const dir = ensureDshProfile(options)
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not json')

  assert.throws(() => ensureDshProfile(options), /package\.json 无法读取/)
  assert.equal(read(dir, 'package.json'), '{ not json')
})

test('a plugin\'s stock dsh entries are switched on with it, and only with it', () => {
  const questions = { name: 'viva-questions', dir: '/app/plugins/questions', config: {}, stock: [{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }] }
  const history = { name: 'viva-history', dir: '/app/plugins/history', config: {} }

  assert.match(patchFor({ plugins: [history, questions] }), /- id: viva-questions\n {6}name: '[^']+'\n {4}- id: tool-ask-user\n {6}name: '@deepseek-ai\/dsh-tool-ask-user'\n/)
  assert.doesNotMatch(patchFor({ plugins: [history] }), /tool-ask-user/)
})

/** A row of dsh-base's insert list, its lines after `- id:` brought to the app layer's indent. */
function baseRow(text: string, id: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(`    - id: ${id}`)
  assert.ok(start >= 0, `dsh-base has no row ${id}`)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('      ')) break
    body.push(line.slice(4))
  }
  return [`- id: ${id}`, ...body].join('\n')
}

test('the safety rows the app restates are dsh-base\'s, word for word, with disabled stated', () => {
  const base = fs.readFileSync(DSH_BASE_PATCH, 'utf8')
  const restated = SAFETY_ROWS.trimEnd().split(/\n(?=- id: )/)
  assert.deepEqual(restated.map((row) => row.split('\n')[0]), ['- id: sandbox-policy', '- id: approval', '- id: permission', '- id: fs-observation-policy'])
  for (const row of restated) {
    const id = row.split('\n')[0].slice('- id: '.length)
    // Read-before-write is off in dsh-base since 0.2.2; the app keeps it on, its row otherwise dsh-base's.
    const asBase = id === 'fs-observation-policy' ? row.replace('\n  disabled: false', '\n  disabled: true') : row.replace('\n  disabled: false', '')
    assert.equal(asBase, baseRow(base, id), `${id} drifted from dsh-base: copy it again`)
  }
})

test('the app\'s layer keeps dsh\'s sub-agents from delegating further; their read-only tools are viva-routing\'s to set', () => {
  const patch = patchFor({ plugins: [] })
  for (const [id, toolName] of [['tool-subagent', 'subagent'], ['tool-subagent-fork', 'subagent_fork']]) {
    const line = patch.split('\n').find((row) => row.startsWith('  config: ') && row.includes(`"toolName":"${toolName}"`))
    assert.ok(patch.includes(`- id: ${id}\n`) && line, `${id} is restated`)
    const config = JSON.parse(line.slice('  config: '.length))
    // dsh 0.2.1 took toolFilter, persona and the background switches off tool-subagent; one left would fail its load.
    assert.deepEqual(Object.keys(config).sort(), ['maxDepth', 'provider', 'toolName'])
    assert.equal(config.maxDepth, 1)
  }
  // todo_write keeps the sub-agent's own checklist; nothing else it gets changes anything.
  assert.ok(!SUBAGENT_TOOLS.filter((name) => name !== 'todo_write').some((name) => /write|edit|bash|pwsh|mcp|plugin|remember|forget|subagent/.test(name)))
  assert.match(patch, /- id: tool-subagent-control\n {2}disabled: true\n/)
  assert.doesNotMatch(patch, /tool-subagent-list-agents/, 'gone from dsh since 0.2.1')
})

test('联网搜索 off restates dsh-base\'s tool-web row with only search off; on, the row is left to dsh-base', () => {
  const base = fs.readFileSync(DSH_BASE_PATCH, 'utf8')
  assert.equal(WEB_SEARCH_OFF.join('\n').replace('\n    search: false', ''), baseRow(base, 'tool-web'), 'tool-web drifted from dsh-base: copy it again')
  assert.ok(patchFor({ plugins: [], webSearch: false }).includes(`${WEB_SEARCH_OFF.join('\n')}\n`))
  assert.doesNotMatch(patchFor({ plugins: [] }), /- id: tool-web\n/)
})
