import test from 'node:test'
import assert from 'node:assert/strict'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import type { RawIpc } from '../src/shared/ipc-contract.ts'
import { registerDiagnosticIpc } from '../src/shell/diagnostics-ipc.ts'
import { diagnosticContext, installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import { observeDshDiagnostics } from '../plugins/memory/lib/diagnostics.ts'
import type { Context } from '@deepseek-ai/cordis'

function setup() {
  const listeners = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const raw = {
    handle: (channel: string, listener: Parameters<RawIpc['handle']>[1]) => { listeners.set(channel, listener) },
    on: (channel: string, listener: Parameters<RawIpc['on']>[1]) => { listeners.set(channel, listener) },
  }
  const calls: Array<{ channel: string, args: readonly unknown[], context: ReturnType<typeof diagnosticContext> }> = []
  const failure = new Error('original business error')
  const diagnostics = registerDiagnosticIpc(checkedIpc(raw), {
    renderer: { emit() { throw new Error('broken sink') } },
    forwarded: () => new Set(['memory:get', 'agent:prompt']),
    invoke: async (channel, args) => { calls.push({ channel, args, context: diagnosticContext() }); if (args[0] === 'fail') throw failure; return { ok: true } },
    exportBundle: async () => ({ status: 'cancelled' }), openFolder: () => undefined, status: () => ({ state: 'unavailable' }),
  })
  return { calls, failure, diagnostics, send: (channel: string, ...args: unknown[]) => listeners.get(channel)!({}, ...args) }
}

test('diagnostic envelopes retain the business decoder and never require valid optional context', async t => {
  t.after(installDiagnosticPort({ emit() { throw new Error('broken sink') } }))
  const h = setup()
  const context = { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
  for (const diagnostics of [undefined, null, { version: 999 }, { ...context, extra: 'SECRET' }, context]) {
    const args: unknown[] = []
    assert.deepEqual(await h.send('diagnostics:invoke', { channel: 'memory:get', args, diagnostics }), { ok: true })
    assert.equal(h.calls.at(-1)!.args, args)
  }
  assert.equal(h.calls.at(-1)!.context?.traceId, context.traceId)
  assert.equal(h.calls.at(-1)!.context?.spanId, context.spanId, 'the actual RPC client owns the next child span')
  await assert.rejects(Promise.resolve(h.send('diagnostics:invoke', { channel: 'agent:prompt', args: [42] })), /invalid agent:prompt/)
  await assert.rejects(Promise.resolve(h.send('diagnostics:invoke', { channel: 'diagnostics:export', args: [] })), /not forwarded/)
  assert.equal(h.calls.length, 5)
  await assert.rejects(Promise.resolve(h.send('diagnostics:invoke', { channel: 'agent:prompt', args: ['fail'] })), error => error === h.failure)
})

test('renderer diagnostic floods and sink errors do not throttle business requests or native export', async () => {
  const h = setup()
  for (let i = 0; i < 100; i++) h.send('diagnostics:event', { event: 'operation.start', operation: 'memory.get' })
  assert.ok(h.diagnostics.droppedCount() >= 90)
  assert.deepEqual(await h.send('diagnostics:invoke', { channel: 'memory:get', args: [] }), { ok: true })
  assert.deepEqual(await h.send('diagnostics:export'), { status: 'cancelled' })
  assert.equal(h.calls.length, 1)
})

test('DSH observation metadata failures cannot skip or repeat a real tool call', async () => {
  type Listener = (...args: unknown[]) => unknown
  const listeners = new Map<string, Listener>()
  let exported: ((message: unknown) => void) | undefined
  const ctx = { logger: { exporter(config: { export(message: unknown): void }) { exported = config.export } },
    on(name: string, listener: Listener) { listeners.set(name, listener) },
  } as unknown as Context
  observeDshDiagnostics(ctx)
  const malformed = Object.defineProperty({}, 'callId', { get() { throw new Error('diagnostic metadata failed') } })
  let runs = 0
  assert.equal(await listeners.get('tools/execute')!(malformed, () => { runs++; return Promise.resolve(42) }), 42)
  assert.equal(runs, 1)
  const failure = new Error('original tool failure')
  assert.throws(() => listeners.get('tools/execute')!(malformed, () => { throw failure }), value => value === failure)
  assert.doesNotThrow(() => listeners.get('tools/result')!(malformed, {}))
  assert.doesNotThrow(() => listeners.get('agent/error')!({ agent: undefined }))
  assert.doesNotThrow(() => exported?.({}))
  assert.doesNotThrow(() => observeDshDiagnostics({ get logger() { throw new Error('logger unavailable') } } as unknown as Context))
})
