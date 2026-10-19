import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { parseSessionLog, readSessionTrace } from '../src/main/dsh-log.js'

const SESSION = '11111111-2222-3333-4444-555555555555'
const event = (type, time, data) => JSON.stringify({ type, seq: time, time, data })
const call = (time, callId, name, args) => event('tool/call', time, { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
const result = (time, callId, isError = false) => event('tool/result', time, {
  turn: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: '…' }], isError },
})
const assistant = (time, parts) => event('assistant/message', time, { turn: 1, message: { role: 'assistant', content: parts } })

const LOG = [
  event('session', 1, { id: SESSION }),
  event('user/message', 2, { content: [{ type: 'text', text: '帮我查资料' }], role: 'user' }),
  assistant(3, [{ type: 'reasoning', text: '先搜索，' }, { type: 'reasoning', text: '再读文件。' }, { type: 'tool-call' }]),
  call(4, 'c1', 'web_search', { queries: ['agent loop', 'ReAct'] }),
  result(5, 'c1'),
  call(6, 'c2', 'read', { file_path: '/w/notes.md', offset: 1 }),
  result(7, 'c2', true),
  call(8, 'c3', 'bash', { command: 'ls -la', description: '列出工作区' }),
  call(9, 'c4', 'write', { file_path: '/w/out.md', content: 'x'.repeat(10_000) }),
  'not json at all',
  assistant(10, [{ type: 'text', text: '好了' }]),
  call(99, 'late', 'web_fetch', { url: 'https://example.com' }),
].join('\n')

test('parseSessionLog turns dsh events into the trace shape the drawer already shows', () => {
  // Act
  const trace = parseSessionLog(LOG, { sessionId: SESSION, until: 50 })

  // Assert
  assert.deepEqual(trace.thoughts.map((t) => [t.text, t.at]), [['先搜索，再读文件。', 3]])
  assert.deepEqual(trace.timeline.map((e) => e.kind), ['thought', 'tool', 'tool', 'tool', 'tool'])
  const tools = trace.timeline.filter((e) => e.kind === 'tool').map((e) => trace.tools[e.ref])
  assert.deepEqual(tools.map((t) => [t.title, t.kind, t.status]), [
    ['搜索 agent loop / ReAct', 'search', 'completed'],
    ['读取 notes.md', 'read', 'failed'],
    ['列出工作区', 'execute', 'in_progress'],
    ['写入 out.md', 'edit', 'in_progress'],
  ])
  assert.deepEqual(tools[1].locations, [{ path: '/w/notes.md' }])
  assert.equal(tools[0].rawInput.query, 'agent loop / ReAct')
  assert.equal(JSON.stringify(tools[3]).includes('xxxx'), false, 'file contents are not carried into the trace')
  assert.ok(tools.every((t) => t.id.startsWith(`${SESSION}:`)))
})

function dshHomeWith(sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))
  for (const [dirName, text] of Object.entries(sessions)) {
    const dir = path.join(home, 'sessions', '--w--', dirName)
    fs.mkdirSync(dir, { recursive: true })
    // dsh appends one zstd frame per write, so a real log is many frames back to back
    const frames = text.split('\n').map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`)))
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  }
  return home
}

test('readSessionTrace finds compressed logs by session id and merges several sessions in order', async () => {
  const second = '99999999-2222-3333-4444-555555555555'
  const home = dshHomeWith({
    [SESSION]: LOG,
    [`session-${second}`]: call(60, 'c9', 'web_fetch', { url: 'https://example.com/a' }),
  })

  const found = await readSessionTrace({ dshHome: home, sessionIds: [SESSION, second, 'missing-session-x'], until: 100 })
  const nothing = await readSessionTrace({ dshHome: home, sessionIds: ['missing-session-x'], until: 100 })

  assert.equal(found.available, true)
  assert.equal(found.missing, 1)
  assert.equal(found.trace.timeline.length, 7, 'every frame of the log is read, not just the first')
  const last = found.trace.tools[found.trace.timeline.at(-1).ref]
  assert.deepEqual([last.title, last.kind, last.rawInput.url], ['抓取网页', 'fetch', 'https://example.com/a'])
  assert.deepEqual([nothing.available, nothing.trace.timeline], [false, []])
})

test('readSessionTrace refuses session ids that could escape the dsh folder', async () => {
  await assert.rejects(readSessionTrace({ dshHome: '/tmp', sessionIds: ['../etc'], until: 1 }), /id/)
})
