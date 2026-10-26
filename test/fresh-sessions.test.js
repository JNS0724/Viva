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
  pool.dispose(); await Promise.resolve()
  assert.deepEqual(closed, [3, 4])
  pool.prepare('ignored', '/a'); assert.equal(count, 4)
})

test('a failed speculative initialization is retried by an explicit request', async () => {
  let count = 0
  const pool = createFreshSessions({ open: async () => { if (++count === 1) throw Error('offline'); return 'fresh' }, close: async () => {} })
  pool.prepare('k', '/a')
  assert.equal(await pool.take('k', '/a'), 'fresh')
  assert.equal(count, 2)
})
