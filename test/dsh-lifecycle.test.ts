import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDshLifecycle, type DshLifetime } from '../src/backend/dsh-lifecycle.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
type Context = { sessionId: string }
type Info = { sessionId: string }
type Fake = { id: number, lifetime: DshLifetime, dispose: () => Promise<void>, disposed: number }

function harness() {
  let time = 0
  const instances: Fake[] = [], order: string[] = [], ready: Info[] = [], connections: number[] = []
  const timers: Array<{ at: number, run: () => void, cancelled: boolean }> = []
  const crashes: Array<{ message: string, delay: number | null }> = [], errors: unknown[] = []
  let gone = 0
  let connection: Promise<Info> | null = null, disposal: Promise<void> | null = null
  let createError: Error | null = null
  let afterCreate = () => {}
  const lifecycle = createDshLifecycle({
    create: (_context: Context, lifetime): Fake => {
      if (createError) throw createError
      const gate = disposal
      const fake: Fake = { id: instances.length + 1, lifetime, disposed: 0,
        dispose: async () => { fake.disposed++; order.push(`dispose:${fake.id}`); await gate; order.push(`released:${fake.id}`) } }
      instances.push(fake); order.push(`create:${fake.id}`)
      afterCreate()
      return fake
    },
    connect: (instance, context) => { connections.push(instance.id); return connection ?? Promise.resolve({ sessionId: context.sessionId }) },
    onReady: info => { ready.push(info) },
    onGone: () => { gone++ },
    onCrash: (exit, delay) => { crashes.push({ message: exit.message, delay }) },
    restart: async (): Promise<unknown> => lifecycle.start({ sessionId: 'resumed' }),
    onRestartError: error => { errors.push(error) },
    now: () => time,
    schedule: (run, ms) => {
      const timer = { at: time + ms, run, cancelled: false }; timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  const advance = async (ms: number) => {
    time += ms
    for (const timer of timers.filter(t => !t.cancelled && t.at <= time)) { timer.cancelled = true; timer.run() }
    await flush()
  }
  return { lifecycle, instances, timers, crashes, errors, order, ready, connections, advance, gone: () => gone,
    connecting: (value: Promise<Info> | null) => { connection = value },
    disposing: (value: Promise<void> | null) => { disposal = value },
    failCreate: (value: Error | null) => { createError = value },
    afterCreate: (run: () => void) => { afterCreate = run } }
}

test('concurrent starts share one connection and the current instance', async () => {
  const h = harness(), gate = deferred<Info>(); h.connecting(gate.promise)
  const first = h.lifecycle.start({ sessionId: 'one' }), second = h.lifecycle.start({ sessionId: 'two' })
  assert.equal(first, second)
  await flush(); assert.equal(h.instances.length, 1)
  assert.equal(h.lifecycle.current, h.instances[0])
  gate.resolve({ sessionId: 'one' })
  assert.deepEqual(await first, { sessionId: 'one' })
  assert.deepEqual(await h.lifecycle.start({ sessionId: 'ignored' }), { sessionId: 'one' })
  assert.equal(h.instances.length, 1)
  assert.equal(h.ready.length, 1, 'one connection publishes readiness only once')
  await h.lifecycle.stop()
})

test('stopping during startup cancels its result and ignores late events and exits', async () => {
  const h = harness(), gate = deferred<Info>(); h.connecting(gate.promise)
  const published: Info[] = []
  const starting = h.lifecycle.start({ sessionId: 'old' }).then(info => { if (info) published.push(info); return info })
  await flush(); const old = h.instances[0]
  await h.lifecycle.stop()
  assert.equal(await starting, null)
  assert.equal(old.lifetime.isCurrent(), false)
  old.lifetime.onExit({ message: 'late exit' }); gate.resolve({ sessionId: 'late' })
  await flush()
  assert.deepEqual(published, []); assert.deepEqual(h.crashes, [])
  assert.deepEqual(h.ready, [])
  assert.equal(old.disposed, 1); assert.equal(h.gone(), 1)
})

test('a retired generation cannot affect the replacement', async () => {
  const h = harness()
  await h.lifecycle.start({ sessionId: 'old' }); const old = h.instances[0]
  await h.lifecycle.stop(); await h.lifecycle.start({ sessionId: 'new' })
  old.lifetime.onExit({ message: 'stale' })
  assert.equal(old.lifetime.isCurrent(), false)
  assert.equal(h.instances[1].lifetime.isCurrent(), true)
  assert.equal(h.lifecycle.current, h.instances[1]); assert.deepEqual(h.crashes, [])
  await h.lifecycle.stop()
})

test('replacement waits for disposal, and concurrent stops dispose only once', async () => {
  const h = harness(), release = deferred<void>(); h.disposing(release.promise)
  await h.lifecycle.start({ sessionId: 'old' })
  const stopped = h.lifecycle.stop(), again = h.lifecycle.stop()
  assert.equal(stopped, again)
  h.disposing(null)
  const next = h.lifecycle.start({ sessionId: 'new' })
  await flush(); assert.equal(h.instances.length, 1)
  release.resolve(); await stopped; await next
  assert.deepEqual(h.order.slice(0, 4), ['create:1', 'dispose:1', 'released:1', 'create:2'])
  assert.equal(h.instances[0].disposed, 1)
  await h.lifecycle.stop()
})

test('crashes retry after 1, 3 and 10 seconds, then stop retrying', async () => {
  const h = harness(); await h.lifecycle.start({ sessionId: 'initial' })
  for (const delay of [1_000, 3_000, 10_000]) {
    h.lifecycle.current!.lifetime.onExit({ message: 'crashed' })
    assert.equal(h.lifecycle.current, null)
    const count = h.instances.length
    await h.advance(delay - 1); assert.equal(h.instances.length, count)
    await h.advance(1); assert.equal(h.instances.length, count + 1)
  }
  h.lifecycle.current!.lifetime.onExit({ message: 'fourth' }); await h.advance(60_000)
  assert.deepEqual(h.crashes.map(c => c.delay), [1_000, 3_000, 10_000, null])
  assert.equal(h.instances.length, 4); assert.equal(h.gone(), 4)
  await h.lifecycle.stop()
})

test('spaced crashes use the existing restart window rather than accumulating forever', async () => {
  const h = harness(); await h.lifecycle.start({ sessionId: 'one' })
  h.lifecycle.current!.lifetime.onExit({ message: 'one' }); await h.advance(1_000)
  await h.advance(120_000)
  h.lifecycle.current!.lifetime.onExit({ message: 'two' })
  assert.deepEqual(h.crashes.map(c => c.delay), [1_000, 1_000])
  await h.lifecycle.stop()
})

test('stop revokes scheduled restart even if the cancelled timer still fires', async () => {
  const h = harness(); await h.lifecycle.start({ sessionId: 'one' })
  h.lifecycle.current!.lifetime.onExit({ message: 'one' })
  const timer = h.timers[0]
  await h.lifecycle.stop(); timer.run(); await h.advance(30_000)
  assert.equal(h.instances.length, 1)
})

test('quitting during startup never publishes readiness or starts a replacement', async () => {
  const h = harness(), gate = deferred<Info>(); h.connecting(gate.promise)
  const starting = h.lifecycle.start({ sessionId: 'old' }); await flush()
  h.lifecycle.markQuitting()
  assert.equal(h.lifecycle.isQuitting(), true)
  assert.equal(await starting, null)
  assert.equal(await h.lifecycle.start({ sessionId: 'new' }), null)
  gate.resolve({ sessionId: 'late' }); await flush()
  await h.lifecycle.stop(); await h.advance(30_000)
  assert.equal(h.instances.length, 1); assert.equal(h.instances[0].disposed, 1)
  assert.deepEqual(h.ready, [])
})

test('failed initialization releases its instance before another attempt', async () => {
  const h = harness(), gate = deferred<Info>(); h.connecting(gate.promise)
  const failed = h.lifecycle.start({ sessionId: 'bad' }); await flush()
  gate.reject(new Error('initialization failed'))
  await assert.rejects(failed, /initialization failed/)
  assert.equal(h.lifecycle.current, null); assert.equal(h.instances[0].disposed, 1)
  h.connecting(null); await h.lifecycle.start({ sessionId: 'good' })
  assert.equal(h.instances.length, 2)
  await h.lifecycle.stop()
})

test('a crash during initialization retires that startup and resumes through a fresh instance', async () => {
  const h = harness(), gate = deferred<Info>(); h.connecting(gate.promise)
  const starting = h.lifecycle.start({ sessionId: 'old' }); await flush()
  h.instances[0].lifetime.onExit({ message: 'died while connecting' })
  assert.equal(await starting, null)
  h.connecting(null); await h.advance(1_000)
  gate.resolve({ sessionId: 'stale' }); await flush()
  assert.deepEqual(h.ready, [{ sessionId: 'resumed' }])
  assert.equal(h.instances[0].disposed, 1)
  await h.lifecycle.stop()
})

test('stop between creation and connection never starts a disposed process', async () => {
  const h = harness()
  h.afterCreate(() => queueMicrotask(() => { void h.lifecycle.stop() }))
  assert.equal(await h.lifecycle.start({ sessionId: 'cancelled' }), null)
  await flush()
  assert.deepEqual(h.connections, []); assert.deepEqual(h.ready, [])
  assert.equal(h.instances[0].disposed, 1)
})

test('a startup waiting for old release can be cancelled before creating anything', async () => {
  const h = harness(), release = deferred<void>(); h.disposing(release.promise)
  await h.lifecycle.start({ sessionId: 'old' })
  const stopped = h.lifecycle.stop()
  const queued = h.lifecycle.start({ sessionId: 'cancelled' })
  const stoppedAgain = h.lifecycle.stop()
  release.resolve(); await stopped; await stoppedAgain
  assert.equal(await queued, null)
  assert.equal(h.instances.length, 1)
})

test('a factory failure does not leave startup latched', async () => {
  const h = harness(); h.failCreate(new Error('bad profile'))
  await assert.rejects(h.lifecycle.start({ sessionId: 'bad' }), /bad profile/)
  h.failCreate(null); assert.deepEqual(await h.lifecycle.start({ sessionId: 'good' }), { sessionId: 'good' })
  await h.lifecycle.stop()
})

test('an unconfirmed release prevents another instance from taking its resources', async () => {
  const h = harness(), gate = deferred<void>(); h.disposing(gate.promise)
  await h.lifecycle.start({ sessionId: 'one' })
  const stopping = h.lifecycle.stop(); await flush()
  gate.reject(new Error('release unconfirmed'))
  await assert.rejects(stopping, /release unconfirmed/)
  await assert.rejects(h.lifecycle.start({ sessionId: 'two' }), /release unconfirmed/)
  assert.equal(h.instances.length, 1)
})

test('bounded shutdown returns on its deadline while later starts still await real release', async () => {
  const h = harness(), gate = deferred<void>(); h.disposing(gate.promise)
  await h.lifecycle.start({ sessionId: 'one' })
  const stopped = h.lifecycle.stopWithin(5_000)
  await h.advance(5_000); await stopped
  h.disposing(null); const next = h.lifecycle.start({ sessionId: 'two' })
  await flush(); assert.equal(h.instances.length, 1)
  gate.resolve(); await next; assert.equal(h.instances.length, 2)
  await h.lifecycle.stop()
})
