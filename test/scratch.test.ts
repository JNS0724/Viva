import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { createScratchRegistry } from './fixtures/scratch.ts'

test('scratch isolates case directories, closes resources in LIFO order and removes each case before its file container', async () => {
  const registry = createScratchRegistry(), hooks: Array<() => Promise<void>> = []
  const context = { filePath: '/repo/test/example.test.ts', after: (hook: () => Promise<void>) => { hooks.push(hook) } } as TestContext
  const first = registry.scratch(context, 'viva-scratch-test-'), second = registry.scratch(context, 'viva-scratch-test-')
  assert.notEqual(first.dir, second.dir)
  assert.equal(path.dirname(first.dir), path.dirname(second.dir))
  const container = path.dirname(first.dir)
  const order: string[] = []
  first.defer(() => { order.push('first-1') })
  first.defer(() => { order.push('first-2') })
  second.defer(() => { order.push('second') })
  fs.writeFileSync(path.join(first.dir, 'case.txt'), 'isolated')
  assert.equal(fs.readFileSync(path.join(first.dir, 'case.txt'), 'utf8'), 'isolated')
  assert.equal(fs.existsSync(path.join(second.dir, 'case.txt')), false)

  for (const hook of hooks) await hook()
  assert.deepEqual(order, ['first-2', 'first-1', 'second'])
  assert.equal(fs.existsSync(first.dir), false)
  assert.equal(fs.existsSync(second.dir), false)
  assert.equal(fs.existsSync(container), true)
  await registry.close()
  assert.equal(fs.existsSync(container), false)
  await registry.close()
})

test('scratch preserves an unreaped case directory instead of recursively deleting it at file cleanup', async () => {
  const registry = createScratchRegistry(), hooks: Array<() => Promise<void>> = []
  const context = { filePath: '/repo/test/diagnostic.test.ts', after: (hook: () => Promise<void>) => { hooks.push(hook) } } as TestContext
  const item = registry.scratch(context, 'viva-scratch-test-')
  const container = path.dirname(item.dir)

  await registry.close()
  assert.equal(fs.existsSync(item.dir), true)
  for (const hook of hooks) await hook()
  assert.equal(fs.existsSync(item.dir), false)
  await registry.close()
  assert.equal(fs.existsSync(container), false)
})
