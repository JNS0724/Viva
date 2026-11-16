import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemoryRuntime } from './fixtures/localized-memory-runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'

type NoteInput = {
  existing: { title: string, markdown: string } | null
  previousAssistant: string | null
  turns: Array<{ user: Array<{ sourceId: string, text: string }>, assistant: string }>
}
const origin = { conversation: 'conversation', session: 'session' }
const write = (markdown: string) => JSON.stringify({ status: 'write', title: '个人资料', markdown })
const skip = JSON.stringify({ status: 'skip' })

test('the first daily batch after local midnight retains the previous question and its source dependency', async t => {
  let now = Date.parse('2026-11-14T15:59:00Z')
  const store = openMemoryStore(':memory:', () => now)
  const inputs: NoteInput[] = []
  const question = '你主要住在哪里？'
  const memory = createMemoryRuntime({ store, now: () => now,
    dailyNotes: { timezone: 'Asia/Shanghai', noteInterval: 1 },
    route: () => ({ provider: 'fixture', model: 'fixture' }), changed: () => {}, quiesce: async () => {},
    async compute(job) {
      assert.equal(job.stage, 'note')
      const input = JSON.parse(job.input) as NoteInput
      inputs.push(input)
      return input.turns.some(turn => turn.user.some(source => source.text === '深圳')) ? write('主要居住地是深圳。') : skip
    },
  })
  t.after(() => memory.close())
  const before = randomUUID(), answer = randomUUID()
  memory.accept('帮我补充个人资料', origin, before)
  memory.recordNoteTurn!(origin.session, [before], question)
  await memory.wake()
  now = Date.parse('2026-11-14T16:01:00Z')
  memory.accept('深圳', origin, answer)
  memory.recordNoteTurn!(origin.session, [answer], '好的')
  await memory.wake()
  assert.equal(inputs.length, 2)
  assert.equal(inputs[1]!.previousAssistant, question)
  const recalled = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '深圳', start_date: '2026-11-15' }, origin)) as {
    notes: Array<{ id: string, workspace: string }>,
  }
  assert.equal(recalled.notes.length, 1)
  assert.deepEqual(new Set(memory.readFile({ kind: 'daily', workspace: recalled.notes[0]!.workspace, id: recalled.notes[0]!.id })?.sources.map(source => source.sourceId)), new Set([before, answer]))
})

test('withdrawing a source removes its later assistant paraphrase before rebuilding surviving user turns', async t => {
  const store = openMemoryStore(':memory:')
  const inputs: NoteInput[] = []
  const marker = '海棠城'
  const first = randomUUID(), second = randomUUID()
  const memory = createMemoryRuntime({ store, now: () => Date.parse('2026-11-14T12:00:00Z'),
    dailyNotes: { timezone: 'UTC', noteInterval: 1 },
    route: () => ({ provider: 'fixture', model: 'fixture' }), changed: () => {}, quiesce: async () => {},
    async compute(job) {
      assert.equal(job.stage, 'note')
      const input = JSON.parse(job.input) as NoteInput
      inputs.push(input)
      // A model that copies an available fact exposes stale assistant context reaching it.
      return JSON.stringify(input).includes(marker) ? write(`居住信息：${marker}。`) : skip
    },
  })
  t.after(() => memory.close())
  memory.accept(`我的居住城市是${marker}`, origin, first)
  memory.recordNoteTurn!(origin.session, [first], '收到')
  await memory.wake()
  memory.accept('谢谢', origin, second)
  memory.recordNoteTurn!(origin.session, [second], `好的，你住在${marker}`)
  await memory.wake()
  const beforeWithdrawal = inputs.length
  memory.withdraw({ ids: [first], conversation: origin.conversation, onlySources: true })
  await memory.wake()
  const rebuilding = inputs.slice(beforeWithdrawal)
  assert.ok(rebuilding.some(input => input.turns.some(turn => turn.user.some(source => source.sourceId === second && source.text === '谢谢'))),
    'the independent user message remains available for rebuilding')
  assert.ok(rebuilding.every(input => !JSON.stringify(input).includes(marker)),
    'the withdrawn source must not reach note computation through a later assistant reply')
  const result = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: marker }, origin)) as { notes: unknown[] }
  assert.deepEqual(result.notes, [])
  for (const workspace of readdirSync(store.fileRoot)) {
    for (const filename of readdirSync(join(store.fileRoot, workspace, 'session/dialog'))) {
      assert.equal(readFileSync(join(store.fileRoot, workspace, 'session/dialog', filename), 'utf8').includes(marker), false,
        'the persisted assistant copy is also cleared')
    }
  }
})

test('previous assistant context cannot cross authorized workspaces when a session ID is reused', async t => {
  const store = openMemoryStore(':memory:')
  const inputs: NoteInput[] = []
  const memory = createMemoryRuntime({ store, now: () => Date.parse('2026-11-14T12:00:00Z'),
    dailyNotes: { timezone: 'UTC', noteInterval: 1 },
    route: () => ({ provider: 'fixture', model: 'fixture' }), changed: () => {}, quiesce: async () => {},
    async compute(job) {
      assert.equal(job.stage, 'note')
      inputs.push(JSON.parse(job.input) as NoteInput)
      return skip
    },
  })
  t.after(() => memory.close())
  for (const [id, assistant] of [['project-a', '甲项目的私有讨论上下文'], ['project-b', '乙项目已收到']] as const) {
    const source = randomUUID()
    memory.accept('普通会话', { ...origin, project: { kind: 'project', id } }, source)
    memory.recordNoteTurn!(origin.session, [source], assistant)
    await memory.wake()
  }
  assert.equal(inputs.length, 2)
  assert.equal(inputs[1]!.previousAssistant, null)
  assert.equal(JSON.stringify(inputs[1]).includes('甲项目'), false)
})

test('replaying a completed turn after later or revoked context leaves its receipt and transcript unchanged', async t => {
  const store = openMemoryStore(':memory:')
  const inputs: NoteInput[] = []
  const memory = createMemoryRuntime({ store, now: () => Date.parse('2026-11-14T12:00:00Z'),
    dailyNotes: { timezone: 'UTC', noteInterval: 1 },
    route: () => ({ provider: 'fixture', model: 'fixture' }), changed: () => {}, quiesce: async () => {},
    async compute(job) {
      assert.equal(job.stage, 'note')
      inputs.push(JSON.parse(job.input) as NoteInput)
      return skip
    },
  })
  t.after(() => memory.close())
  const first = randomUUID(), second = randomUUID()
  memory.accept('第一条原文', origin, first)
  memory.recordNoteTurn!(origin.session, [first], '第一条助手回复')
  await memory.wake()
  memory.accept('第二条原文', origin, second)
  memory.recordNoteTurn!(origin.session, [second], '第二条助手回复')
  await memory.wake()
  const persistedBefore = (store.db.prepare('SELECT id,input,state FROM memory_file_intents ORDER BY id').all())
  const countBefore = inputs.length
  assert.doesNotThrow(() => memory.recordNoteTurn!(origin.session, [first], '第一条助手回复'))
  await memory.wake()
  assert.equal(inputs.length, countBefore)
  assert.deepEqual(store.db.prepare('SELECT id,input,state FROM memory_file_intents ORDER BY id').all(), persistedBefore)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_note_turns').get()?.n, 2)
  for (const workspace of readdirSync(store.fileRoot)) {
    for (const filename of readdirSync(join(store.fileRoot, workspace, 'session/dialog'))) {
      assert.equal(readFileSync(join(store.fileRoot, workspace, 'session/dialog', filename), 'utf8').trim().split('\n').length, 2)
    }
  }
  assert.throws(() => memory.recordNoteTurn!(origin.session, [first], '同ID但不同助手回复'), /memory-request-input-mismatch/u)
  // DSH keeps old session dependencies so the request barrier can reject their reuse.
  // Those later dependencies must not change an earlier completed request's identity.
  store.dispatch.source(origin.session, second)
  memory.withdraw({ ids: [second], conversation: origin.conversation, onlySources: true })
  await memory.wake()
  const afterWithdrawal = inputs.length
  assert.doesNotThrow(() => memory.recordNoteTurn!(origin.session, [first], '第一条助手回复'))
  await memory.wake()
  assert.equal(inputs.length, afterWithdrawal)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_note_turns').get()?.n, 1)
})

for (const removedPosition of [0, 1]) test(`withdrawal of source ${removedPosition + 1} preserves the other user message in the same completed turn`, async t => {
  const store = openMemoryStore(':memory:')
  const inputs: NoteInput[] = []
  const texts = ['我的居住城市是海棠城', '我的汇报时间是每周五']
  const ids = [randomUUID(), randomUUID()]
  const survivingPosition = 1 - removedPosition
  const removed = ids[removedPosition]!, surviving = ids[survivingPosition]!
  const removedText = texts[removedPosition]!, survivingText = texts[survivingPosition]!
  const memory = createMemoryRuntime({ store, now: () => Date.parse('2026-11-14T12:00:00Z'),
    dailyNotes: { timezone: 'UTC', noteInterval: 1 },
    route: () => ({ provider: 'fixture', model: 'fixture' }), changed: () => {}, quiesce: async () => {},
    async compute(job) {
      assert.equal(job.stage, 'note')
      const input = JSON.parse(job.input) as NoteInput
      inputs.push(input)
      const users = input.turns.flatMap(turn => turn.user.map(source => source.text))
      return users.length ? write(users.join('；')) : skip
    },
  })
  t.after(() => memory.close())
  for (const [index, text] of texts.entries()) memory.accept(text, origin, ids[index]!)
  const assistant = '你住在海棠城，每周五提交汇报。'
  memory.recordNoteTurn!(origin.session, ids, assistant)
  await memory.wake()
  assert.equal(inputs.length, 1)
  memory.withdraw({ ids: [removed], conversation: origin.conversation, onlySources: true })
  await memory.wake()
  const rebuilding = inputs.slice(1)
  assert.ok(rebuilding.some(input => input.turns.some(turn => turn.user.some(source => source.sourceId === surviving && source.text === survivingText))),
    'an independently sourced user message in the same turn must still be processed')
  for (const input of rebuilding) {
    assert.equal(JSON.stringify(input).includes(removedText), false)
    assert.equal(JSON.stringify(input).includes(assistant), false)
    assert.ok(input.turns.every(turn => turn.user.every(source => source.sourceId !== removed)))
  }
  const result = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: survivingText }, origin)) as {
    notes: Array<{ id: string, workspace: string, markdown: string }>,
  }
  assert.equal(result.notes.length, 1)
  assert.equal(result.notes[0]!.markdown, survivingText)
  assert.deepEqual(memory.readFile({ kind: 'daily', workspace: result.notes[0]!.workspace, id: result.notes[0]!.id })?.sources.map(source => source.sourceId), [surviving])
  const messages: Array<{ role: string, sourceId?: string, text: string }> = []
  for (const workspace of readdirSync(store.fileRoot)) {
    for (const filename of readdirSync(join(store.fileRoot, workspace, 'session/dialog'))) {
      for (const line of readFileSync(join(store.fileRoot, workspace, 'session/dialog', filename), 'utf8').trim().split('\n').filter(Boolean)) {
        const turn = JSON.parse(line) as { messages: typeof messages }
        messages.push(...turn.messages)
      }
    }
  }
  assert.ok(messages.some(message => message.role === 'user' && message.sourceId === surviving && message.text === survivingText))
  assert.ok(messages.every(message => message.sourceId !== removed && message.text !== assistant))
  const beforeReplay = inputs.length
  try { memory.recordNoteTurn!(origin.session, ids, assistant) } catch (error) {
    // An obsolete completion may be rejected; it must never be renamed to the surviving source ID.
    assert.match(String(error), /memory-(?:request-input-mismatch|source-version|source-withdrawn)/u)
  }
  await memory.wake()
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_note_turns').get()?.n, 1)
  assert.equal(inputs.length, beforeReplay)
})
