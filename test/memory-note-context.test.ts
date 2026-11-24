import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemoryRuntime } from './fixtures/localized-memory-runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { looksSecret } from '../src/memory/core/memory-sensitive.ts'

type NoteInput = {
  existing: { title: string, markdown: string } | null
  previousAssistant: string | null
  turns: Array<{ user: Array<{ sourceId: string, text: string }>, assistant: string }>
}
const origin = { conversation: 'conversation', session: 'session' }
const write = (markdown: string) => JSON.stringify({ status: 'write', title: '个人资料', markdown })
const skip = JSON.stringify({ status: 'skip' })

for (const kind of ['file metadata', 'credential'] as const) {
  test(`a protected assistant reply does not drop a safe human turn from the five-turn daily batch: ${kind}`, async t => {
    const store = openMemoryStore(':memory:'), inputs: NoteInput[] = []
    const memory = createMemoryRuntime({ store, now: () => Date.parse('2026-11-17T12:00:00Z'),
      dailyNotes: { timezone: 'UTC', noteInterval: 5 }, route: () => ({ provider: 'fixture', model: 'fixture' }),
      changed: () => {}, async compute(job) {
        assert.equal(job.stage, 'note')
        const input = JSON.parse(job.input) as NoteInput
        inputs.push(input)
        return write(input.turns.flatMap(turn => turn.user.map(source => source.text)).join('\n'))
      } })
    t.after(() => memory.close())
    const request = { operationId: randomUUID(), text: '周报每周五交给同事。' }
    const saved = await memory.writeManagedFile(request.operationId, memory.manualFileWorkspace(), request, () => {})
    assert.ok(saved)
    const users = ['周报每周五交给同事', '先确认收到', '再检查一下时间安排', '仅用于相关问题', '谢谢，先到这里']
    const ids: string[] = []
    let generated = ''
    for (const [index, text] of users.entries()) {
      const id = randomUUID()
      ids.push(id)
      memory.accept(text, origin, id)
      if (index === 2) {
        const packet = memory.handle({ op: 'recall', session: origin.session, query: '周报' }, origin)
        assert.ok(packet.includes(saved.contentRevision), 'the response is the real file-recall packet with its opaque file revision')
        generated = kind === 'file metadata' ? `查到了：${JSON.stringify(packet)}` : 'The generated reply contains sk-syntheticCredential123456789.'
        assert.equal(looksSecret(generated), true)
      }
      memory.recordNoteTurn!(origin.session, [id], index === 2 ? generated : '已收到')
      await memory.wake()
    }
    assert.equal(store.db.prepare('SELECT count(*) n FROM memory_note_turns').get()?.n, 5)
    assert.equal(inputs.length, 1, 'five completed human turns, including the protected-output turn, trigger the normal daily job')
    assert.deepEqual(inputs[0]!.turns.flatMap(turn => turn.user.map(source => source.text)), users)
    assert.equal(inputs[0]!.turns[2]!.assistant, '')
    assert.ok(inputs[0]!.turns.filter((_, index) => index !== 2).every(turn => turn.assistant === '已收到'))
    const marker = kind === 'file metadata' ? saved.contentRevision : 'sk-syntheticCredential123456789'
    assert.equal(JSON.stringify(inputs).includes(marker), false, 'protected assistant content never reaches the note model')
    const beforeReplay = store.db.prepare('SELECT id,source_tokens,assistant_sources,written FROM memory_note_turns ORDER BY rowid').all()
    memory.recordNoteTurn!(origin.session, [ids[2]!], generated)
    await memory.wake()
    assert.deepEqual(store.db.prepare('SELECT id,source_tokens,assistant_sources,written FROM memory_note_turns ORDER BY rowid').all(), beforeReplay,
      'replaying the same completed protected-output turn is idempotent')
    assert.equal(inputs.length, 1)
    for (const workspace of readdirSync(store.fileRoot)) {
      const dialog = join(store.fileRoot, workspace, 'session/dialog')
      for (const file of readdirSync(dialog)) {
        const persisted = readFileSync(join(dialog, file), 'utf8')
        assert.ok(persisted.includes(users[2]!))
        assert.equal(persisted.includes(marker), false, 'the raw protected reply is not retained in a session file')
      }
    }
    assert.equal(store.db.prepare('SELECT count(*) n FROM memory_daily_notes WHERE revision>0').get()?.n, 1)
  })
}

test('the first daily batch after local midnight retains the previous question and its source dependency', async t => {
  let now = Date.parse('2026-11-14T15:59:00Z')
  const store = openMemoryStore(':memory:', () => now)
  const inputs: NoteInput[] = []
  const question = '你主要住在哪里？'
  const memory = createMemoryRuntime({ store, now: () => now,
    dailyNotes: { timezone: 'Asia/Shanghai', noteInterval: 1 },
    route: () => ({ provider: 'fixture', model: 'fixture' }), changed: () => {},
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


test('previous assistant context cannot cross authorized workspaces when a session ID is reused', async t => {
  const store = openMemoryStore(':memory:')
  const inputs: NoteInput[] = []
  const memory = createMemoryRuntime({ store, now: () => Date.parse('2026-11-14T12:00:00Z'),
    dailyNotes: { timezone: 'UTC', noteInterval: 1 },
    route: () => ({ provider: 'fixture', model: 'fixture' }), changed: () => {},
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
