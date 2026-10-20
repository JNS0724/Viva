import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import {
  catMood,
  fileItems, formatElapsed, greeting, historyMessages, modeLine, permissionDetail, receiptLine, restoredNote, setupView, statusView,
  toolDetail, traceItems, truncate, usageLabel, webItems, workspaceName,
} from '../src/renderer/selectors.js'

const T0 = new Date(2026, 9, 18, 14, 20, 0).getTime()
const live = { type: 'ready', info: { mode: 'live', model: 'DeepSeek V4 Flash', cwd: '/Users/me/work', reason: '' } }
const run = (actions) => actions.reduce(reduce, initialState)
const toolCall = (toolCallId, fields) => ({ type: 'acp_update', at: T0, update: { sessionUpdate: 'tool_call', toolCallId, ...fields } })

test('status: connecting, idle with model, done after a turn, stopped after cancel', () => {
  assert.deepEqual(statusView(initialState, T0), { tone: 'pending', label: '连接中', event: 'DEEPSEEK HARNESS' })
  assert.deepEqual(statusView(run([live]), T0), { tone: 'idle', label: '空闲', event: 'DeepSeek V4 Flash' })

  const done = run([live, { type: 'user_prompt', text: 'x', at: T0 }, { type: 'turn_end', stopReason: 'end_turn', at: T0 + 65_000 }])
  assert.deepEqual(statusView(done, T0), { tone: 'done', label: '已完成', event: '01:05' })

  const stopped = run([live, { type: 'user_prompt', text: 'x', at: T0 }, { type: 'turn_end', stopReason: 'cancelled', at: T0 }])
  assert.equal(statusView(stopped, T0).label, '已停止')
})

test('status while working names the active tool and the elapsed time', () => {
  const thinking = run([live, { type: 'user_prompt', text: 'x', at: T0 }])
  const busy = run([live, { type: 'user_prompt', text: 'x', at: T0 }, toolCall('a', { title: '读取下载文件夹', status: 'in_progress' })])
  const replying = run([live, { type: 'user_prompt', text: 'x', at: T0 },
    { type: 'acp_update', at: T0, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } }])

  assert.equal(statusView(thinking, T0 + 3000).event, '正在思考 · 00:03')
  assert.equal(statusView(busy, T0 + 12_000).event, '读取下载文件夹 · 00:12')
  assert.equal(statusView(replying, T0).event, '正在回复 · 00:00')
})

test('status while waiting or failed', () => {
  const waiting = run([live, { type: 'user_prompt', text: 'x', at: T0 },
    { type: 'permission_request', requestId: 'p', toolCall: { title: '发送邮件' }, options: [], at: T0 }])
  const failed = run([live, { type: 'error', message: 'dsh 已退出（1）' }])

  assert.deepEqual(statusView(waiting, T0), { tone: 'waiting', label: '等待你确认', event: '发送邮件' })
  assert.deepEqual(statusView(failed, T0), { tone: 'error', label: '出错', event: 'dsh 已退出（1）' })
})

test('receipt line', () => {
  assert.equal(receiptLine({ ms: 42_300, tools: 3, thoughts: 1, stopReason: 'end_turn' }), 'DONE IN 42S · 3 TOOLS · 1 THOUGHT')
  assert.equal(receiptLine({ ms: 10, tools: 1, thoughts: 0, stopReason: 'end_turn' }), 'DONE IN 1S · 1 TOOL')
  assert.equal(receiptLine({ ms: 0, tools: 0, thoughts: 0, stopReason: 'cancelled' }), 'STOPPED')
})

test('trace items cover thoughts, tools, permission requests and decisions in order', () => {
  const options = [{ optionId: 'no', name: '拒绝', kind: 'reject_once' }]
  const state = run([
    live,
    { type: 'user_prompt', text: 'x', at: T0 },
    { type: 'acp_update', at: T0, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想' } } },
    toolCall('a', { title: '读取', kind: 'read', status: 'completed', locations: [{ path: '/w/a.md' }] }),
    { type: 'permission_request', requestId: 'p', toolCall: { title: '删除 a.md' }, options, at: T0 },
    { type: 'permission_resolved', requestId: 'p', optionId: 'no', at: T0 },
  ])

  assert.deepEqual(traceItems(state).map(({ title, detail, tone, time }) => [title, detail, tone, time]), [
    ['思考', '想一想', 'think', '14:20:00'],
    ['读取', 'read · /w/a.md', 'done', '14:20:00'],
    ['请求你确认', '删除 a.md', 'waiting', '14:20:00'],
    ['未授权 · 拒绝', '删除 a.md', 'idle', '14:20:00'],
  ])
})

test('file items dedupe by path with the last action winning; web items list fetches', () => {
  const state = run([
    toolCall('a', { title: '读', kind: 'read', status: 'completed', locations: [{ path: '/w/a.md' }] }),
    toolCall('b', { title: '写', kind: 'edit', status: 'in_progress', locations: [{ path: '/w/a.md' }, { path: 'C:\\w\\b.txt' }] }),
    toolCall('c', { title: '搜索资料', kind: 'fetch', status: 'completed', rawInput: { url: 'https://example.com' } }),
    toolCall('d', { title: '打开页面', kind: 'fetch' }),
  ])

  assert.deepEqual(fileItems(state), [
    { path: '/w/a.md', kind: 'edit', tone: 'working', name: 'a.md' },
    { path: 'C:\\w\\b.txt', kind: 'edit', tone: 'working', name: 'b.txt' },
  ])
  assert.deepEqual(webItems(state).map((w) => [w.url, w.tone]), [['https://example.com', 'done'], ['打开页面', 'pending']])
})

test('tool detail falls back from path to url to compact JSON', () => {
  assert.equal(toolDetail({ kind: 'fetch', rawInput: { query: 'deepseek' } }), 'fetch · deepseek')
  assert.equal(toolDetail({ kind: 'execute', rawInput: { command: 'ls' } }), 'execute · {"command":"ls"}')
  assert.equal(toolDetail({ kind: 'other' }), 'other')
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(toolDetail({ kind: 'other', rawInput: cyclic }), 'other · [无法显示的参数]')
})

test('permission detail pretty-prints arguments', () => {
  assert.equal(permissionDetail({ rawInput: { path: 'a' } }), '{\n  "path": "a"\n}')
  assert.equal(permissionDetail({ rawInput: null }), '')
  assert.equal(permissionDetail({ rawInput: { command: 'rm -rf build\nls' } }), 'rm -rf build\nls', 'a command is shown as itself')
})

test('formatting helpers', () => {
  assert.equal(formatElapsed(-5), '00:00')
  assert.equal(formatElapsed(3_725_000), '62:05')
  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(truncate(null, 4), '')
  assert.equal(workspaceName('/Users/me/work/'), 'work')
  assert.equal(workspaceName(''), '—')
  assert.equal(usageLabel({ used: 25, size: 100 }), '25% CONTEXT')
  assert.equal(usageLabel(null), '')
  assert.equal(modeLine({ mode: 'setup', problem: 'no-key' }), '未连接')
  assert.equal(modeLine({ mode: 'live' }), 'DeepSeek Harness · ACP')
  assert.equal(modeLine({ mode: 'connecting' }), '连接中…')
})

test('greeting follows the hour', () => {
  const at = (hour) => greeting(new Date(2026, 0, 1, hour))
  assert.deepEqual([at(2), at(8), at(12), at(15), at(21)], ['夜深了', '早上好', '中午好', '下午好', '晚上好'])
})

const messageChunk = (text) => ({ type: 'acp_update', at: T0, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })

test('historyMessages keeps only finished messages, without UI-only fields', () => {
  const state = run([live, { type: 'user_prompt', text: '问', at: T0 }, messageChunk('答一半')])
  const finished = reduce(state, { type: 'turn_end', stopReason: 'end_turn', at: T0 + 2000 })

  assert.deepEqual(historyMessages(state), [{ role: 'user', text: '问', receipt: null }])
  assert.deepEqual(historyMessages(finished), [
    { role: 'user', text: '问', receipt: null },
    { role: 'assistant', text: '答一半', receipt: { ms: 2000, tools: 0, thoughts: 0, stopReason: 'end_turn' } },
  ])
})

test('restoredNote says when the conversation is from and whether the agent still remembers it', () => {
  const saved = [{ role: 'user', text: '旧问题', receipt: null }]
  const loaded = (info, savedAt) => run([{ type: 'ready', info }, { type: 'history_loaded', messages: saved, savedAt }])
  const today = new Date(2026, 9, 18, 9, 5).getTime()
  const earlier = new Date(2026, 9, 3, 23, 40).getTime()

  assert.equal(restoredNote(run([live]), T0), null)
  assert.deepEqual(restoredNote(loaded({ ...live.info, remembersHistory: true }, today), T0), {
    when: '今天 09:05', memory: '助手记得这些内容，可以接着聊',
  })
  assert.deepEqual(restoredNote(loaded({ ...live.info, remembersHistory: false }, earlier), T0), {
    when: '10月3日 23:40', memory: '上次的会话没能恢复，助手已不记得这些内容',
  })
  assert.equal(restoredNote(loaded({ mode: 'connecting' }, today), T0).memory, '')
})

test('setup state: the island says not connected, and the home card says what to do', () => {
  const noKey = run([{ type: 'ready', info: { mode: 'setup', problem: 'no-key', cwd: '/w', model: '' } }])
  const noDsh = run([{ type: 'ready', info: { mode: 'setup', problem: 'no-dsh', cwd: '/w', model: '' } }])

  assert.deepEqual(statusView(noKey, T0), { tone: 'pending', label: '未连接', event: '需要配置模型' })
  assert.equal(statusView(noDsh, T0).event, '未安装 DSH')
  assert.deepEqual(setupView(noKey.info), {
    title: '连接模型',
    body: '填写 DeepSeek API key，或在设置里添加其他模型，就能开始。key 用系统钥匙串加密保存，只留在这台电脑上。',
    action: '去设置',
    placeholder: '先配置模型才能发送…',
  })
  assert.equal(setupView(noDsh.info).action, null)
  assert.equal(setupView(live.info), null)
})

test('the cat\'s mood follows the agent: thinking, typing, a sign while it waits on the user, pleased, worried', () => {
  const asked = reduce(initialState, { type: 'user_prompt', text: '整理资料', at: 1 })
  assert.equal(catMood(initialState), 'idle')
  assert.equal(catMood(asked), 'thinking')
  const tool = reduce(asked, { type: 'acp_update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: '读文件', status: 'in_progress' }, at: 2 })
  assert.equal(catMood(tool), 'typing')
  const writing = reduce(asked, { type: 'acp_update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } }, at: 2 })
  assert.equal(catMood(writing), 'typing', 'writing the answer is typing too')
  assert.equal(catMood(reduce(asked, { type: 'permission_request', requestId: 'p1', toolCall: { title: '写入' }, options: [], at: 3 })), 'confirm')
  assert.equal(catMood(reduce(asked, { type: 'question_request', questionId: 'q1', questions: [{ id: 'a', question: '哪里？', header: '', options: [], multiSelect: false }], at: 3 })), 'ask')
  assert.equal(catMood(reduce(writing, { type: 'turn_end', stopReason: 'end_turn', at: 4 })), 'done')
  assert.equal(catMood(reduce(asked, { type: 'turn_end', stopReason: 'cancelled', at: 4 })), 'idle', 'stopped is not done')
  assert.equal(catMood(reduce(asked, { type: 'error', message: 'x' })), 'error')
})
