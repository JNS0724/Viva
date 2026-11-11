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

test('background activity and recent steps do not invalidate the title-bar head', () => {
  const view = { ...asking, form: 'working', recent: [{ title: 'First step', tone: 'live' }],
    background: { count: 1, items: [{ id: 'task', title: 'Task', status: 'running', now: 'Read' }] } }
  const changed = { ...view, recent: [{ title: 'Second step', tone: 'live' }],
    background: { ...view.background, items: [{ ...view.background.items[0], now: 'Write' }] } }
  assert.equal(islandSignatures(view, true, false).row, islandSignatures(changed, true, false).row)
  assert.notEqual(islandSignatures(view, true, false).panel, islandSignatures(changed, true, false).panel)
  assert.notEqual(islandSignatures(view, true, false).row,
    islandSignatures({ ...view, background: { ...view.background, count: 2 } }, true, false).row)
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

test('the desktop portrait says the state by ring and sign; resting as the cat alone it keeps what it rests on', async () => {
  const { deskSignal, DESK_SIGNS, wearsSign } = await import('../src/renderer/view/island-dom.ts')
  const signal = (form: string, tone = 'idle') => deskSignal({ form, tone })
  assert.deepEqual(['working', 'waiting', 'asking', 'done', 'error', 'pending'].map((form) => signal(form)),
    ['working', 'confirm', 'asking', 'done', 'error', 'offline'])
  assert.deepEqual([signal('mini'), signal('mini', 'done'), signal('mini', 'working'), signal('mini', 'error')], ['rest', 'done', 'working', 'error'],
    'a turn done and not yet seen is still that once the island folds to the cat')
  assert.deepEqual(['input', 'coach', 'resolved', 'drop', 'background'].map((form) => signal(form, 'done')), Array(5).fill('plain'), 'the island\'s own forms are drawn as before')
  assert.deepEqual([DESK_SIGNS.confirm, DESK_SIGNS.asking, DESK_SIGNS.done, DESK_SIGNS.error, DESK_SIGNS.working], ['!', '?', '✓', '×', undefined])
  assert.deepEqual([wearsSign('done', true), wearsSign('done', false), wearsSign('offline', true), wearsSign('working', true), wearsSign('rest', true)],
    [true, false, false, false, false], 'worn only with the portrait alone, and not where the ring says it already')
})
