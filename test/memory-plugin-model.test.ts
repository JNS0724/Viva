import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { completeMemoryModel } from '../plugins/memory/lib/model.ts'
import { assertMemoryProviderSupported } from '../plugins/memory/lib/providers.ts'
import { MemoryComputeError } from '../src/memory/contracts/compute.ts'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'
import { DREAM_INTEGRATE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { createVenueModelFixture, venue } from './fixtures/memory-plugin-venue.ts'

const job: MemoryCompute = { id: '1', sourceId: '2', generation: 1, stage: 'note', provider: 'test', model: 'model', system: 'system', input: 'source' }

for (const failed of ['frontmatter_read', 'frontmatter_update'] as const) {
  test(`packed Web acceptance cannot report a rejected ${failed} as exercised successfully`, () => {
    const fixture = createVenueModelFixture(), path = 'daily/2026-11-17/venue.md'
    const request = { system: DREAM_INTEGRATE_SYSTEM, messages: [{ role: 'user', content: [
      { type: 'text', text: JSON.stringify({ unit: { name: venue.archive, paths: [path] } }) },
    ] }] as Array<{ role: string, content: Array<{ type: string, text?: string, id?: string, name?: string, tool_use_id?: string, content?: string, is_error?: boolean }> }> }
    let rejected = false
    for (let index = 0; index < 6; index++) {
      const response = fixture.decide(request) as { tool: { name: string, input: { path?: string } } }
      assert.ok(response.tool)
      const { name, input } = response.tool, id = `venue-call-${index}`
      request.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name }] })
      const content = name === 'node_search' ? [] : name === 'read' ? { path, markdown: venue.facts.join('\n') }
        : name === 'frontmatter_read' ? { path, metadata: { name: venue.topic } } : { path: input.path, staged: true }
      request.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
        is_error: name === failed, content: name === failed ? 'memory-dream-tool-rejected' : JSON.stringify(content) }] })
      if (name === failed) {
        assert.throws(() => fixture.decide(request), new RegExp(`${name} execution failed`, 'u'))
        assert.ok(!fixture.report().tools.includes(name))
        rejected = true
        break
      }
    }
    assert.equal(rejected, true)
  })
}

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

test('dream tools preserve native reasoning and call identity and isolate each job', async () => {
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const ctx = new Context(), llm = new LlmRuntime(ctx)
  let sends = 0, reads = 0
  class Adapter extends LlmAdapter {
    async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<StreamChunk> {
      sends++
      if (options.messages.length === 1) {
        assert.equal(options.tools?.[0]?.name, 'read')
        yield { type: 'reasoning-delta', index: 0, text: 'inspect existing node first' }
        yield { type: 'tool-call-delta', index: 1, id: ToolCallId('call-1'), name: 'read', argumentsDelta: '{"path":"digest/wiki/a.md"}' }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        assert.equal(reads, 1)
        assert.equal(options.messages.length, 3)
        assert.equal(options.messages[1]?.role, 'assistant')
        assert.ok(options.messages[1]?.content.some(block => block.type === 'reasoning' && block.text === 'inspect existing node first'))
        const result = options.messages[2]!
        assert.equal(result.role, 'tool')
        assert.equal(result.role === 'tool' && result.toolCallId, 'call-1')
        yield { type: 'text-delta', index: 0, text: 'complete' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const dispose = llm.registerAdapter(['test'], new Adapter())
  const capability = {
    tools: [{ name: 'read', description: 'Read document', schema: { type: 'object' } }],
    executeTool: async (input: import('../src/memory/contracts/service.ts').MemoryToolInvocation) => {
      reads++
      assert.deepEqual(input.input, { path: 'digest/wiki/a.md' })
      return { callId: input.callId, state: 'completed' as const, content: 'verified content', sources: [] }
    },
  }
  try {
    assert.equal(await completeMemoryModel(ctx, { ...job, stage: 'dream' }, new AbortController().signal, capability), 'complete')
    reads = 0
    assert.equal(await completeMemoryModel(ctx, { ...job, id: 'next', stage: 'dream' }, new AbortController().signal, capability), 'complete')
    assert.equal(sends, 4)
  } finally { dispose() }
})

test('a repeated provider call ID never executes a second mutation in the same dream job', async () => {
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const ctx = new Context(), llm = new LlmRuntime(ctx)
  let executed = 0
  class Adapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('reused'), name: 'write', argumentsDelta: '{}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const dispose = llm.registerAdapter(['test'], new Adapter())
  try {
    await assert.rejects(completeMemoryModel(ctx, { ...job, stage: 'dream' }, new AbortController().signal, {
      tools: [{ name: 'write', description: 'Write draft', schema: { type: 'object' } }],
      executeTool: async input => { executed++; return { callId: input.callId, state: 'completed', content: 'saved draft', sources: [] } },
    }), error => error instanceof MemoryComputeError && error.reason === 'call-failed')
    assert.equal(executed, 1)
  } finally { dispose() }
})
