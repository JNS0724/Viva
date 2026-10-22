import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { APP_ROOT, CODE_ROOT, dshLaunch, resolveConfig, rootsOf } from '../src/main/config.js'
import { externalUrl } from '../src/main/links.ts'
import { createPermissionBroker } from '../src/main/permission-broker.ts'
import { currentModelName, describeConfig, describeError } from '../src/main/session-info.ts'

const always = () => true
const never = () => false

test('config reports what is missing before the agent can start, or nothing when ready', () => {
  assert.equal(resolveConfig({}, always).problem, 'no-key')
  assert.equal(resolveConfig({ DEEPSEEK_API_KEY: 'k' }, never).problem, 'no-dsh')

  const ready = resolveConfig({ DEEPSEEK_API_KEY: 'k', DSH_BIN: '/opt/dsh', AGENT_CWD: 'rel/dir' }, always)
  assert.equal(ready.problem, null)
  assert.equal(ready.dshBin, path.resolve('/opt/dsh'))
  assert.equal(ready.cwd, path.resolve('rel/dir'))
})

test('the code is found beside the project from the sources, and in out/ once built', () => {
  const repo = path.resolve('/repo')
  assert.deepEqual(rootsOf(path.join(repo, 'src', 'main', 'config.js')), { codeRoot: repo, appRoot: repo })
  assert.deepEqual(rootsOf(path.join(repo, 'out', 'src', 'main', 'config.js')), { codeRoot: path.join(repo, 'out'), appRoot: repo })
  const asar = path.resolve('/Applications/Viva.app/Contents/Resources/app.asar')
  assert.deepEqual(rootsOf(path.join(asar, 'out', 'src', 'main', 'config.js')), { codeRoot: path.join(asar, 'out'), appRoot: asar })
  assert.equal(CODE_ROOT, APP_ROOT, 'the tests run from the sources')
})

test('config defaults live under the app root, and smoke phases are named', () => {
  const config = resolveConfig({ SMOKE_PHASE: 'walkthrough' }, never)
  assert.equal(config.dshBin, path.join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  assert.equal(config.nodeBin, process.execPath, 'dsh runs on the app itself')
  assert.equal(config.runtime.electron, true)
  assert.equal(config.cwd, path.join(APP_ROOT, 'workspace'))
  assert.deepEqual([config.smoke, config.smokePhase], [true, 'walkthrough'])
  assert.equal(config.smokeOut, path.join(APP_ROOT, 'smoke'))
  const home = resolveConfig({ DSH_HOME: '/tmp/users-dsh' }, never, '', false, { userData: '/data/Viva', execPath: '/apps/Viva' })
  assert.deepEqual([home.dshHome, home.nodeBin], [path.join('/data/Viva', 'dsh'), '/apps/Viva'], "the user's DSH_HOME is not the app's")
  assert.deepEqual(resolveConfig({ DSH_NODE: '/opt/node' }, never).runtime, { nodeBin: '/opt/node', electron: false })
  assert.equal(resolveConfig({}, never, '', false, { userData: '/data/Viva', packaged: true }).cwd, path.resolve('/data/Viva', 'workspace'), 'the installed app keeps its workspace out of its own folder')
  assert.equal(resolveConfig({ DSH_BIN: 'test/fake.js' }, never).dshBin, path.resolve('test/fake.js'))
  assert.equal(resolveConfig({ DSH_BIN: 'dsh' }, never).dshBin, 'dsh', 'a bare command is looked up on PATH')
  assert.deepEqual([resolveConfig({ SMOKE_PHASE: 'nope' }, never).smoke, resolveConfig({}, never).smokePhase], [false, null])
})

test('a JavaScript entry point runs under node (no .cmd shim on Windows); anything else runs directly', () => {
  assert.deepEqual(dshLaunch('/a/bin.js', 'node'), { command: 'node', args: ['/a/bin.js', '--profile', 'viva'] })
  assert.deepEqual(dshLaunch('/a/bin.js', 'node', 'acp').args, ['/a/bin.js', '--profile', 'acp'])
  assert.deepEqual(dshLaunch('C:\\dsh\\bin.mjs', 'node.exe').command, 'node.exe')
  assert.deepEqual(dshLaunch('/usr/local/bin/dsh', 'node'), { command: '/usr/local/bin/dsh', args: ['--profile', 'viva'] })
})

test('permission broker resolves known options, cancels unknown ones, and cancels everything on demand', async () => {
  // Arrange
  const broker = createPermissionBroker()
  const options = [{ optionId: 'allow', name: '允许', kind: 'allow_once' }]
  const a = broker.create({ options })
  const b = broker.create({ options })
  const c = broker.create({ options })

  // Act
  assert.equal(broker.resolve(a.requestId, 'allow'), true)
  assert.equal(broker.resolve(b.requestId, 'made-up'), true)
  assert.equal(broker.resolve('missing', 'allow'), false)
  broker.cancelAll()

  // Assert
  assert.deepEqual(await a.promise, { outcome: { outcome: 'selected', optionId: 'allow' } })
  assert.deepEqual(await b.promise, { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(await c.promise, { outcome: { outcome: 'cancelled' } })
  assert.equal(broker.size, 0)
})

test('current model name handles flat options, grouped options and fallbacks', () => {
  const flat = [{ id: 'model', type: 'select', currentValue: 'v4', options: [{ value: 'v4', name: 'DeepSeek V4' }] }]
  const grouped = [{ id: 'x', category: 'model', currentValue: 'b', options: [{ group: 'g', name: 'G', options: [{ value: 'b', name: 'Beta' }] }] }]
  const unnamed = [{ id: 'model', currentValue: 'raw-id', options: [] }]

  assert.equal(currentModelName(flat), 'DeepSeek V4')
  assert.equal(currentModelName(grouped), 'Beta')
  assert.equal(currentModelName(unnamed), 'raw-id')
  assert.equal(currentModelName([{ id: 'reasoning_effort' }]), '')
  assert.equal(currentModelName(undefined), '')
})

test('describeConfig reads the shape real dsh returns (grouped models + reasoning effort)', () => {
  // Arrange: copied from a live `dsh --profile acp` session/new response
  const flash = '["deepseek-official","deepseek-v4-flash"]'
  const pro = '["deepseek-official","deepseek-v4-pro"]'
  const configOptions = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: pro, options: [
      { group: 'deepseek-official', name: 'DeepSeek', options: [{ value: flash, name: 'deepseek-v4-flash' }, { value: pro, name: 'DeepSeek-V4-Pro' }] },
    ] },
    { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [
      { value: 'off', name: 'Off' }, { value: 'high', name: 'High' },
    ] },
  ]

  // Act
  const config = describeConfig(configOptions)

  // Assert
  assert.deepEqual(config, {
    model: 'DeepSeek-V4-Pro',
    modelValue: pro,
    models: [{ value: flash, name: 'deepseek-v4-flash', group: 'DeepSeek' }, { value: pro, name: 'DeepSeek-V4-Pro', group: 'DeepSeek' }],
    effort: 'high',
    efforts: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }],
  })
  assert.deepEqual(describeConfig(undefined), { model: '', modelValue: '', models: [], effort: '', efforts: [] })
})

test('describeError keeps the message and a short stderr tail', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.equal(describeError({ message: 'rpc failed' }), 'rpc failed')
  assert.equal(describeError({ message: 'Internal error', data: { details: 'unknown model option: x' } }), 'Internal error: unknown model option: x')
  assert.equal(describeError({ message: 'Bad request', data: 'quota exceeded' }), 'Bad request: quota exceeded')
  assert.equal(describeError('plain', 'a\nb\nc\nd\n'), 'plain（dsh: b | c | d）')
})

test('only web and mail links leave the app, whatever the window sends', () => {
  assert.equal(externalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(externalUrl('mailto:a@example.com'), 'mailto:a@example.com')
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'not a url', '', 42, 'https://x/' + 'a'.repeat(5000)]) {
    assert.throws(() => externalUrl(bad))
  }
})
