import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LONG_ANSWER_CHARS, answerStart } from '../src/renderer/long-answer.ts'

/** A very long answer shows its start at first: cut where a paragraph ends, never inside a code block. */

test('the start of a long answer ends with a paragraph, within the limit', () => {
  const paragraph = '这是一段说明，写清楚了背景和结论。'.repeat(20)
  const text = Array.from({ length: 200 }, () => paragraph).join('\n\n')
  const start = answerStart(text)
  assert.ok(start.length <= LONG_ANSWER_CHARS)
  assert.ok(start.length > LONG_ANSWER_CHARS / 2)
  assert.ok(text.startsWith(start) && text.slice(start.length).startsWith('\n\n'), 'cut where a paragraph ends')
})

test('a cut that would fall inside a code block ends before the block', () => {
  const code = ['```ts', ...Array.from({ length: 2000 }, (_, i) => `const line${i} = ${i}`), '```'].join('\n')
  const text = `开头一段。\n\n${code}\n\n结尾。`
  const start = answerStart(text)
  assert.equal((start.match(/^```/gm) ?? []).length % 2, 0)
  assert.ok(!start.includes('const line0'))
})
