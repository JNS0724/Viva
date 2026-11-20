import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { DEFAULT_TOOL_TIMEOUT_MS } from '../src/shared/request-budget.ts'
import { acquireSessionRootLease } from '../plugins/memory/lib/native/session-root-lease.ts'
import { Context } from '@deepseek-ai/cordis'
import * as persistence from '../plugins/memory/persistence.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { scratch } from './fixtures/scratch.js'

const roots = (dir: string): persistence.Config => ({
  root: join(dir, 'sessions'), memoryRoot: join(dir, 'memory'), storageRoot: join(dir, 'storages'),
})

function signal() {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release }
}

test('standalone session ownership lasts until persistence consumers finish disposing', { timeout: 5_000 }, async t => {
  const { dir, defer } = scratch(t, 'viva-standalone-persistence-')
  const config = roots(dir), ctx = new Context()
  const first = await ctx.plugin(persistence, config)
  defer(() => first.dispose())
  assert.ok(ctx.get('sessionPersistence'))
  const detaching = signal(), released = signal()
  const consumer = await ctx.plugin({
    inject: ['sessionPersistence'],
    apply(scope: Context) {
      scope.effect(() => async () => {
        detaching.release()
        await released.ready
      })
    },
  })
  defer(() => consumer.dispose())

  const stopped = first.dispose()
  try {
    await detaching.ready
    const competing = new Context(), blocked = competing.plugin(persistence, config)
    defer(() => blocked.dispose())
    await assert.rejects(blocked.await(), /already has an active owner/u)
    assert.equal(competing.get('sessionPersistence'), undefined)
  } finally { released.release() }
  await stopped
  assert.equal(ctx.get('sessionPersistence'), undefined)

  const successor = new Context(), second = await successor.plugin(persistence, config)
  defer(() => second.dispose())
  assert.ok(successor.get('sessionPersistence'))
})

test('standalone cold startup never publishes a provider with the wrong memory owner binding', async t => {
  const { dir, defer } = scratch(t, 'viva-standalone-persistence-binding-')
  const config = roots(dir)
  const owner = openMemoryOwner({ root: config.memoryRoot, hostNamespace: 'viva',
    compute: () => null, route: () => null, quiesce: async () => {} })
  try { await owner.recover() } finally { await owner.close() }

  const ctx = new Context(), invalid = ctx.plugin(persistence, config)
  defer(() => invalid.dispose())
  await assert.rejects(invalid.await(), /Native cleanup owner binding differs/u)
  assert.equal(ctx.get('sessionPersistence'), undefined, 'consumers cannot open native sessions after failed maintenance')

  const next = new Context(), valid = await next.plugin(persistence, { ...config, memoryRoot: join(dir, 'other-memory') })
  defer(() => valid.dispose())
  assert.ok(next.get('sessionPersistence'), 'failed activation released its session lifecycle lease')
})

test('standalone disposal can finish while a stuck lease still excludes a second owner', async t => {
  const { dir } = scratch(t, 'viva-stalled-root-lease-')
  const config = { sessionsRoot: join(dir, 'sessions'), memoryRoot: join(dir, 'memory'), storageRoot: join(dir, 'storage') }
  const lease = acquireSessionRootLease(config, () => assert.fail('closing is intentional'))
  await lease.ready
  // Keep the real lock held while simulating a worker which cannot accept a message or terminate yet.
  const stopped = signal()
  let thread: Worker | undefined
  const post = t.mock.method(Worker.prototype, 'postMessage', () => {})
  const terminate = t.mock.method(Worker.prototype, 'terminate', function(this: Worker) {
    thread = this
    return stopped.ready.then(() => 0)
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const closing = lease.close()
    t.mock.timers.tick(DEFAULT_TOOL_TIMEOUT_MS)
    await closing
    assert.ok(thread)
    const competing = acquireSessionRootLease(config, () => {})
    await assert.rejects(competing.ready, /active owner/)
    await competing.close()
  } finally {
    t.mock.timers.reset()
    post.mock.restore()
    terminate.mock.restore()
    stopped.release()
    if (thread) await thread.terminate()
    else await lease.close()
  }
  const next = acquireSessionRootLease(config, () => {})
  await next.ready
  await next.close()
})
