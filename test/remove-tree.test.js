import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTree } from '../src/main/remove-tree.js'

/** dsh keeps the pictures it stored read-only (chmod 0400); Windows refuses to remove such a file as it is. */
test('read-only files are removed too', () => {
  const tree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'remove-tree-')), 'images')
  const objects = path.join(tree, 'attachments', 'v1', 'objects', 'ab')
  fs.mkdirSync(objects, { recursive: true })
  fs.writeFileSync(path.join(objects, 'abcd'), 'picture')
  fs.chmodSync(path.join(objects, 'abcd'), 0o400)
  removeTree(tree)
  assert.equal(fs.existsSync(tree), false)
})

/** A dsh profile links the app's plugins in; removing the profile must leave the plugins alone. */
test('a tree is removed without touching what its links point at', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-tree-'))
  t.after(() => fs.rmSync(path.join(root, 'plugin'), { recursive: true, force: true }))
  const plugin = path.join(root, 'plugin')
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(plugin, 'lib', 'store.js'), 'kept')
  const tree = path.join(root, 'profile')
  fs.mkdirSync(path.join(tree, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(tree, 'package.json'), '{}')
  fs.symlinkSync(plugin, path.join(tree, 'node_modules', 'viva-memory'), process.platform === 'win32' ? 'junction' : 'dir')

  removeTree(tree)

  assert.equal(fs.existsSync(tree), false)
  assert.equal(fs.readFileSync(path.join(plugin, 'lib', 'store.js'), 'utf8'), 'kept')
})

test('a missing tree is nothing to remove', () => {
  assert.doesNotThrow(() => removeTree(path.join(os.tmpdir(), 'remove-tree-missing', 'nothing')))
})
