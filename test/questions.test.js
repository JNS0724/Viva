import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkAnswers, createQuestionDesk, parseQuestion } from '../src/main/question-channel.js'
import { answersFrom, answerText } from '../src/renderer/question-state.js'
import { statusView, traceItems } from '../src/renderer/selectors.js'
import { initialState, isBusy, reduce } from '../src/renderer/state.js'

/** The app's side of the agent's questions: what the main process lets through, and how the window keeps them. */

const CITY = { id: 'city', question: '你想看哪个城市的天气？', header: '城市', options: [{ label: '上海' }, { label: '北京' }] }
const DAYS = { id: 'days', question: '看几天？', options: [{ label: '1 天' }, { label: '3 天' }], multiSelect: true }

test('a question from dsh is checked: ids, text, options; anything off is dropped', () => {
  assert.deepEqual(parseQuestion({ id: 'q1', questions: [CITY] }), {
    id: 'q1', questions: [{ ...CITY, multiSelect: false }],
  })
  assert.equal(parseQuestion({ id: 'q1', questions: [] }), null, 'nothing asked')
  assert.equal(parseQuestion({ id: 'q1', questions: [{ id: 'a' }] }), null, 'no question text')
  assert.equal(parseQuestion({ id: 'q1', questions: [CITY, CITY] }), null, 'the same id twice')
  assert.equal(parseQuestion({ id: 'q1', questions: [{ ...CITY, options: [{ label: '上海' }, { label: '上海' }] }] }), null, 'the same option twice')
  assert.equal(parseQuestion({ id: 'q1', questions: [{ ...CITY, options: [{ label: 42 }] }] }), null, 'an option without a label')
})

test('an answer from the window has to fit the questions asked', () => {
  const questions = parseQuestion({ id: 'q1', questions: [CITY, DAYS] }).questions
  assert.deepEqual(checkAnswers(questions, [{ id: 'city', selected: ['上海'] }, { id: 'days', selected: ['1 天', '3 天'], custom: ' 周末也看 ' }]), [
    { id: 'city', selected: ['上海'] }, { id: 'days', selected: ['1 天', '3 天'], custom: '周末也看' },
  ])
  assert.throws(() => checkAnswers(questions, [{ id: 'city', selected: ['上海'] }]), /对不上/)
  assert.throws(() => checkAnswers(questions, [{ id: 'city', selected: ['广州'] }, { id: 'days', selected: [] }]), /选项无效/)
  assert.throws(() => checkAnswers(questions, [{ id: 'city', selected: ['上海', '北京'] }, { id: 'days', selected: [] }]), /只能选一项/)
})

test('the desk shows questions of the conversation on screen, declines the others, and answers once', () => {
  const sent = []
  const shown = []
  let session = 's1'
  const desk = createQuestionDesk({ send: (m) => sent.push(m), emit: (e) => shown.push(e), sessionId: () => session })

  desk.receive({ type: 'question', id: 'q1', sessionId: 's1', questions: [CITY] })
  desk.receive({ type: 'question', id: 'q2', sessionId: 'old', questions: [CITY] })
  assert.deepEqual(shown.map((e) => [e.type, e.questionId]), [['question', 'q1']])
  assert.deepEqual(sent, [{ type: 'decline', id: 'q2' }])

  assert.equal(desk.answer('q1', [{ id: 'city', selected: ['北京'] }]), true)
  assert.deepEqual(sent.at(-1), { type: 'answer', id: 'q1', answers: [{ id: 'city', selected: ['北京'] }] })
  assert.equal(desk.answer('q1', [{ id: 'city', selected: ['北京'] }]), false, 'answered already')

  desk.receive({ type: 'question', id: 'q3', sessionId: 's1', questions: [CITY] })
  desk.receive({ type: 'question_closed', id: 'q3' })
  assert.deepEqual(shown.at(-1), { type: 'question_closed', questionId: 'q3' })
  desk.receive({ type: 'question', id: 'q4', sessionId: 's1', questions: [CITY] })
  session = 's2'
  desk.declineAll()
  assert.deepEqual(sent.at(-1), { type: 'decline', id: 'q4' })
  assert.deepEqual(shown.at(-1), { type: 'question_closed', questionId: 'q4' })
})

const asking = (questions = [CITY]) => reduce(reduce(initialState, { type: 'user_prompt', text: '明天天气', at: 1 }), {
  type: 'question_request', questionId: 'q1', questions: questions.map((q) => ({ multiSelect: false, header: '', ...q })), at: 2,
})

test('a question pauses the turn; the answer joins the thread under what was asked', () => {
  const state = asking()
  assert.equal(state.phase, 'asking')
  assert.equal(isBusy(state), true)
  assert.deepEqual(statusView(state), { tone: 'waiting', label: '需要你回答', event: '你想看哪个城市的天气？' })

  const answered = reduce(state, { type: 'question_answered', questionId: 'q1', answers: [{ id: 'city', selected: ['上海'] }], at: 3 })
  assert.equal(answered.phase, 'working')
  assert.equal(answered.question, null)
  assert.deepEqual(answered.messages.at(-1), { id: 'm1', role: 'user', text: '上海', asked: '你想看哪个城市的天气？', open: false, receipt: null })
  assert.deepEqual(traceItems(answered).map((item) => [item.title, item.detail]), [['向你提问', '你想看哪个城市的天气？'], ['你的回答', '上海']])
  assert.equal(reduce(answered, { type: 'question_answered', questionId: 'q1', answers: [], at: 4 }), answered, 'a second answer is ignored')
})

test('picks toggle (one or several), and typed words answer the first question left open', () => {
  let state = asking([CITY, DAYS])
  state = reduce(state, { type: 'question_pick', id: 'city', label: '上海' })
  state = reduce(state, { type: 'question_pick', id: 'city', label: '北京' })
  state = reduce(state, { type: 'question_pick', id: 'days', label: '1 天' })
  state = reduce(state, { type: 'question_pick', id: 'days', label: '3 天' })
  state = reduce(state, { type: 'question_pick', id: 'days', label: '1 天' })
  assert.deepEqual(state.question.picks, { city: ['北京'], days: ['3 天'] })
  assert.deepEqual(answersFrom(state.question, '  顺便看空气  '), [{ id: 'city', selected: ['北京'] }, { id: 'days', selected: ['3 天'], custom: '顺便看空气' }])

  const open = asking([CITY, DAYS]).question
  assert.deepEqual(answersFrom(open, '杭州'), [{ id: 'city', selected: [], custom: '杭州' }, { id: 'days', selected: [] }])
  assert.equal(answerText(open.questions, [{ id: 'city', selected: ['上海'] }, { id: 'days', selected: [] }]), '城市：上海\n看几天？：（跳过）')
})

test('a question closed before an answer (stopped, switched away) leaves no card; turn end and errors clear it too', () => {
  const closed = reduce(asking(), { type: 'question_closed', questionId: 'q1', at: 3 })
  assert.equal(closed.question, null)
  assert.equal(closed.phase, 'working')
  assert.equal(traceItems(closed).at(-1).title, '问题未回答')
  assert.equal(reduce(asking(), { type: 'turn_end', stopReason: 'cancelled', at: 3 }).question, null)
  assert.equal(reduce(asking(), { type: 'error', message: 'x' }).question, null)
})
