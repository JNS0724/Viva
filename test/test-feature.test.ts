import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverTests, selectTests } from '../scripts/test-feature.ts'

test('discovery finds nested JS and TS tests without running type fixtures or following links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viva test discovery '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of ['test/a.test.js', 'test/nested/b.test.ts', 'test/contract.types.ts', 'test/a.spec.ts', 'test/node_modules/hidden.test.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), '')
  }
  // A directory junction needs no Windows symlink privilege and exercises the same Dirent exclusion.
  fs.symlinkSync(path.join(root, 'test'), path.join(root, 'test', 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(discoverTests(root), [path.join('test', 'a.test.js'), path.join('test', 'nested', 'b.test.ts')])
})

test('multiple groups deduplicate files, keep shared boundary checks and reject unknown or empty selections', () => {
  const files = ['test/conversation-actions.test.ts', 'test/acp-operations.test.ts', 'test/task-load.test.ts', 'test/ipc-contract.test.js', 'test/window-api.test.ts', 'test/markdown.test.js']
  const selected = selectTests(files, ['conversation', 'runtime', 'conversation'])
  assert.deepEqual(selected, [files[1], files[0], files[3], files[4]])
  assert.throws(() => selectTests(files, []), /at least one/)
  assert.throws(() => selectTests(files, ['conversaton']), /Unknown feature/)
  assert.throws(() => selectTests([], ['tasks']), /No tests/)
  assert.throws(() => selectTests(files, ['conversation', '--arbitrary-node-flag']), /Unknown feature/)
})
