import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { DSH_TIMEOUT_MS, ROOT, startHarness } from './fixtures/dsh-harness.ts'
import { changeView, inspectionView, pluginsView } from '../src/backend/plugins-ipc.ts'
import { specFit } from '../src/backend/plugin-catalog.ts'
import { pluginStanding } from '../src/renderer/capabilities-state.ts'

/**
 * The plugins page against the real dsh: a plugin shaped like a community one (a bundle, one host tool, a Web
 * client part) installed through the app's channel and dsh's own plugin manager, with the pnpm the app ships.
 */
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plugins', 'demo-plugin')
const TOOL = 'demo_dsh_echo'
const INSTALL_TIMEOUT_MS = 5 * 60_000

type Bridge = {
  start: () => Promise<unknown>, dispose: () => Promise<unknown>,
  startTask: () => Promise<{ ok: boolean, taskId?: string }>, promptTask: (taskId: string, text: string) => Promise<unknown>,
  plugins: (op: string, args?: Record<string, unknown>) => Promise<{ ok: boolean, value?: any, problem?: string }>,
}

/**
 * The tools the model is offered in a new background task now: a user's plugin is a task's to use (the main
 * conversation only routes).
 */
async function toolsNow(agent: Bridge, llm: { requests: Array<{ tools?: Array<{ name: string }> }> }): Promise<string[]> {
  const task = await agent.startTask()
  assert.ok(task.ok && task.taskId, JSON.stringify(task))
  await agent.promptTask(task.taskId, '你好')
  const asked = [...llm.requests].reverse().find((request) => request.tools?.length)
  return (asked?.tools ?? []).map((tool) => tool.name)
}

test('a plugin installed through the app loads in dsh, switches off while dsh runs, and stays off after a relaunch', { timeout: DSH_TIMEOUT_MS + INSTALL_TIMEOUT_MS }, async (t) => {
  const { bridge, llm, relaunch, profileDir } = await startHarness(t)
  const agent = bridge() as unknown as Bridge
  await agent.start()

  const installed = await agent.plugins('install', { spec: FIXTURE })
  assert.ok(installed.ok, installed.problem)
  assert.equal(installed.value.application, 'applied', JSON.stringify(installed.value).slice(0, 600))
  assert.ok((await toolsNow(agent, llm)).includes(TOOL), 'its tool is offered')
  assert.ok((await toolsNow(agent, llm)).includes('schedule_create'), 'the app\'s own plugins still load')

  const listed = await agent.plugins('list')
  const [plugin, ...others] = pluginsView(listed.value, profileDir)
  assert.equal(others.length, 0)
  assert.deepEqual([plugin.name, plugin.enabled, plugin.fit.kind, plugin.rows.map((row) => row.phase)], ['demo-dsh-plugin', true, 'web-part', ['active']])

  const off = await agent.plugins('setBundle', { name: 'demo-dsh-plugin', enabled: false })
  assert.equal(off.value.application, 'applied')
  assert.ok(!(await toolsNow(agent, llm)).includes(TOOL), 'switched off while dsh runs')
  await agent.dispose()

  relaunch()
  assert.match(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), /demo-dsh-plugin/, 'the next launch keeps the user\'s plugin')
  const again = bridge() as unknown as Bridge
  await again.start()
  const [after] = pluginsView((await again.plugins('list')).value, profileDir)
  assert.equal(after.enabled, false, 'still off after a relaunch')
  assert.ok(!(await toolsNow(again, llm)).includes(TOOL))

  const removed = await again.plugins('remove', { name: 'demo-dsh-plugin' })
  assert.ok(removed.ok, removed.problem)
  assert.deepEqual(pluginsView((await again.plugins('list')).value, profileDir), [])
})

test('plugin preflight matches the live dsh version gate and allows an optional Web peer', { timeout: DSH_TIMEOUT_MS + INSTALL_TIMEOUT_MS }, async (t) => {
  const { bridge, dir, profileDir } = await startHarness(t)
  const agent = bridge()
  await agent.start()
  const fixtureManifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8')) as {
    peerDependencies: Record<string, string>
  }
  const fixture = (folder: string, fields: object) => {
    const dest = path.join(dir, folder)
    fs.cpSync(FIXTURE, dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ ...fixtureManifest, ...fields }))
    return dest
  }
  const peek = (spec: string) => specFit({ spec, pnpm: null, run: async () => assert.fail('local plugin requires no registry') })
  const incompatible = fixture('future-dsh-plugin', { engines: { dsh: '>=99' }, viva: { supports: true } })
  assert.deepEqual(await peek(incompatible), { kind: 'dsh-version', current: getDshRuntimeVersion(), requirements: { 'engines.dsh': '>=99' } })
  const inspected = await agent.plugins('inspect', { spec: incompatible })
  assert.ok(inspected.ok)
  assert.equal(inspectionView(inspected.value).ok, true)
  const refused = await agent.plugins('install', { spec: incompatible })
  assert.ok(refused.ok)
  assert.equal(changeView(refused.value).error?.code, 'incompatible-version')

  const webHost = '@deepseek-ai/dsh-host-webserver'
  const optional = fixture('optional-web-dsh-plugin', {
    peerDependencies: { ...fixtureManifest.peerDependencies, [webHost]: '*' },
    peerDependenciesMeta: { [webHost]: { optional: true } },
  })
  assert.deepEqual(await peek(optional), { kind: 'web-part' })
  const installed = await agent.plugins('install', { spec: optional })
  assert.ok(installed.ok)
  const change = changeView(installed.value)
  assert.equal(change.application, 'applied', change.error?.detail ?? undefined)
  const listed = await agent.plugins('list')
  assert.ok(listed.ok)
  const [plugin] = pluginsView(listed.value, profileDir)
  assert.equal(plugin?.name, 'demo-dsh-plugin')
  assert.deepEqual(pluginStanding(plugin), { kind: 'loaded' })
})
