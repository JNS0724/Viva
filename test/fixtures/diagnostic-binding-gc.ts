import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DiagnosticFields } from '../../src/diagnostics/contracts.ts'

const root = process.argv[3] ? pathToFileURL(path.resolve(process.argv[3]) + path.sep) : new URL('../../', import.meta.url)
const node = await import(new URL('src/diagnostics/node/context.ts', root).href) as typeof import('../../src/diagnostics/node/context.ts')
const portable = await import(new URL('src/diagnostics/operation.ts', root).href) as typeof import('../../src/diagnostics/operation.ts')
const { createNodeDiagnostics } = await import(new URL('src/diagnostics/node/logger.ts', root).href) as typeof import('../../src/diagnostics/node/logger.ts')
const directory = await mkdtemp(path.join(tmpdir(), 'viva-diagnostic-binding-gc-'))
const writer = createNodeDiagnostics({ directory, component: 'backend' })
const restore = node.installDiagnosticPort(writer)
const gc = globalThis.gc
if (!gc) throw new Error('This test requires --expose-gc')
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function startNode(fields: DiagnosticFields) {
  let release!: () => void
  const business = new Promise<void>(resolve => { release = resolve })
  const pending = node.withOperation('model', () => business, fields)
  fields = {}
  return async () => { release(); await pending }
}
function startPortable(fields: DiagnosticFields) {
  const observation = portable.beginDiagnosticOperation(node.diagnosticPort, 'memory.dream', fields)
  fields = {}
  return async () => { observation.progress({ stage: 'checkpoint' }); observation.end() }
}
function startPortableAsync(fields: DiagnosticFields) {
  let release!: () => void
  const business = new Promise<void>(resolve => { release = resolve })
  const pending = portable.observeDiagnosticAsync(node.diagnosticPort, 'memory.dream', () => business, fields)
  fields = {}
  return async () => { release(); await pending }
}
function prepare(start: (fields: DiagnosticFields) => () => Promise<void>) {
  const graph = { body: 'PRIVATE_METADATA_GRAPH' }
  const weak = new WeakRef(graph)
  const fields = { identities: { resourceId: 'PRIVATE_MODEL_NAME' }, extra: graph }
  const finish = start(fields)
  return { weak, finish }
}
async function check(start: (fields: DiagnosticFields) => () => Promise<void>) {
  // Creation happens in a completed synchronous frame, outside the async function's saved registers.
  const { weak, finish } = prepare(start)
  try {
    assert.equal(writer.snapshot().stats.activeCount, 1)
    for (let attempt = 0; attempt < 20; attempt++) {
      await tick(); gc!()
      if (!weak.deref()) break
    }
    assert.equal(weak.deref(), undefined, 'pending observation must not retain the caller metadata object graph')
  } finally { await finish() }
  assert.equal(writer.snapshot().stats.activeCount, 0)
}
try {
  await writer.ready
  const mode = process.argv[2] ?? 'both'
  if (mode === 'both' || mode === 'node') await check(startNode)
  if (mode === 'both' || mode === 'portable') await check(startPortable)
  if (mode === 'both' || mode === 'async') await check(startPortableAsync)
  assert.equal(await writer.close(), true)
  const text = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.doesNotMatch(text, /PRIVATE_/)
  console.log(JSON.stringify({ mode, collected: true, activeCount: writer.snapshot().stats.activeCount }))
} finally { restore(); await writer.close(); await rm(directory, { recursive: true, force: true }) }
