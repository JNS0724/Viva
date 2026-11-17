import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
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
