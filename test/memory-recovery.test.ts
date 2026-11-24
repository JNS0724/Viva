import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveMemoryProject } from '../src/memory/node/project-scope.ts'
import { scratch } from './fixtures/scratch.js'

test('personal workspaces and unresolved project directories have different scope states', t => {
  const { dir } = scratch(t, 'viva-memory-scope-state-')
  const cwd = join(dir, 'work')
  mkdirSync(cwd)
  assert.deepEqual(resolveMemoryProject(null), { status: 'user' })
  assert.deepEqual(resolveMemoryProject(undefined), { status: 'unknown' })
  assert.deepEqual(resolveMemoryProject(join(dir, 'missing')), { status: 'unknown' })
  assert.deepEqual(resolveMemoryProject(cwd), { status: 'user' })
  const marker = join(cwd, '.git')
  writeFileSync(marker, 'gitdir: missing\n')
  assert.deepEqual(resolveMemoryProject(cwd), { status: 'unknown' })
  mkdirSync(join(cwd, 'git-data', 'objects'), { recursive: true })
  writeFileSync(join(cwd, 'git-data', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(marker, 'gitdir: git-data\n')
  assert.equal(resolveMemoryProject(cwd).status, 'project')
})
