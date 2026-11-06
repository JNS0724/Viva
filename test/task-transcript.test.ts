import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answered, ended, fromSaved, said, saved, updated, type Transcript } from '../src/backend/task-transcript.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { setLocale } from '../src/shared/i18n/locale.ts'

/** What a task says, put together by the backend the way the window puts together a conversation. */

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text } })
const thought = (text: string) => ({ sessionUpdate: 'agent_thought_chunk' as const, content: { type: 'text' as const, text } })
const tool = (id: string) => ({ sessionUpdate: 'tool_call' as const, toolCallId: id, title: '运行 git log', status: 'in_progress' })
const stream = (key: string, kind: string, extra: Record<string, unknown>) => ({ sessionUpdate: 'viva_stream' as const, key, kind, ...extra })
const run = (updates: unknown[], start: Transcript = []) => updates.reduce<Transcript>((transcript, update) => updated(transcript, update), start)
const texts = (transcript: Transcript) => saved(transcript).map((m) => `${m.role}:${m.text}`)

test('text adds to what the agent is writing; a thought or a tool call starts the next answer apart', () => {
  const transcript = run([chunk('先看'), chunk('提交…'), thought('想一想'), chunk('三组改动。'), tool('t1'), chunk('写好了。')], said([], '整理发布说明'))
  assert.deepEqual(texts(transcript), ['user:整理发布说明', 'assistant:先看提交…', 'assistant:三组改动。', 'assistant:写好了。'])
  assert.equal(run([{ sessionUpdate: 'usage_update', used: 1 }, null, chunk('')], []).length, 0, 'what says nothing adds nothing')
})

test('a stream builds its message by blocks; settled, its blocks replace them, and an empty one goes', () => {
  const live = run([
    stream('k1', 'delta', { index: 0, blockType: 'text' as const, text: '先' }),
    stream('k1', 'delta', { index: 0, blockType: 'text' as const, text: '看' }),
    stream('k1', 'block', { index: 1, blockType: 'text' as const, text: '提交' }),
    stream('k1', 'delta', { index: 0, blockType: 'reasoning', text: '不算' }),
  ])
  assert.deepEqual(texts(live), ['assistant:先看提交'])
  const settled = updated(live, stream('k1', 'settle', { blocks: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '最终答案' }] }))
  assert.deepEqual(texts(settled), ['assistant:最终答案'])
  assert.equal(settled[0].open, undefined, 'settled, it is closed')
  assert.deepEqual(updated(live, stream('k1', 'settle', { blocks: [] })), [], 'a retried attempt that settles empty leaves nothing')
})

test('a turn that says nothing leaves a note, stopped or not; one that answered does not', () => {
  setLocale('zh-CN')
  assert.deepEqual(texts(ended(said([], '查天气'), 'cancelled')), ['user:查天气', 'note:已停止本轮任务。'])
  assert.deepEqual(texts(ended(said([], '查天气'), 'end_turn')), ['user:查天气', 'note:本轮没有文字回复。'])
  const answeredTurn = ended(run([chunk('晴')], said([], '查天气')), 'end_turn')
  assert.deepEqual(texts(answeredTurn), ['user:查天气', 'assistant:晴'])
  assert.equal(answeredTurn.at(-1)?.open, false)
})

test('an answer to the agent\'s questions reads as the window words it', () => {
  setLocale('zh-CN')
  const questions = [{ id: 'city', question: '哪个城市？', header: '城市' }, { id: 'days', question: '看几天？' }]
  const reply = answered([], questions, [{ id: 'city', selected: ['上海'] }, { id: 'days', selected: [] }])
  assert.deepEqual(texts(reply), ['user:城市：上海\n看几天？：（跳过）'])
})

test('the backend\'s messages match what the window shows for the same updates', () => {
  const updates = [chunk('先看'), tool('t1'), chunk('三组改动。'), thought('嗯'), chunk('写好了。')]
  const window = updates.reduce((state, update, i) => reduce(state, { type: 'acp_update', update, at: i }),
    reduce(initialState, { type: 'user_prompt', text: '整理发布说明', at: 0 }))
  const shown = reduce(window, { type: 'turn_end', stopReason: 'end_turn', at: 9 }).messages.map((m: ThreadMessage) => `${m.role}:${m.text}`)
  assert.deepEqual(texts(ended(run(updates, said([], '整理发布说明')), 'end_turn')), shown)
})

test('what the history kept comes back as it was, leaving out what is not a message', () => {
  const back = fromSaved([{ role: 'user', text: '查天气' }, { role: 'assistant', text: '晴' }, { role: 'tool', text: 'x' }, { role: 'user' }])
  assert.deepEqual(texts(back), ['user:查天气', 'assistant:晴'])
  assert.deepEqual(texts(said(back, '后天呢')), ['user:查天气', 'assistant:晴', 'user:后天呢'])
})
