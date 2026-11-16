import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { scratch } from './fixtures/scratch.js'
import { createMemoryRuntime } from '../src/memory/core/memory-runtime.ts'
import { createMemorySendFence } from '../src/memory/core/send-fence.ts'
import { openMemoryRuntimeResources } from '../src/memory/node/runtime.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import type { MemoryDocuments } from '../src/memory/core/ports/documents.ts'

test('background document cleanup drains transport acknowledgments before recovering an unrelated prepared revision', async t => {
  const { dir, defer } = scratch(t, 'memory-document-barrier-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  const resources = openMemoryRuntimeResources({ store })
  const fence = createMemorySendFence({ epoch: 'owner', admit: () => ({ current: () => true, deadline: null }) })
  let documents!: MemoryDocuments, crash = false
  resources.openDocuments = (readable, onCommitted) => documents = openMemoryDocuments({
    db: store.db, root: store.fileRoot, onCommitted,
    source(id) {
      const source = store.readSource(id)
      return source?.text && readable(id) ? { token: memorySourceToken(source), workspace: memorySourceWorkspace(source), text: source.text } : undefined
    },
    checkpoint(point) { if (crash && point === 'intent') { crash = false; throw new Error('simulated interruption') } },
  })
  const memory = createMemoryRuntime({ store, resources, dailyNotes: true, compute: () => null, route: () => null,
    quiesce: async () => {}, changed: () => {}, canCommit: () => true, validateDispatch: () => {}, runDocumentMutation: work => fence.mutate(work) })
  defer(async () => { await fence.close(); memory.close() })
  const id = randomUUID()
  memory.accept('The report is submitted on Friday.', { session: 'session', conversation: 'conversation' }, id)
  const source = store.readSource(id)!
  const workspace = memorySourceWorkspace(source), path = 'digest/wiki/report.md'
  crash = true
  assert.throws(() => documents.commit({ operationId: 'interrupted-create', workspace, path,
    expectedRevision: null, markdown: 'Friday report', action: 'CREATE',
    sources: [{ id, token: memorySourceToken(source) }], reads: [] }), /simulated interruption/)
  const revision = memory.revision()
  const permit = fence.acquire('pending-body', { session: 'other-session' }, 'actual request payload')
  resources.effects.queue('memory.document-cleanup', 'unrelated-source', null)
  const pending = memory.wake()
  try {
    await setImmediate()
    assert.equal(permit.signal.aborted, true, 'recovery has requested cancellation but must still wait for acknowledgment')
    assert.equal(documents.read(workspace, path), null)
    assert.equal(memory.revision(), revision)
  } finally { permit.settled() }
  await pending
  assert.equal(documents.read(workspace, path)?.markdown, 'Friday report')
  assert(memory.revision() > revision)
})
