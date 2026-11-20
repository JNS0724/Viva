import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { completeMemoryModel } from '../plugins/memory/lib/model.ts'
import { assertMemoryProviderSupported } from '../plugins/memory/lib/providers.ts'
import { MemoryComputeError } from '../src/memory/contracts/compute.ts'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'

const job: MemoryCompute = { id: '1', sourceId: '2', generation: 1, stage: 'note', provider: 'test', model: 'model', system: 'system', input: 'source' }

for (const finish of ['stop', 'max-tokens', 'missing', 'timeout', 'context-window-exceeded', 'auth', 'rate-limit'] as const) test(`memory model requires explicit successful completion: ${finish}`, async () => {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  class Adapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'partial or complete' }
      if (finish === 'timeout' || finish === 'context-window-exceeded' || finish === 'auth' || finish === 'rate-limit') {
        const code = { timeout: 'TIMEOUT', 'context-window-exceeded': 'CONTEXT_WINDOW_EXCEEDED', auth: 'AUTH', 'rate-limit': 'RATE_LIMIT' }[finish]
        yield { type: 'finish', reason: { kind: 'error', failure: { code, message: 'Provider failure' } } }
      } else if (finish !== 'missing') yield { type: 'finish', reason: { kind: finish } }
    }
  }
  const dispose = llm.registerAdapter(['test'], new Adapter())
  try {
    const result = completeMemoryModel(ctx, job, new AbortController().signal)
    if (finish === 'stop') assert.equal(await result, 'partial or complete')
    else {
      const expected = finish === 'missing' ? 'missing-finish' : finish === 'auth' || finish === 'rate-limit' ? 'error' : finish
      await assert.rejects(result, error => error instanceof MemoryComputeError && error.reason === expected)
    }
  } finally { dispose() }
})


test('an unknown custom transport is rejected before invoking its adapter or network', async () => {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  let entered = false
  class UnknownAdapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> { entered = true; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  const dispose = llm.registerAdapter(['custom-unknown'], new UnknownAdapter())
  ctx.on('llm/stream', async function* (options, next) { assertMemoryProviderSupported(llm, options.provider); yield* next() })
  try {
    await assert.rejects(completeMemoryModel(ctx, { ...job, provider: 'custom-unknown' }, new AbortController().signal), /request barrier/)
    assert.equal(entered, false)
  } finally { dispose() }
})


test('cancelling a partial computation never returns its delivered prefix', async () => {
  const ctx = new Context(), llm = new LlmRuntime(ctx), cancelled = new AbortController()
  class Adapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'partial fact' }
      cancelled.abort()
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const dispose = llm.registerAdapter(['test'], new Adapter())
  try { await assert.rejects(completeMemoryModel(ctx, job, cancelled.signal), error => error instanceof Error && error.name === 'AbortError') }
  finally { dispose() }
})

for (const stage of ['question', 'note'] as const) test(`large reply bounds follow computation purpose: ${stage}`, async () => {
  const ctx = new Context(), llm = new LlmRuntime(ctx), text = 'a'.repeat(20_001)
  class Adapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const dispose = llm.registerAdapter(['test'], new Adapter())
  try {
    const result = completeMemoryModel(ctx, { ...job, stage }, new AbortController().signal)
    if (stage === 'note') assert.equal(await result, text)
    else await assert.rejects(result, error => error instanceof MemoryComputeError && error.reason === 'oversize-reply')
  } finally { dispose() }
})
