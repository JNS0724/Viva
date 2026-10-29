import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { accessDecision } from '../plugins/permission/access.ts'

test('workspace read consent uses real paths, rejects prefix siblings and traversal, and asks before commands', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viva-read-consent-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'workspace')
  const sibling = path.join(dir, 'workspace-other')
  await fs.mkdir(cwd)
  await fs.mkdir(sibling)
  await fs.writeFile(path.join(cwd, '正常中文.txt'), 'inside')
  await fs.writeFile(path.join(sibling, 'outside.txt'), 'outside')
  const canonicalize = async (file: string, base: string) => fs.realpath(path.resolve(base, file))
  const decide = (name: string, args: unknown, preset = 'workspace-write') => accessDecision({ name, args, preset, cwd, canonicalize })
  assert.equal(await decide('read', { file_path: '正常中文.txt' }), null)
  assert.equal((await decide('read', { file_path: '../workspace-other/outside.txt' }))?.kind, 'ask')
  assert.equal((await decide('read_image', { file_path: path.join(sibling, 'outside.txt') }))?.kind, 'ask')
  assert.equal((await decide('grep', { path: sibling }))?.kind, 'ask')
  assert.equal(await decide('glob', { pattern: '*.txt' }), null)
  assert.equal((await decide('read', { file_path: 23 }))?.kind, 'deny')
  assert.equal((await decide('read', { file_path: 'missing' }))?.kind, 'deny')
  assert.equal((await decide('pwsh', { command: 'Get-Content ../workspace-other/outside.txt' }))?.kind, 'ask')
  assert.equal((await decide('bash', { command: 'cat /etc/hosts' }, 'read-only'))?.kind, 'ask')
  assert.equal(await decide('read', { file_path: sibling }, 'danger-full-access'), null)
  assert.equal(await decide('pwsh', {}, 'auto'), null)
  assert.equal(await decide('memory_recall', { query: '城市' }), null)
  try {
    await fs.symlink(sibling, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    // A denied link setup is not evidence that link containment passed.
    t.diagnostic(`link setup unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  assert.equal((await decide('read', { file_path: 'link/outside.txt' }))?.kind, 'ask')
})
