import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, isBusy, isRevealing, reduce, revealStep } from '../src/renderer/state.js'

const T0 = 1_000_000

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }
  return value
}

const run = (actions, start = initialState) => actions.reduce((state, action) => reduce(deepFreeze(state), action), start)
const chunk = (sessionUpdate, text) => ({ type: 'acp_update', at: T0 + 10, update: { sessionUpdate, content: { type: 'text', text } } })
const tool = (sessionUpdate, fields) => ({ type: 'acp_update', at: T0 + 20, update: { sessionUpdate, ...fields } })
const prompt = { type: 'user_prompt', text: '整理文件', at: T0 }

test('user prompt appends a user message and enters working', () => {
  // Act
  const state = run([prompt])

  // Assert
  assert.equal(state.phase, 'working')
  assert.deepEqual(state.messages.map((m) => [m.role, m.text]), [['user', '整理文件']])
  assert.deepEqual(state.turn, { startedAt: T0, tools: 0, thoughts: 0 })
  assert.equal(isBusy(state), true)
})

test('streamed message chunks concatenate into one assistant message', () => {
  const state = run([prompt, chunk('agent_message_chunk', '你好'), chunk('agent_message_chunk', '，世界')])

  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[1].text, '你好，世界')
  assert.equal(state.messages[1].open, true)
})

test('thoughts go to the timeline, never into messages', () => {
  const state = run([prompt, chunk('agent_thought_chunk', '先想想'), chunk('agent_thought_chunk', '再想想'), chunk('agent_message_chunk', '答案')])

  assert.deepEqual(state.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(state.thoughts.length, 1)
  assert.equal(state.thoughts[0].text, '先想想再想想')
  assert.equal(state.thoughts[0].open, false)
  assert.deepEqual(state.timeline.map((e) => e.kind), ['thought'])
  assert.equal(state.turn.thoughts, 1)
})

test('a tool call then its updates merge into one tool and count once', () => {
  const state = run([
    prompt,
    tool('tool_call', { toolCallId: 'a', title: '读取文件', kind: 'read', status: 'in_progress', locations: [{ path: '/w/a.md' }] }),
    tool('tool_call_update', { toolCallId: 'a', status: 'completed', title: null }),
  ])

  assert.deepEqual(state.tools.a, {
    id: 'a', title: '读取文件', kind: 'read', status: 'completed', locations: [{ path: '/w/a.md' }], at: T0 + 20,
  })
  assert.equal(state.timeline.length, 1)
  assert.equal(state.turn.tools, 1)
})

test('a tool call closes the streaming message so the next text starts a new one', () => {
  const state = run([
    prompt,
    chunk('agent_message_chunk', '第一段'),
    tool('tool_call', { toolCallId: 'a', title: '搜索', kind: 'search' }),
    chunk('agent_message_chunk', '第二段'),
  ])

  assert.deepEqual(state.messages.slice(1).map((m) => m.text), ['第一段', '第二段'])
})

test('an update for an unknown tool id creates it instead of dropping it', () => {
  const state = run([prompt, tool('tool_call_update', { toolCallId: 'z', status: 'failed' })])

  assert.equal(state.tools.z.status, 'failed')
  assert.equal(state.tools.z.title, '工具调用')
})

test('permission request waits, resolution records the decision and resumes', () => {
  const options = [{ optionId: 'ok', name: '允许', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }]
  const waiting = run([prompt, { type: 'permission_request', requestId: 'p1', toolCall: { title: '写入 a.md', kind: 'edit' }, options, at: T0 + 30 }])
  const resumed = reduce(deepFreeze(waiting), { type: 'permission_resolved', requestId: 'p1', optionId: 'ok', at: T0 + 40 })

  assert.equal(waiting.phase, 'waiting')
  assert.equal(waiting.permission.title, '写入 a.md')
  assert.equal(resumed.phase, 'working')
  assert.equal(resumed.permission, null)
  assert.deepEqual(resumed.timeline.at(-1), { kind: 'decision', ref: 'p1', at: T0 + 40, title: '写入 a.md', allowed: true, choice: '允许' })
})

test('a stale permission answer is ignored', () => {
  const waiting = run([prompt, { type: 'permission_request', requestId: 'p2', toolCall: null, options: [], at: T0 }])

  assert.equal(reduce(waiting, { type: 'permission_resolved', requestId: 'old', optionId: 'x', at: T0 }), waiting)
  assert.equal(waiting.permission.title, '需要你确认')
})

test('turn end attaches a receipt to the last assistant message', () => {
  const state = run([
    prompt,
    tool('tool_call', { toolCallId: 'a', title: 't', kind: 'read' }),
    chunk('agent_message_chunk', '完成'),
    { type: 'turn_end', stopReason: 'end_turn', at: T0 + 42_000 },
  ])

  assert.equal(state.phase, 'idle')
  assert.deepEqual(state.messages.at(-1).receipt, { ms: 42_000, tools: 1, thoughts: 0, stopReason: 'end_turn' })
  assert.equal(state.messages.at(-1).open, false)
  assert.equal(state.turn, null)
})

test('a cancelled turn without text leaves a note', () => {
  const state = run([prompt, { type: 'turn_end', stopReason: 'cancelled', at: T0 + 1000 }])

  assert.equal(state.messages.at(-1).role, 'note')
  assert.equal(state.messages.at(-1).text, '已停止本轮任务。')
})

test('errors stop the turn and clear any pending permission; ready recovers', () => {
  const errored = run([
    prompt,
    { type: 'permission_request', requestId: 'p', toolCall: {}, options: [], at: T0 },
    { type: 'error', message: '' },
  ])
  const recovered = reduce(errored, { type: 'ready', info: { mode: 'live', model: 'm', cwd: '/w', reason: '' } })

  assert.equal(errored.phase, 'error')
  assert.equal(errored.error, '未知错误')
  assert.equal(errored.permission, null)
  assert.equal(recovered.phase, 'idle')
  assert.equal(recovered.error, null)
})

test('new session clears the conversation but keeps info and the open drawer', () => {
  const info = { mode: 'live', model: 'A', cwd: '/w', reason: '' }
  const state = run([{ type: 'ready', info }, prompt, { type: 'open_drawer', tab: 'files' }, { type: 'new_session' }])

  assert.equal(state.messages.length, 0)
  assert.equal(state.info, info)
  assert.equal(state.drawer, 'files')
})

test('drawer and island toggles', () => {
  const opened = run([{ type: 'toggle_drawer' }, { type: 'toggle_island' }])
  const closed = run([{ type: 'close_drawer' }, { type: 'close_island' }], opened)

  assert.equal(opened.drawer, 'trace')
  assert.equal(opened.island, true)
  assert.equal(closed.drawer, null)
  assert.equal(closed.island, false)
  assert.equal(reduce(closed, { type: 'close_island' }), closed)
})

test('usage updates and unknown actions or updates leave state as-is', () => {
  const withUsage = run([{ type: 'acp_update', at: T0, update: { sessionUpdate: 'usage_update', used: 10, size: 100 } }])

  assert.deepEqual(withUsage.usage, { used: 10, size: 100 })
  assert.equal(reduce(withUsage, { type: 'nope' }), withUsage)
  assert.equal(reduce(withUsage, { type: 'acp_update', at: T0, update: { sessionUpdate: 'plan' } }), withUsage)
  assert.equal(reduce(withUsage, chunk('agent_message_chunk', '')), withUsage)
})

test('non-text content is shown as a placeholder', () => {
  const state = run([prompt, { type: 'acp_update', at: T0, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } } }])

  assert.equal(state.messages.at(-1).text, '[image]')
})

test('assistant text starts hidden and is typed out by reveal ticks', () => {
  // Arrange
  const streaming = run([prompt, chunk('agent_message_chunk', '你好，世界')])

  // Act
  const partial = reduce(streaming, { type: 'reveal_tick', dt: 16 })
  const done = reduce(partial, { type: 'reveal_tick', dt: 10_000 })

  // Assert
  assert.equal(streaming.messages.at(-1).shown, 0)
  assert.equal(isRevealing(streaming), true)
  assert.ok(partial.messages.at(-1).shown >= 1 && partial.messages.at(-1).shown < 5)
  assert.equal(done.messages.at(-1).shown, 5)
  assert.equal(isRevealing(done), false)
  assert.equal(reduce(done, { type: 'reveal_tick', dt: 16 }), done)
})

test('reveal speed has a floor and catches up so it never trails far behind', () => {
  assert.equal(revealStep(0, 1000, 100), 83)
  assert.equal(revealStep(0, 10, 100), 9)
  assert.equal(revealStep(0, 10, 1), 1)
  assert.equal(revealStep(10, 10, 16), 10)
})

test('model config updates merge into info; picker opens and closes', () => {
  const info = { mode: 'live', model: 'A', modelValue: 'a', models: [], effort: 'high', efforts: [], cwd: '/w', reason: '' }
  const ready = run([{ type: 'ready', info }])
  const switched = reduce(ready, { type: 'config_applied', info: { model: 'B', modelValue: 'b' } })
  const opened = reduce(switched, { type: 'picker_toggle' })

  assert.deepEqual([switched.info.model, switched.info.effort, switched.info.cwd], ['B', 'high', '/w'])
  assert.equal(opened.picker, true)
  assert.equal(reduce(opened, { type: 'picker_close' }).picker, false)
  assert.equal(reduce(switched, { type: 'picker_close' }), switched)
})

const SAVED = [
  { role: 'user', text: '上次的问题', receipt: null },
  { role: 'assistant', text: '上次的回答', receipt: { ms: 1000, tools: 1, thoughts: 0, stopReason: 'end_turn' } },
]
const loadSaved = { type: 'history_loaded', messages: SAVED, savedAt: T0 }

test('history_loaded restores saved messages fully typed out, marked as restored', () => {
  // Act
  const state = run([loadSaved])

  // Assert
  assert.deepEqual(state.messages.map((m) => [m.id, m.role, m.text, m.open, m.restored]), [
    ['m0', 'user', '上次的问题', false, true],
    ['m1', 'assistant', '上次的回答', false, true],
  ])
  assert.equal(state.messages[1].shown, '上次的回答'.length)
  assert.equal(isRevealing(state), false)
  assert.deepEqual(state.restored, { count: 2, savedAt: T0 })
})

test('history_loaded never replaces a conversation that already started, and new session forgets it', () => {
  const started = run([prompt])
  const loaded = run([loadSaved])

  assert.equal(reduce(started, loadSaved), started)
  assert.equal(reduce(initialState, { ...loadSaved, messages: [] }), initialState)
  assert.equal(reduce(loaded, { type: 'new_session', info: null }).restored, null)
  assert.equal(run([loadSaved, prompt]).messages[2].id, 'm2')
})

test('while a conversation switch is in flight nothing can be sent, and any outcome ends the switch', () => {
  const switching = run([{ type: 'session_switching' }])

  assert.equal(switching.switching, true)
  assert.equal(reduce(switching, { type: 'new_session', info: null }).switching, false)
  assert.equal(reduce(switching, { type: 'session_switch_failed' }).switching, false)
  assert.equal(reduce(switching, { type: 'error', message: 'x' }).switching, false)
  assert.equal(initialState.switching, false)
})
