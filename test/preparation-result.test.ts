import test from 'node:test'
import assert from 'node:assert/strict'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { preparationText } from '../plugins/followups/lib/result.ts'
import { prepareRequest } from '../plugins/followups/lib/channel.ts'

function assembled(text: string, finish: 'stop' | 'max-tokens') {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
  assembler.push({ type: 'reasoning-delta', index: 0, text: 'private reasoning, never returned as the answer' })
  if (text) {
    assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 1, text })
  }
  assembler.push({ type: 'finish', reason: { kind: finish } })
  return assembler
}

test('reasoning can exhaust the output budget without producing an answer', () => {
  assert.throws(() => preparationText(assembled('', 'max-tokens')), /输出正文前已用完/)
})

test('a completion-required call rejects truncated JSON; the legacy helper can still expose partial text', () => {
  const partial = assembled('{"items":[]}', 'max-tokens')
  assert.throws(() => preparationText(partial, true), /保留待重试/)
  assert.equal(preparationText(partial), '{"items":[]}', 'the optional legacy helper retains its partial-text behavior')
  assert.equal(preparationText(assembled('正文', 'stop'), true), '正文', 'reasoning never becomes answer text')
})

test('the app to plugin request preserves the complete-judgment requirement and rejects malformed flags', () => {
  const request = { type: 'prepare', id: 'judge-1', provider: 'p', model: 'm', system: 'judge', input: 'mail', maxTokens: 4000, requireComplete: true }
  assert.equal(prepareRequest(request)?.requireComplete, true)
  assert.equal(prepareRequest({ ...request, requireComplete: 'false' }), null)
  assert.equal(prepareRequest({ ...request, requireComplete: undefined })?.requireComplete, undefined)
})
