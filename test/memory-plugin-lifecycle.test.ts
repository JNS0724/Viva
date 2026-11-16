import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import * as memoryPlugin from '../plugins/memory/index.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'

// Actual DSH loader/services, with no model providers, agent model selection, host IPC or network.
// This isolates plugin lifecycle acceptance from the browser/CLI surfaces tested by Web smoke.
test('standalone DSH without a model retains storage tools and unloads/reloads the owner in one process', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-plugin-lifecycle-'))
  const config = join(directory, 'cordis.yml'), root = join(directory, 'memory')
  writeFileSync(config, JSON.stringify([
    'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions', 'dsh-commands',
  ].map(name => ({ id: name, name: '@deepseek-ai/' + name }))))
  const ctx = await boot('memory-lifecycle-test', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  assert.deepEqual(ctx.llm.listProviders(), [])
  assert.deepEqual(ctx.agents.list(), [])
  const originalFetch = globalThis.fetch
  async function mount() {
    let owner: Awaited<ReturnType<typeof memoryPlugin.apply>> | undefined
    const fiber = await ctx.plugin({ ...memoryPlugin, async apply(scope: Context) {
      owner = await memoryPlugin.apply(scope, { dataRoot: root })
    } })
    assert.ok(owner, 'DSH dependencies activate the real plugin without a model provider')
    assert.equal(owner.ready(), true)
    for (const name of ['memory_remember', 'memory_recall', 'memory_forget', 'memory_clarify']) assert.ok(ctx.tools.get(name), name)
    return { fiber, owner }
  }
  const first = await mount()
  assert.notEqual(globalThis.fetch, originalFetch)
  const operationId = randomUUID()
  const entry = await first.owner.handleHost('addMemory', { args: ['每周五交周报', 'fact', operationId] }) as { id: number }
  const epoch = first.owner.epoch
  assert.throws(() => openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} }), /active owner/)
  await first.fiber.dispose()
  assert.equal(globalThis.fetch, originalFetch, 'unload removes the shared fetch interception')
  assert.equal(ctx.tools.get('memory_recall'), undefined, 'fiber-owned tools are unregistered')
  const second = await mount()
  assert.notEqual(second.owner.epoch, epoch)
  const records = await second.owner.handleHost('listMemories', { args: [] }) as { items: Array<{ id: number, text: string }> }
  assert.ok(records.items.some(item => item.id === entry.id && item.text === '每周五交周报'))
  assert.deepEqual(await second.owner.handleHost('addMemory', { args: ['每周五交周报', 'fact', operationId] }),
    await second.owner.handleHost('addMemory', { args: ['每周五交周报', 'fact', operationId] }))
  await second.fiber.dispose()
  assert.equal(globalThis.fetch, originalFetch)
  // Independent reopening proves the plugin released the OS/SQLite owner lock on both unloads.
  const reopened = openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} })
  try { await reopened.recover(); assert.equal(reopened.ready(), true) } finally { await reopened.close() }
})
