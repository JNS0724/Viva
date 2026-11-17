import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createMemoryDeliveryBindings } from '../plugins/memory/lib/delivery-provenance.ts'

const answer = (text: string) => [{ type: 'text' as const, text }]

test('settlement arriving before end waits for the durable generation of the actual terminal output', async () => {
  const binding = createMemoryDeliveryBindings()
  binding.start('run', 'parent', 'child', 1, 0)
  binding.step('child', 2, 1, 2, new Map([['parent', 1]]))
  let persisted!: () => void
  const durable = new Promise<void>(resolve => { persisted = resolve })
  binding.output('child', 2, 1, answer('fresh result'), durable)
  const notice = binding.settlement('child', 'parent', 'notice-digest')!
  let resolved = false
  void notice.then(() => { resolved = true })
  const ending = binding.end('run', answer('fresh result'))
  await Promise.resolve()
  assert.equal(resolved, false)
  persisted()
  assert.deepEqual(await notice, { contextGeneration: 1, senderContextGeneration: 2, contentDigest: 'notice-digest' })
  assert.deepEqual(await ending, { contextGeneration: 1, senderContextGeneration: 2 })
  binding.close()
})

test('a failed new request cannot relabel the previous terminal answer with the recovered generation', async () => {
  const binding = createMemoryDeliveryBindings()
  binding.start('run', 'parent', 'child', 0, 0)
  binding.step('child', 1, 1, 0, new Map())
  binding.output('child', 1, 1, answer('old result'), Promise.resolve())
  binding.step('child', 1, 2, 1, new Map())
  const notice = binding.settlement('child', 'parent', 'notice')!
  await binding.end('run', answer('old result'))
  assert.equal((await notice).senderContextGeneration, 0, 'owner will reject this when the child is already generation 1')
  binding.close()
})

test('equal output text across generations uses the final actual event and does not leak bindings across runs', async () => {
  const binding = createMemoryDeliveryBindings()
  binding.start('first', 'parent', 'child', 0, 0)
  binding.step('child', 1, 1, 0, new Map())
  binding.output('child', 1, 1, answer('same text'), Promise.resolve())
  binding.step('child', 2, 1, 1, new Map())
  binding.output('child', 2, 1, answer('same text'), Promise.resolve())
  assert.equal((await binding.end('first', answer('same text')))?.senderContextGeneration, 1)
  binding.start('second', 'parent', 'child', 2, 1)
  const unknown = binding.settlement('child', 'parent', 'unknown')!
  await assert.rejects(binding.end('second', answer('same text')), /exact generation receipt/)
  await assert.rejects(unknown, /exact generation receipt/)
  binding.close()
})

test('relay authority is captured by the producing root call and parent run, never the late recipient generation', () => {
  const binding = createMemoryDeliveryBindings()
  binding.start('run', 'parent', 'child', 0, 0)
  binding.step('child', 1, 1, 0, new Map([['parent', 1], ['peer', 3]]))
  binding.output('child', 1, 1, [{ type: 'tool-call', id: ToolCallId('root-call'), name: 'send_message', arguments: '{}' }], Promise.resolve())
  const origin = binding.tool('child', 'root-call')!
  assert.equal(binding.relay('child', 'parent', 'body', origin).contextGeneration, 0, 'old child run cannot acquire the recovered parent authority')
  assert.equal(binding.relay('child', 'peer', 'body', origin).contextGeneration, 3)
  assert.equal(binding.tool('child', 'unknown-call'), undefined)
  binding.release('child')
  assert.equal(binding.tool('child', 'root-call'), undefined)
  binding.close()
})

test('closing a run settles pending notices and failed persistence never authorizes output', async () => {
  const binding = createMemoryDeliveryBindings()
  binding.start('failed', 'parent', 'child', 0, 0)
  binding.step('child', 1, 1, 0, new Map())
  binding.output('child', 1, 1, answer('result'), Promise.reject(new Error('disk failed')))
  const failed = binding.settlement('child', 'parent', 'notice')!
  await assert.rejects(binding.end('failed', answer('result')), /disk failed/)
  await assert.rejects(failed, /disk failed/)
  binding.start('pending', 'parent', 'child', 0, 0)
  const pending = binding.settlement('child', 'parent', 'notice')!
  binding.close()
  await assert.rejects(pending, /bindings closed/)
})
