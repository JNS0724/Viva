import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFreshSessions } from '../src/main/fresh-sessions.ts'

test('prepared sessions are bounded and consumed once; a changed MCP fingerprint or directory discards the spare', async () => {
  let count = 0; const closed = []
  const pool = createFreshSessions({ open: async cwd => ({ id: ++count, cwd }), close: async s => { closed.push(s.id) } })
  pool.prepare('mcp1', '/a'); pool.prepare('mcp1', '/a')
  assert.equal(count, 1)
  assert.equal((await pool.take('mcp1', '/a')).id, 1)
  assert.equal((await pool.take('mcp1', '/a')).id, 2, 'no two topics share an agent')
  pool.prepare('mcp1', '/a'); pool.prepare('mcp2', '/b')
  await Promise.resolve()
  assert.deepEqual(closed, [3])
  await new Promise(resolve => setImmediate(resolve))
  pool.dispose(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(closed, [3, 4])
  pool.prepare('ignored', '/a'); assert.equal(count, 4)
})

test('an incompatible MCP fingerprint is probed once until explicitly reset', async () => {
  let attempts = 0
  const pool = createFreshSessions({ open: async (_cwd, speculative) => {
    attempts++
    if (speculative) throw Error('singleton')
    return 'requested'
  }, close: async () => {} })
  pool.prepare('same', '/a'); await new Promise(resolve => setImmediate(resolve))
  pool.prepare('same', '/a'); pool.prepare('same', '/a')
  assert.equal(attempts, 1)
  assert.equal(await pool.take('same', '/a'), 'requested')
  pool.reset(); pool.prepare('same', '/a')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(attempts, 3)
  pool.dispose()
})

test('a cold fallback waits for old resources; a prepared session bypasses that barrier', async () => {
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let count = 0
  const pool = createFreshSessions({ open: async () => ++count, close: async () => {} })
  pool.prepare('same', '/a')
  assert.equal(await pool.take('same', '/a', { beforeOpen: () => barrier }), 1)
  const cold = pool.take('same', '/a', { beforeOpen: () => barrier })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(count, 1)
  release()
  assert.equal(await cold, 2)
  pool.dispose()
})

test('unused ready sessions expire and a changed configuration waits for stale disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let count = 0, release
  const closed = []
  const pool = createFreshSessions({ ttlMs: 100, open: async () => ++count, close: async id => {
    closed.push(id)
    await new Promise(resolve => { release = resolve })
  } })
  pool.prepare('old', '/a'); await Promise.resolve()
  t.mock.timers.tick(100); await Promise.resolve()
  assert.deepEqual(closed, [1])
  pool.prepare('new', '/b')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(count, 1, 'do not start a replacement while an old MCP still holds its lock')
  release(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(await pool.take('new', '/b'), 2)
  pool.dispose()
})

test('a failed speculative initialization is retried by an explicit request', async () => {
  let count = 0
  const purposes = []
  const pool = createFreshSessions({ open: async (_cwd, speculative) => { purposes.push(speculative); if (++count === 1) throw Error('offline'); return 'fresh' }, close: async () => {} })
  pool.prepare('k', '/a')
  assert.equal(await pool.take('k', '/a'), 'fresh')
  assert.equal(count, 2)
  assert.deepEqual(purposes, [true, false])
})

for (const prepared of [true, false]) test(`disposal reclaims a late ${prepared ? 'prepared' : 'cold'} session instead of returning it`, async () => {
  let finish
  const closed = []
  const pool = createFreshSessions({ open: () => new Promise(resolve => { finish = resolve }), close: async value => { closed.push(value) } })
  if (prepared) pool.prepare('same', '/a')
  const taken = pool.take('same', '/a')
  const rejected = assert.rejects(taken, /disposed/)
  await new Promise(resolve => setImmediate(resolve))
  pool.dispose()
  finish('late')
  await rejected
  assert.deepEqual(closed, ['late'])
})

test('a discarded spare whose close failed is retried before starting replacement MCPs', async () => {
  let creates = 0, closes = 0
  const pool = createFreshSessions({ open: async () => ++creates, close: async () => { if (++closes === 1) throw Error('temporary') } })
  pool.prepare('old', '/a'); await Promise.resolve()
  pool.clear(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(await pool.take('new', '/b'), 2)
  assert.equal(closes, 2)
  pool.dispose()
})
