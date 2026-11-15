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
  assert.doesNotMatch(specifier, /(?:^electron$|@deepseek-ai\/|\/backend\/|\/shared\/|\/plugins\/)/u)
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
  route: () => null, quiesce: async () => {}, changed: () => {} })
const writeId = randomUUID(), eraseId = randomUUID()
let memory = start()
const item = memory.addMemory('Please keep weekly summaries concise.', 'preference', writeId)
assert.ok(item)
assert.equal(memory.listMemories().total, 1)
assert.equal(memory.addMemory(item.text, 'preference', writeId)?.id, item.id)
memory.close()
memory = start()
assert.equal(memory.listMemories().items[0]?.text, item.text)
assert.equal((await memory.deleteMemory(item.id, item.revision, eraseId)).status, 'cleared')
memory.close()
memory = start()
assert.equal(memory.listMemories().total, 0)
assert.equal((await memory.deleteMemory(item.id, item.revision, eraseId)).status, 'cleared')
memory.close()
hooks.deregister()
console.log(JSON.stringify({ standalone: true, modules: checked.size, writes: 1, durableErasure: true }))
