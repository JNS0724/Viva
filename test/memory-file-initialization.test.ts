import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { scratch } from './fixtures/scratch.js'

const execute = promisify(execFile)

test('a fresh nested memory directory opens and reopens within a bounded child process', async t => {
  const { dir } = scratch(t, 'viva-memory-initialization-')
  const root = join(dir, '新建目录', 'nested directory', 'memory-files')
  const entry = fileURLToPath(new URL('./fixtures/memory-fresh-store.ts', import.meta.url))
  // A Windows mkdir return value may use the extended path namespace. A broken
  // ancestor walk can spin forever, so keep that failure inside a bounded child.
  const result = await execute(process.execPath, [entry, root], {
    timeout: 5_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  assert.deepEqual(JSON.parse(result.stdout), { path: 'digest/wiki/first.md', markdown: 'Fresh memory directory.' })
})
