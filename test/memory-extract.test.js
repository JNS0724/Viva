import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { candidatesFor, extractionInput, extractTurn, parseExtraction, worthExtracting } from '../plugins/memory/lib/extract.js'
import { buildLexicon } from '../plugins/memory/lib/names.js'
import { openMemoryDb } from '../plugins/memory/lib/store.js'
import { introChanges, introPrompt, memoryNotice } from '../src/renderer/memory-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

function tempDb(t, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-extract-'))
  const db = openMemoryDb({ file: path.join(dir, 'memory.db'), now })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return db
}

const answer = (value) => async () => JSON.stringify(value)

test('the extractor answer is taken only in its exact shape', () => {
  assert.deepEqual(parseExtraction('```json\n{"add":[{"text":"回答先给结论","kind":"preference"}],"invalidate":[]}\n```'), {
    add: [{ text: '回答先给结论', kind: 'preference', keywords: [], replaces: null }], invalidate: [],
  })
  assert.deepEqual(parseExtraction('{}'), { add: [], invalidate: [] })
  assert.throws(() => parseExtraction('好的，我来整理'), /不是 JSON/)
  assert.throws(() => parseExtraction('{"add":[{"text":"x","kind":"gossip"}]}'), /未知的 kind/)
  assert.throws(() => parseExtraction('{"add":[{"text":"x","replaces":"#3"}]}'), /replaces/)
  assert.throws(() => parseExtraction('{"add":[],"invalidate":[1.5]}'), /invalidate/)
  assert.throws(() => parseExtraction('{"add":[{"text":"x","keywords":"张三"}]}'), /keywords/)
})

test('chit-chat skips the model call; talk about the user, their work or named things does not', () => {
  const lexicon = buildLexicon({}, [{ keywords: ['张三'] }])
  assert.equal(worthExtracting('好的', lexicon), false)
  assert.equal(worthExtracting('帮我算一下 17 乘 23', lexicon), false)
  assert.equal(worthExtracting('以后回答先给结论', lexicon), true)
  assert.equal(worthExtracting('张三下周去上海出差', lexicon), true)
})

test('an answer to the agent\'s question always gets a look, and reaches the extractor beside the user\'s words', async (t) => {
  const db = tempDb(t, () => 1000)
  const inputs = []
  await extractTurn({
    db, userWords: '明天天气', answers: [{ question: '你想看哪个城市的天气？', answer: '上海' }], reply: '', today: 'x',
    complete: async (_system, input) => { inputs.push(JSON.parse(input)); return '{"add":[],"invalidate":[]}' },
  })
  assert.deepEqual(inputs.map((input) => [input.user, input.answers]), [['明天天气', [{ question: '你想看哪个城市的天气？', answer: '上海' }]]])
  assert.equal(JSON.parse(extractionInput({ userWords: 'x', reply: '', today: 'x', candidates: [] })).answers, undefined, 'no answers, no field')
})

test('the extractor sees the profile, so it does not repeat it', () => {
  const input = JSON.parse(extractionInput({
    userWords: '我是后端负责人', reply: '', today: 'x', candidates: [],
    profile: { role: { value: '后端负责人' } },
  }))
  assert.deepEqual(input.profile, { role: '后端负责人' })
})

test('the extractor is shown the memories about what the turn names, and nothing unrelated', () => {
  const memories = [
    { id: 1, text: '张三是直属上级', keywords: ['张三'], updatedAt: 1 },
    { id: 2, text: '周报每周五交', keywords: ['周报'], updatedAt: 2 },
    { id: 3, text: '喜欢用表格对比方案', keywords: [], updatedAt: 3 },
  ]
  const lexicon = buildLexicon({}, memories)
  assert.deepEqual(candidatesFor('张三调走了', memories, lexicon).map((m) => m.id), [1])
  assert.deepEqual(candidatesFor('今天天气不错', memories, lexicon), [])
})

test('a background pass adds, replaces what it was shown, and leaves the old memory as history', async (t) => {
  let clock = 1000
  const db = tempDb(t, () => clock)
  const old = db.addMemory({ text: '张三是直属上级', kind: 'person', keywords: ['张三'], source: 'agent' }).memory
  clock = 2000

  const result = await extractTurn({
    db, userWords: '张三调走了，现在上级是李四', reply: '好的', today: '2026-10-18（周日）',
    complete: answer({ add: [{ text: '直属上级是李四', kind: 'person', keywords: ['李四'], replaces: old.id }], invalidate: [] }),
  })

  assert.deepEqual(result.invalidated, [old.id])
  assert.deepEqual(db.listMemories().items.map((m) => m.text), ['直属上级是李四'])
  assert.deepEqual(db.listInvalid().map((m) => [m.text, m.supersededBy, m.invalidatedBy, m.invalidAt]), [['张三是直属上级', result.added[0].id, 'agent', 2000]])
  assert.equal(db.listMemories().invalid, 1)
})

test('one bad change drops the whole batch: unshown ids, user memories, secrets, too many changes', async (t) => {
  const db = tempDb(t)
  const mine = db.addMemory({ text: '张三是直属上级', keywords: ['张三'], source: 'user' }).memory
  const elsewhere = db.addMemory({ text: '周报每周五交', source: 'agent' }).memory
  const run = (value) => extractTurn({ db, userWords: '张三调走了，以后找李四', reply: '', today: 'x', complete: answer(value) })
  const good = { text: '直属上级是李四' }

  await assert.rejects(run({ add: [good], invalidate: [elsewhere.id] }), /不在可修改的范围里/)
  await assert.rejects(run({ add: [{ ...good, replaces: mine.id }], invalidate: [] }), /用户自己写的/)
  await assert.rejects(run({ add: [good, { text: '我的密码是 hunter2' }], invalidate: [] }), /不会被记住/)
  await assert.rejects(run({ add: [good, { text: 'a' }, { text: 'b' }, { text: 'c' }], invalidate: [] }), /最多 3 处/)
  assert.deepEqual(db.listMemories().items.map((m) => m.text).sort(), ['周报每周五交', '张三是直属上级'], 'nothing from any batch was kept')
  assert.equal(db.listMemories().invalid, 0)
})

test('the user can forget their own memory, the agent cannot; reviving or saving it again makes it count again', (t) => {
  const db = tempDb(t)
  const mine = db.addMemory({ text: '回答先给结论', kind: 'preference', source: 'user' }).memory
  assert.throws(() => db.invalidateMemory(mine.id, { by: 'agent' }), /只有用户能让它失效/)
  db.invalidateMemory(mine.id, { by: 'user' })
  assert.deepEqual([db.ofKind('preference', 5).length, db.allMemories().length, db.listMemories().total], [0, 0, 0], 'an invalid memory is never used')

  assert.equal(db.reviveMemory(mine.id).invalidAt, null)
  db.invalidateMemory(mine.id, { by: 'user' })
  assert.equal(db.addMemory({ text: '回答先给结论。' }).memory.invalidAt, null, 'saying it again brings it back')
  assert.equal(db.invalidateMemory(999, { by: 'user' }), null)
})

test('undoing a delete keeps an invalidated memory invalid', (t) => {
  const db = tempDb(t)
  const memory = db.addMemory({ text: '张三是直属上级', source: 'agent' }).memory
  db.invalidateMemory(memory.id, { by: 'agent' })
  const removed = db.deleteMemory(memory.id)
  assert.notEqual(db.restoreMemory(removed).invalidAt, null)
})

test('the notice says what was remembered and what stopped counting', () => {
  assert.equal(memoryNotice({ memories: ['直属上级是李四'], invalidated: ['张三是直属上级'] }), '已记住：直属上级是李四；「张三是直属上级」已不再使用')
  assert.equal(memoryNotice({ invalidated: ['a', 'b'] }), '2 条旧记忆已不再使用')
})

test('the invalid list opens, and a revived memory moves back among the valid ones', () => {
  const invalid = { id: 7, text: '张三是直属上级', invalidAt: 1, supersededBy: 8, invalidatedBy: 'agent' }
  const loaded = reduce(initialState, { type: 'memory_loaded', data: { profile: {}, items: [], total: 0, invalid: 1, onboarding: 'done', habits: { text: '', samples: 0 } } })
  const opened = reduce(loaded, { type: 'memory_invalid_listed', items: [invalid] })
  const revived = reduce(opened, { type: 'memory_revived', memory: { ...invalid, invalidAt: null } })

  assert.deepEqual([opened.memory.invalidOpen, opened.memory.invalid], [true, 1])
  assert.deepEqual([revived.memory.invalid, revived.memory.invalidItems, revived.memory.items.map((m) => m.id), revived.memory.total], [0, [], [7], 1])
  assert.equal(reduce(opened, { type: 'memory_invalid_closed' }).memory.invalidOpen, false)
})

test('the intro keeps the three profile fields it asks for; sites and documents only go to the reading prompt', () => {
  assert.deepEqual(introChanges({ role: ' 后端负责人 ', projects: '', preferences: '先给结论', sources: 'https://wiki.example', email: 'x' }),
    { role: '后端负责人', preferences: '先给结论' })
  assert.match(introPrompt({ sources: ['https://wiki.example'], docs: [{ path: '/w/我的资料/周报.md' }] }), /- https:\/\/wiki\.example\n- \/w\/我的资料\/周报\.md$/)
})
