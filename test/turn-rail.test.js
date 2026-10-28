import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeTurn, turnPreview } from '../src/renderer/view/turn-rail.ts'

const turnAt = (tops, line) => activeTurn(tops.length, (index) => tops[index], line)

test('the turn being read is the last question that has reached the reading line', () => {
  const tops = [0, 400, 900, 1500]
  assert.equal(turnAt(tops, 0), 0)
  assert.equal(turnAt(tops, 399), 0)
  assert.equal(turnAt(tops, 400), 1)
  assert.equal(turnAt(tops, 1200), 2)
  assert.equal(turnAt(tops, 9000), 3)
})

test('above the first question, the first turn is the one being read', () => {
  assert.equal(turnAt([300, 800], 10), 0)
})

test('no questions, no turn', () => {
  assert.equal(turnAt([], 100), -1)
})

test('a long conversation reads only a few question positions to find the turn', () => {
  const tops = Array.from({ length: 1000 }, (_, i) => i * 300)
  let reads = 0
  const turn = activeTurn(tops.length, (index) => { reads += 1; return tops[index] }, 123_456)
  assert.equal(turn, 411)
  assert.ok(reads <= 11, `read ${reads} positions`)
})

test('a preview is the question on one line, cut short with an ellipsis', () => {
  assert.equal(turnPreview('  帮我\n整理一下   这周的进展 '), '帮我 整理一下 这周的进展')
  const long = '问'.repeat(80)
  const preview = turnPreview(long)
  assert.equal(preview.length, 61)
  assert.ok(preview.endsWith('…'))
})

test('a question of only pictures or files still gets a preview', () => {
  assert.equal(turnPreview('   '), '（图片或文件）')
})
