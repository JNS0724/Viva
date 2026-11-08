import test from 'node:test'
import assert from 'node:assert/strict'
import { deskLayoutFor, islandSignatures } from '../src/renderer/view/island-dom.ts'

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

test('a new question or the island folding redraws the panel', () => {
  const shown = islandSignatures(asking, true, true)
  const next = { ...asking, question: { ...asking.question, questionId: 'q2' } }
  assert.notEqual(islandSignatures(next, true, true).panel, shown.panel)
  assert.notEqual(islandSignatures(asking, false, true).panel, shown.panel)
})

test('desktop layout separates the resting portrait, status, input and content', () => {
  const mini = { form: 'mini', tone: 'idle', mood: 'idle', label: '', recent: [] }
  assert.equal(deskLayoutFor(mini, false, false), 'rest')
  assert.equal(deskLayoutFor(mini, false, true), 'rest', 'hover never changes the layout')
  assert.equal(deskLayoutFor({ ...mini, dragging: true }, false, false), 'rest')
  assert.equal(deskLayoutFor({ ...mini, background: { count: 2 } }, false, false), 'capsule')
  assert.equal(deskLayoutFor(asking, true, false), 'content')
  const input = { ...mini, form: 'input', files: [], images: [] }
  assert.equal(deskLayoutFor(input, true, false), 'input')
  assert.equal(deskLayoutFor({ ...input, files: [{ name: 'old.pdf', path: '/old.pdf', size: 1 }] }, true, false), 'input')
  assert.equal(deskLayoutFor({ ...input, images: [{ id: 'image', size: 1 }] }, true, false), 'input')
  assert.equal(deskLayoutFor({ ...mini, form: 'drop' }, true, false), 'content')
})
