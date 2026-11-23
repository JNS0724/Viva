import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as persistence from '../plugins/memory/persistence.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { scratch } from './fixtures/scratch.js'

test('standalone session persistence starts while its incompatible memory database stays intact', async t => {
  const { dir, defer } = scratch(t, 'viva-standalone-persistence-')
  const config = { root: join(dir, 'sessions'), memoryRoot: join(dir, 'memory') }
  const owner = openMemoryOwner({ root: config.memoryRoot, route: () => null, compute: async () => '', quiesce: async () => {} })
  try { await owner.recover() } finally { await owner.close() }
  const file = join(config.memoryRoot, 'memory.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA user_version=11')
  db.close()
  const before = readFileSync(file)

  const ctx = new Context()
  const plugin = await ctx.plugin(persistence, config)
  defer(() => plugin.dispose())
  assert.ok(ctx.get('sessionPersistence'))
  assert.deepEqual(readFileSync(file), before)
})
