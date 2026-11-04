import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DSH_TIMEOUT_MS, ROOT, startHarness } from './fixtures/dsh-harness.js'
import { pluginsView } from '../src/backend/plugins-ipc.ts'

/**
 * The plugins page against the real dsh: a plugin shaped like a community one (a bundle, one host tool, a Web
 * client part) installed through the app's channel and dsh's own plugin manager, with the pnpm the app ships.
 */
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plugins', 'demo-plugin')
const TOOL = 'demo_dsh_echo'
const INSTALL_TIMEOUT_MS = 5 * 60_000

type Bridge = { start: () => Promise<unknown>, newSession: () => Promise<unknown>, prompt: (text: string) => Promise<unknown>, dispose: () => Promise<unknown>, plugins: (op: string, args?: Record<string, unknown>) => Promise<{ ok: boolean, value?: any, problem?: string }> }

/** The tools the model is offered in a new conversation now. */
async function toolsNow(agent: Bridge, llm: { requests: Array<{ tools?: Array<{ name: string }> }> }): Promise<string[]> {
  await agent.newSession()
  await agent.prompt('你好')
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
  assert.ok((await toolsNow(agent, llm)).includes('viva_followup_propose'), 'the app\'s own plugins still load')

  const listed = await agent.plugins('list')
  const [plugin, ...others] = pluginsView(listed.value, profileDir)
  assert.equal(others.length, 0)
  assert.deepEqual([plugin.name, plugin.enabled, plugin.webUi, plugin.rows.map((row) => row.phase)], ['demo-dsh-plugin', true, true, ['active']])

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
