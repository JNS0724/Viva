import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'
import { MEMORY_EMBEDDING_DIMENSIONS } from '../src/memory/node/memory-embedder.ts'
import { embeddingFixture } from './fixtures/memory-embedding-assets.ts'

test('local worker keeps each prefix and rejects overlong rows without losing the rest of the batch', async t => {
  const { embedder } = await embeddingFixture(t)
  assert.equal(embedder.dimensions, MEMORY_EMBEDDING_DIMENSIONS)
  const result = await embedder.embedBatch([{ kind: 'query', text: 'look up a fact' },
    { kind: 'passage', text: 'too long to embed completely' }, { kind: 'passage', text: 'available fact' }])
  assert.ok(result)
  assert.equal(result.length, 3)
  assert.equal(result[0]?.length, MEMORY_EMBEDDING_DIMENSIONS)
  assert.equal(result[0]?.[0], 1)
  assert.equal(result[1], null)
  assert.equal(result[2]?.length, MEMORY_EMBEDDING_DIMENSIONS)
  assert.equal(result[2]?.[1], 1)
})

test('closing a failed local worker leaves the caller alive and further requests fall back', async t => {
  const { embedder } = await embeddingFixture(t)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'stop worker' }]), null)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'fall back during the cooldown' }]), null)
  embedder.close()
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'closed' }]), null)
})

test('aborting a pending embedding retires that worker and lets a new request run', async t => {
  const { embedder } = await embeddingFixture(t)
  const controller = new AbortController()
  const pending = embedder.embedBatch([{ kind: 'query', text: 'hang worker' }], controller.signal)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'busy' }]), null)
  controller.abort()
  assert.equal(await pending, null)
  const result = await embedder.embedBatch([{ kind: 'query', text: 'retry after abort' }])
  assert.equal(result?.[0]?.[0], 1)
})

test('worker load and inference emit bounded metadata while malformed diagnostic replies cannot retire valid business work', async t => {
  const events: DiagnosticEvent[] = []
  const restore = installDiagnosticPort({ emit(event) { events.push(event); return undefined } })
  t.after(restore)
  const { embedder } = await embeddingFixture(t, { behavior: 'diagnostic-noise' })
  const vectors = await embedder.embedBatch([{ kind: 'query', text: 'SECRET_EMBEDDING_QUERY' }])
  assert.equal(vectors?.[0]?.[0], 1)
  assert.ok(events.some(event => event.operation === 'embedding' && event.stage === 'connecting'))
  assert.ok(events.some(event => event.operation === 'embedding' && event.stage === 'ready'))
  assert.ok(events.some(event => event.operation === 'embedding' && event.stage === 'vector'))
  assert.equal(events.filter(event => event.event === 'context.dropped').length, 1)
  assert.doesNotMatch(JSON.stringify(events), /SECRET_EMBEDDING_QUERY|SECRET_DIAGNOSTIC_INPUT/)
  restore()
  const broken = installDiagnosticPort({ emit() { throw new Error('diagnostic observer failed') } })
  try { assert.equal((await embedder.embedBatch([{ kind: 'query', text: 'still succeeds' }]))?.[0]?.[0], 1) }
  finally { broken() }
})

test('the actual embedding worker ignores an invalid diagnostic envelope while retaining its authenticated result identity', async t => {
  const { modelRoot, runtimeRoot, descriptor } = await embeddingFixture(t)
  const worker = fork(fileURLToPath(new URL('../src/memory/node/memory-embedder-worker.ts', import.meta.url)), [modelRoot, runtimeRoot], {
    execPath: process.execPath, execArgv: [], env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
  })
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, 'exit'); worker.kill(); await exited } })
  const messages: Record<string, unknown>[] = []
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker result deadline')), 3000)
    worker.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
      const message = raw as Record<string, unknown>
      messages.push(message)
      if (message.type === 'result') { clearTimeout(timer); resolve(message) }
    })
    worker.once('error', error => { clearTimeout(timer); reject(error) })
  })
  worker.send({ id: 7, inputs: [{ kind: 'query', text: 'secret query' }], fingerprint: descriptor.fingerprint,
    dimensions: descriptor.manifest.dimensions, diagnostics: { version: 999, secret: 'SECRET_DIAGNOSTIC_INPUT' } })
  const completed = await result
  assert.equal(completed.fingerprint, descriptor.fingerprint)
  assert.equal(completed.dimensions, descriptor.manifest.dimensions)
  assert.equal((completed.rows as number[][])[0]?.[0], 1)
  assert.ok(messages.some(message => message.type === 'ready'))
  assert.doesNotMatch(JSON.stringify(messages), /SECRET_DIAGNOSTIC_INPUT|secret query/)
})
