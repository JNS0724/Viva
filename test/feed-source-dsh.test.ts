import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DSH_TIMEOUT_MS, ROOT, startHarness } from './fixtures/dsh-harness.js'
import { changeView, pluginsView } from '../src/backend/plugins-ipc.ts'

const SOURCE_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plugins', 'feed-source-plugin')
const DEMO_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plugins', 'demo-plugin')
const SOURCE_PLUGIN = 'feed-source-dsh-plugin'
const SOURCE_PROMPT = 'Check the fixture data source'
const INSTALL_TIMEOUT_MS = 5 * 60_000

type Bridge = ReturnType<Awaited<ReturnType<typeof startHarness>>['bridge']>
type Binding = Parameters<Bridge['bindFeedSourceSession']>[1]

async function install(agent: Bridge, spec: string) {
  const installed = await agent.plugins('install', { spec })
  assert.ok(installed.ok, installed.ok ? undefined : installed.problem)
  assert.equal(changeView(installed.value).application, 'applied', JSON.stringify(installed.value).slice(0, 600))
}

async function entriesOf(agent: Bridge, profileDir: string): Promise<string[]> {
  const listed = await agent.plugins('list')
  assert.ok(listed.ok, listed.ok ? undefined : listed.problem)
  const plugin = pluginsView(listed.value, profileDir).find(one => one.name === SOURCE_PLUGIN)
  assert.ok(plugin)
  return plugin.rows.flatMap(row => row.entryId ? [row.entryId] : [])
}

async function bindOnce(agent: Bridge, workspace: string, binding: Binding, prompt?: string) {
  const session = await agent.startUnattendedTask({ cwd: workspace })
  assert.ok(session.ok && session.taskId, JSON.stringify(session))
  try {
    const bound = await agent.bindFeedSourceSession(session.taskId, binding)
    if (bound.ok && prompt) await agent.promptTask(session.taskId, prompt)
    return bound
  } finally {
    await agent.closeTask(session.taskId)
  }
}

test('a data source executes only its own read-only tool with real dsh, including after a relaunch', { timeout: DSH_TIMEOUT_MS + 2 * INSTALL_TIMEOUT_MS }, async (t) => {
  let queried = false
  const { bridge, llm, relaunch, profileDir, workspace } = await startHarness(t, {
    decideFirst: (request: { messages: unknown }) => {
      if (!JSON.stringify(request.messages).includes(SOURCE_PROMPT)) return null
      if (queried) return { text: 'Done' }
      queried = true
      return { tool: { name: 'feed_fixture_read', input: {} } }
    },
  })
  const agent = bridge()
  await agent.start()

  await install(agent, SOURCE_FIXTURE)
  await install(agent, DEMO_FIXTURE)
  const ownerEntryIds = await entriesOf(agent, profileDir)
  assert.ok(ownerEntryIds.length > 0)
  const binding = { pluginName: SOURCE_PLUGIN, ownerEntryIds, allowedTools: ['feed_fixture_read'] }

  assert.deepEqual(await bindOnce(agent, workspace, binding, SOURCE_PROMPT), { ok: true })
  const requests = llm.requests.filter(request => JSON.stringify(request.messages).includes(SOURCE_PROMPT))
  assert.deepEqual(requests[0]?.tools?.map(tool => tool.name), ['feed_fixture_read'])
  assert.match(JSON.stringify(requests[1]?.messages), /fixture entries/, 'the tool actually executed')

  const foreign = await bindOnce(agent, workspace, { ...binding, allowedTools: ['demo_dsh_echo'] })
  assert.equal(foreign.ok, false)
  assert.match(foreign.reason, /归属其他插件/)

  const writer = await bindOnce(agent, workspace, { ...binding, allowedTools: ['feed_fixture_write'] })
  assert.equal(writer.ok, false)
  assert.match(writer.reason, /只读/)

  const disabled = await agent.plugins('setBundle', { name: SOURCE_PLUGIN, enabled: false })
  assert.ok(disabled.ok)
  assert.equal(changeView(disabled.value).application, 'applied')
  assert.equal((await bindOnce(agent, workspace, binding)).ok, false, 'switched off: nothing to bind')
  const enabled = await agent.plugins('setBundle', { name: SOURCE_PLUGIN, enabled: true })
  assert.ok(enabled.ok)
  assert.equal(changeView(enabled.value).application, 'applied')
  assert.deepEqual(await bindOnce(agent, workspace, binding), { ok: true })
  await agent.dispose()

  relaunch()
  const again = bridge()
  await again.start()
  const atLaunch = { ...binding, ownerEntryIds: await entriesOf(again, profileDir) }
  assert.deepEqual(await bindOnce(again, workspace, atLaunch), { ok: true })
  assert.equal((await bindOnce(again, workspace, { ...atLaunch, allowedTools: ['demo_dsh_echo'] })).ok, false)
})
