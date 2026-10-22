import test from 'node:test'
import assert from 'node:assert/strict'
import { islandSignatures, OFFER_MS, offersBackground } from '../src/renderer/view/island-dom.ts'

const asking = Object.freeze({
  form: 'asking', tone: 'waiting', mood: 'ask', label: '等你回答', recent: [],
  question: { questionId: 'q1', id: 'city', text: '你想看哪个城市的天气？', options: ['上海', '北京'] },
})

test('the pointer coming to rest redraws the row, not the panel, so a button held meanwhile stays pressed', () => {
  const passing = islandSignatures(asking, true, false)
  const resting = islandSignatures(asking, true, true)
  assert.notEqual(resting.row, passing.row)
  assert.equal(resting.panel, passing.panel)
})

test('a turn that has run a while is offered the background, and the panel redraws to offer it', () => {
  const working = { form: 'working', tone: 'working', mood: 'typing', label: '工作中', recent: [], startedAt: 1000, movable: true }
  assert.equal(offersBackground(working, 1000 + OFFER_MS - 1), false)
  assert.equal(offersBackground(working, 1000 + OFFER_MS), true)
  assert.equal(offersBackground({ ...working, movable: undefined }, 1000 + OFFER_MS), false, 'not when there is nothing to move')
  assert.equal(offersBackground({ ...working, form: 'waiting' }, 1000 + OFFER_MS), false)
  assert.equal(offersBackground({ ...working, offered: true }, 1001), true, 'at once, when the agent said it will take long')
  assert.notEqual(islandSignatures(working, true, false, true).panel, islandSignatures(working, true, false, false).panel)
})

test('a new question or the island folding redraws the panel', () => {
  const shown = islandSignatures(asking, true, true)
  const next = { ...asking, question: { ...asking.question, questionId: 'q2' } }
  assert.notEqual(islandSignatures(next, true, true).panel, shown.panel)
  assert.notEqual(islandSignatures(asking, false, true).panel, shown.panel)
})
