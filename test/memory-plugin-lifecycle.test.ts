import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import * as memoryPlugin from '../plugins/memory/index.ts'
import type { MemoryFileMutationResult } from '../src/memory/contracts/file-management.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { memoryRecoveryCandidates, memorySessionSurfaceHash, planMemoryContextRecovery } from '../plugins/memory/lib/context-recovery.ts'

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
    for (const name of ['memory_remember', 'memory_recall', 'memory_read', 'memory_node_search', 'memory_clarify']) assert.ok(ctx.tools.get(name), name)
    assert.equal(ctx.tools.get('memory_forget'), undefined)
    return { fiber, owner }
  }
  const first = await mount()
  assert.notEqual(globalThis.fetch, originalFetch)
  const operationId = randomUUID()
  const input = { operationId, text: '每周五交周报。' }
  const entry = await first.owner.handleHost('createFile', { args: [input] }) as MemoryFileMutationResult
  const epoch = first.owner.epoch
  assert.throws(() => openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} }), /active owner/)
  await first.fiber.dispose()
  assert.equal(globalThis.fetch, originalFetch, 'unload removes the shared fetch interception')
  assert.equal(ctx.tools.get('memory_recall'), undefined, 'fiber-owned tools are unregistered')
  const second = await mount()
  assert.notEqual(second.owner.epoch, epoch)
  assert.ok(second.owner.runtime.readFile(entry.identity)?.markdown.includes(input.text))
  assert.deepEqual(await second.owner.handleHost('createFile', { args: [input] }), entry)
  await second.fiber.dispose()
  assert.equal(globalThis.fetch, originalFetch)
  // Independent reopening proves the plugin released the OS/SQLite owner lock on both unloads.
  const reopened = openMemoryOwner({ root, compute: () => null, route: () => null, quiesce: async () => {} })
  try { await reopened.recover(); assert.equal(reopened.ready(), true) } finally { await reopened.close() }
})

test('real adapter reload recovers loaded pending contexts and isolates an unflushable session', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-plugin-recovery-startup-'))
  const config = join(directory, 'cordis.yml'), root = join(directory, 'memory')
  writeFileSync(config, JSON.stringify([
    'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions', 'dsh-commands',
  ].map(name => ({ id: name, name: '@deepseek-ai/' + name }))))
  const ctx = await boot('memory-recovery-startup-test', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  let broken: string | undefined
  ctx.on('session/flush', session => {
    if (session.id === broken) throw new Error('simulated session persistence failure')
    writeFileSync(join(directory, String(session.id) + '.json'), JSON.stringify(session.snapshotEvents()))
  })
  const healthy = ctx.sessions.create(SessionId('healthy'))
  const prepared = ctx.sessions.create(SessionId('prepared'))
  const invalidated = ctx.sessions.create(SessionId('invalidated-file'))
  const bad = ctx.sessions.create(SessionId('unflushable'))
  for (const session of [healthy, prepared, invalidated, bad]) {
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'An independent original request.' }] }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ source: { kind: 'viva-memory' }, content: [{ type: 'text', text: 'Old generated context to retire.' }] }), { surfaceOp: 'append' })
  }
  async function mount() {
    let owner: Awaited<ReturnType<typeof memoryPlugin.apply>> | undefined
    const fiber = await ctx.plugin({ ...memoryPlugin, async apply(scope: Context) {
      owner = await memoryPlugin.apply(scope, { dataRoot: root, dailyNotes: false })
    } })
    assert.ok(owner)
    return { fiber, owner }
  }
  const first = await mount()
  first.owner.dispatch.recordFiles(String(invalidated.id), [{ workspace: 'a'.repeat(64), id: 'no-longer-available', path: 'memory/removed.md',
    revision: 'old-file-revision', usageVersion: 1, policyToken: 'old-policy' }])
  for (const session of [healthy, prepared, bad]) {
    const ticket = await first.owner.prepareContextRecovery({ sessionId: String(session.id), baseSurfaceHash: memorySessionSurfaceHash(session),
      candidates: memoryRecoveryCandidates(session).map(item => ({ messageId: item.messageId, content: item.text, contentDigest: item.contentDigest })) })
    if (session !== prepared) {
      const plan = planMemoryContextRecovery(session, ticket.ticketId, ticket.retainedMessageIds)
      first.owner.bindContextRecovery({ ticketId: ticket.ticketId, replacementMessageId: String(plan.message.id), replacementHash: plan.replacementHash })
    }
  }
  await first.fiber.dispose()
  broken = String(bad.id)
  const restarted = await mount()
  assert.equal(restarted.owner.ready(), true, 'one failed session must not prevent the plugin from becoming available')
  assert.equal(restarted.owner.contextGeneration(String(healthy.id)), 1)
  assert.equal(restarted.owner.contextGeneration(String(prepared.id)), 1)
  assert.equal(restarted.owner.contextGeneration(String(invalidated.id)), 1, 'stale file receipts trigger recovery before old derived history is replayed')
  assert.doesNotMatch(JSON.stringify(healthy.deriveMessages()), /Old generated context/)
  assert.match(JSON.stringify(healthy.snapshotEvents()), /Old generated context/)
  const permit = restarted.owner.acquireSend('healthy-after-reload', { session: String(healthy.id), contextGeneration: 1 }, 'reconstructed'); permit.settled()
  assert.equal(restarted.owner.contextGeneration(String(bad.id)), 0)
  assert.throws(() => restarted.owner.acquireSend('unflushed-after-reload', { session: String(bad.id), contextGeneration: 0 }, 'old'), /generation/)
  await restarted.fiber.dispose()
})
