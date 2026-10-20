import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { contextForTurn } from '../plugins/memory/lib/inject.js'
import { initialSession, LONG_PROMPT_CHARS, ownWords, planTurn, PUSH_LIMIT, retrievalBasis } from '../plugins/memory/lib/layers.js'
import { buildLexicon, namesIn } from '../plugins/memory/lib/names.js'
import { openMemoryDb } from '../plugins/memory/lib/store.js'
import { scratch } from './fixtures/scratch.js'

function tempDb(t, now) {
  const { dir, defer } = scratch(t, 'memory-layers-')
  const file = path.join(dir, 'memory.db')
  const db = openMemoryDb({ file, now })
  defer(() => db.close())
  return { db, file }
}

const memory = (id, text, keywords = [], updatedAt = id) => ({ id, text, keywords, updatedAt })

test('names come from the projects in the profile and from memory keywords, cleaned and without generic words', () => {
  const lexicon = buildLexicon(
    { projects: { value: '- Q4 对账系统重构（主负责）、PR：评审' }, role: { value: '后端负责人' } },
    [{ keywords: ['周报', '项目', 'x'] }, { keywords: ['张三'] }],
  )
  assert.deepEqual(lexicon.map((entry) => entry.name), ['Q4 对账系统重构', 'PR', '周报', '张三'])
})

test('a name is found whole, by four of its characters, and never inside a longer Latin word', () => {
  const lexicon = buildLexicon({ projects: { value: 'Q4 对账系统重构\nPR' } }, [])
  assert.deepEqual([...namesIn('对账系统上线了吗', lexicon).values()], ['Q4 对账系统重构'])
  assert.deepEqual([...namesIn('看一下这个 PR', lexicon).values()], ['PR'])
  assert.equal(namesIn('prompt 怎么写', lexicon).size, 0)
  assert.equal(namesIn('对账怎么做', lexicon).size, 0, 'two characters of a long name are not enough')
})

test('pasted material is reduced to the words around it; short follow-ups lean on the previous question', () => {
  const pasted = `帮我改得礼貌一点：\n${'张三你好，'.repeat(80)}\n谢谢`
  assert.ok(pasted.length > LONG_PROMPT_CHARS)
  assert.equal(ownWords(pasted), '帮我改得礼貌一点：\n谢谢')
  assert.equal(retrievalBasis('那第二个呢', '对账系统的两个方案').basis, '对账系统的两个方案\n那第二个呢')
  assert.equal(retrievalBasis('帮我写一份上线检查清单', '对账系统的两个方案').basis, '帮我写一份上线检查清单')
})

test('the fixed layer goes out first, after a change and after a compaction', () => {
  const plan = (session, signature, epoch = 0) => planTurn(session, { question: '你好', fixedSignature: signature, epoch, memories: [], lexicon: [], inFixed: new Set() })
  const first = plan(initialSession, 'a')
  const same = plan(first.session, 'a')
  const changed = plan(same.session, 'b')
  const compacted = plan(changed.session, 'b', 1)
  assert.deepEqual([first.fixed, same.fixed, changed.fixed, compacted.fixed], ['first', null, 'changed', 'compacted'])
})

test('memories are pushed only for named things, best first, at most a few, once per session', () => {
  const lexicon = buildLexicon({}, [{ keywords: ['张三'] }, { keywords: ['周报'] }])
  const memories = [
    memory(1, '周报每周五下班前交给张三', ['周报']),
    memory(2, '张三是直属上级'),
    memory(3, '回答先给结论'),
    ...Array.from({ length: 5 }, (_, i) => memory(10 + i, `和张三的第 ${i} 次会议`)),
  ]
  const turn = (session, question, inFixed = new Set()) => planTurn(session, { question, fixedSignature: 's', epoch: 0, memories, lexicon, inFixed })

  const nothing = turn(initialSession, '今天天气怎么样')
  const both = turn(nothing.session, '张三要的周报怎么写')
  const again = turn(both.session, '张三的周报')
  assert.deepEqual(nothing.pushed, [])
  assert.equal(both.pushed.length, PUSH_LIMIT)
  assert.deepEqual(both.pushed[0], { memory: memories[0], names: ['张三', '周报'] }, 'naming more of the question ranks first')
  assert.ok(again.pushed.every(({ memory: m }) => !both.pushed.some((p) => p.memory.id === m.id)), 'nothing twice')
  assert.equal(turn(initialSession, '张三要的周报', new Set([1])).pushed.some((p) => p.memory.id === 1), false, 'what the fixed layer carries is not pushed')
})

test('one turn end to end: state is saved, what was sent is logged, a compaction sends the profile again', (t) => {
  const { db } = tempDb(t)
  db.setProfile({ role: '后端负责人' })
  db.addMemory({ text: '周报每周五下班前交给张三', keywords: ['周报', '张三'] })
  const ask = (turn, question, epoch = 0, today = '2026-10-18（周日）') => contextForTurn(db, { sessionId: 's-1', turn, question, epoch, today })

  assert.match(ask(1, '你好'), /^<about-user>\n【今天】\n2026-10-18（周日）\n[\s\S]*【记忆规则】[\s\S]*角色与职责：后端负责人/)
  assert.match(ask(2, '周报怎么写'), /^<about-user>\n【今天】\n2026-10-18（周日）\n用户的话里提到了[\s\S]*周报每周五下班前交给张三〔周报〕/)
  assert.equal(ask(3, '谢谢'), '')
  assert.equal(ask(4, '早上好', 0, '2026-10-19（周一）'), '<about-user>\n【今天】\n2026-10-19（周一）\n</about-user>', 'a new day sends just the date')
  assert.equal(ask(5, '继续', 0, '2026-10-19（周一）'), '', 'the same day is not sent twice')
  assert.match(ask(6, '再说一下', 1, '2026-10-19（周一）'), /【记忆规则】/)
  assert.deepEqual(db.injectionsAfter(0, 's-1').map((entry) => [entry.turn, entry.fixed]), [[1, 'first'], [2, null], [6, 'compacted']],
    'a date-only block is not logged')
  assert.equal(db.sessionState('s-1').epoch, 1)
})

test('keywords are cleaned, merged into an equal memory, and kept through undo', (t) => {
  const { db } = tempDb(t)
  const first = db.addMemory({ text: '周报交给张三', keywords: [' 周报 ', '张', '周报', 'x'.repeat(30), 'token: abcdef1234567'] }).memory
  assert.deepEqual(first.keywords, ['周报'])
  const again = db.addMemory({ text: '周报交给张三', keywords: ['张三'] }).memory
  assert.deepEqual(again.keywords, ['周报', '张三'])
  assert.throws(() => db.addMemory({ text: 'x', keywords: '周报' }), /关键词必须是列表/)
  const removed = db.deleteMemory(first.id)
  assert.deepEqual(db.restoreMemory(removed).keywords, ['周报', '张三'])
})

test('a memory.db from before keywords gains the column and keeps its memories', (t) => {
  const { dir, defer } = scratch(t, 'memory-old-')
  const file = path.join(dir, 'memory.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL, norm TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    source TEXT NOT NULL, conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO memories VALUES (1, '回答先给结论', '回答先给结论', 'preference', 'user', NULL, 1, 1);`)
  old.close()

  const db = openMemoryDb({ file })
  defer(() => db.close())
  assert.deepEqual(db.listMemories().items.map((m) => [m.text, m.keywords]), [['回答先给结论', []]])
})

test('an unreadable session state starts over instead of failing the turn', (t) => {
  const { db, file } = tempDb(t)
  db.saveSessionState('s-1', { ...initialSession, previous: '你好' })
  assert.equal(db.sessionState('s-1').previous, '你好')
  const raw = new DatabaseSync(file)
  raw.prepare("UPDATE sessions SET state = 'not json' WHERE session_id = 's-1'").run()
  raw.close()
  assert.equal(db.sessionState('s-1'), null)
  assert.equal(db.sessionState('missing'), null)
})
