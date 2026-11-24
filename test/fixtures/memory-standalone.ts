import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'

// Copied into a clean temporary project by memory-boundaries.test.ts. No Viva tree,
// DSH installation, Electron installation or parent IPC is present in that project.
const require = createRequire(import.meta.url)
for (const dependency of ['electron', '@deepseek-ai/dsh']) assert.throws(() => require.resolve(dependency))
assert.equal(process.send, undefined)
const checked = new Set<string>()
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier !== '../../shared/request-budget.ts') assert.doesNotMatch(specifier, /(?:^electron$|@deepseek-ai\/|\/backend\/|\/shared\/|\/plugins\/)/u)
  const result = next(specifier, context)
  checked.add(result.url)
  return result
} })
const { createMemoryRuntime, openMemoryStore } = await import('../../src/memory/node/index.ts')
const { createMemoryClient, createMemoryService } = await import('../../src/memory/core/client.ts')
assert.equal(typeof createMemoryClient, 'function')
assert.equal(typeof createMemoryService, 'function')
const database = join(process.cwd(), 'standalone.db')
const start = () => createMemoryRuntime({ store: openMemoryStore(database), compute: () => null,
  route: () => null, canCommit: () => true, changed: () => {} })
const writeId = randomUUID(), eraseId = randomUUID()
let memory = start()
const input = { operationId: writeId, text: 'Please keep weekly summaries concise.' }
const workspace = memory.manualFileWorkspace()
const item = await memory.writeManagedFile(writeId, workspace, input, () => {})
assert.ok(item)
assert.equal(memory.listFiles({ kind: 'digest' }).items.length, 1)
assert.deepEqual(await memory.writeManagedFile(writeId, workspace, input, () => {}), item)
memory.close()
memory = start()
const detail = memory.readFile(item.identity)
assert.ok(detail)
assert.ok(detail.markdown.includes(input.text))
await memory.forgetFile({ operationId: eraseId, identity: detail.identity, version: detail.version }, () => {})
memory.close()
memory = start()
assert.equal(memory.readFile(item.identity), null)
assert.equal(memory.listFiles({ kind: 'digest' }).items.length, 0)
memory.close()
hooks.deregister()
console.log(JSON.stringify({ standalone: true, modules: checked.size, writes: 1, durableErasure: true }))
