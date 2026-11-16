import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { test } from 'node:test'
import { createEffects } from '../src/backend/effects.ts'
import { memoryCompute } from '../src/memory/contracts/memory-contract.ts'
import { DREAM_EXTRACT_SYSTEM, DREAM_VERIFY_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { dreamModelStep } from './fixtures/dream-model.ts'
import { createMemoryRuntime } from './fixtures/localized-memory-runtime.ts'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { scratch } from './fixtures/scratch.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { resolve, promise }
}

const origin = { conversation: 'first-conversation', session: 'first-session' }
test('daily notes are recalled after five rounds and document dream verifies the selected original source', async t => {
  const { dir, defer } = scratch(t, 'viva-daily-memory-')
  let now = Date.parse('2026-11-03T12:00:00Z')
  const stages: string[] = []
  const firstText = '我的周报每周五提交'
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => now)
  const memory = createMemoryRuntime({
    store, now: () => now, timezone: () => 'UTC', dailyNotes: { timezone: 'UTC' },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(job, _signal, tools) {
      stages.push(job.stage)
      if (job.stage === 'note') {
        const input = JSON.parse(job.input) as { turns: Array<{ user: Array<{ text: string }>, assistant: string }> }
        assert.equal(input.turns.length, 5)
        assert.equal(input.turns[0]?.user[0]?.text, firstText)
        assert.equal(input.turns[1]?.assistant, '记下当前进展')
        return JSON.stringify({ status: 'write', title: '周报安排', markdown: '周五提交周报。草稿尚未完成。' })
      }
      assert.equal(job.stage, 'dream')
      if (job.system === DREAM_VERIFY_SYSTEM) {
        const input = JSON.parse(job.input) as { canonicalSources: Array<{ text: string, sourceId: string }> }
        assert.equal(input.canonicalSources.find(source => source.sourceId === ids[0])?.text, firstText)
      }
      return dreamModelStep(job, tools, { name: '周报安排', summary: '每周五提交周报', evidenceId: ids[0] })
    },
  })
  defer(() => memory.close())
  const turns = [firstText, '这周的草稿尚未完成', '再补进展', '需要更新页眉', '其余按旧模板']
  const ids = turns.map(() => randomUUID())
  for (const [index, text] of turns.entries()) {
    memory.accept(text, origin, ids[index]!)
    memory.recordNoteTurn!(origin.session, [ids[index]!], '记下当前进展')
    await memory.wake()
    assert.deepEqual(stages, index < 4 ? [] : ['note'])
    now += 60_000
  }
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memories'").get(), undefined)
  const recalled = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '周报' }, origin))
  assert.match(recalled.notes[0].markdown, /草稿尚未完成/)
  now = Date.parse('2026-11-03T23:00:00Z')
  await memory.wake()
  assert.deepEqual(stages, ['note', 'dream', 'dream', 'dream', 'dream'])
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memories'").get(), undefined)
  const document = store.db.prepare('SELECT sources FROM memory_documents').get()!
  assert.deepEqual(JSON.parse(String(document.sources)).map((ref: { id: string }) => ref.id), [ids[0]])
  memory.withdraw({ ids: [ids[1]], conversation: origin.conversation, onlySources: true })
  const after = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '周报' }, origin))
  assert.deepEqual(after.notes, [])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_documents WHERE forgotten=0').get()?.n, 1)
})

test('daily recall searches past 64 newer notes and returns a match at the end without prefix clipping', async t => {
  const { dir, defer } = scratch(t, 'viva-daily-full-recall-')
  let now = Date.parse('2026-11-01T08:00:00Z')
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => now)
  const beginning = '# Earlier progress\n' + ('Previous milestones and work already discussed.\n'.repeat(220))
  const ending = '# Final decisions\n' + 'Supplemental material from the daily discussion.\n'.repeat(40) + 'NEBULARHARBOR'
  const memory = createMemoryRuntime({
    store, now: () => now, dailyNotes: { noteInterval: 1 },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(job) {
      if (job.stage !== 'note') return JSON.stringify({ units: [] })
      const input = JSON.parse(job.input)
      const first = input.turns[0].user[0].text === 'Most relevant turn'
      if (first) {
        assert.equal(memoryCompute.safeParse(job).success, true)
        assert(input.turns[0].assistant.endsWith('Full assistant text end'))
        assert(input.turns[0].assistant.length > 100_000)
      }
      return JSON.stringify({ status: 'write', title: 'Daily note', markdown: first ? beginning + ending : 'Periodic meeting' })
    },
  })
  defer(() => memory.close())
  const topic = { kind: 'conversation' as const, id: 'topic-a' }
  const contextualOrigin = { ...origin, context: topic }
  const first = randomUUID()
  memory.accept('Most relevant turn', contextualOrigin, first)
  memory.recordNoteTurn!(origin.session, [first], 'filler '.repeat(15_000) + 'Full assistant text end')
  await memory.wake()
  now += 86_400_000
  for (let i = 0; i < 65; i++) {
    const host = { ...contextualOrigin, session: `other-session-${i}` }
    const id = randomUUID()
    memory.accept('Ordinary periodic update', host, id)
    memory.recordNoteTurn!(host.session, [id], 'acknowledged')
  }
  await memory.wake()
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM memory_daily_notes').get()?.count, 66)
  const request = { op: 'recall' as const, session: origin.session, query: 'NEBULARHARBOR' }
  const recall = (extra = {}) => JSON.parse(memory.handle({ ...request, ...extra }, contextualOrigin))
  const result = recall()
  assert.equal(result.notes.length, 1)
  assert(result.notes[0].startLine > 1)
  assert.match(result.notes[0].markdown, /NEBULARHARBOR$/u)
  assert(result.notes[0].markdown.length > 1500)
  assert.deepEqual(memory.readFile({ kind: 'daily', workspace: result.notes[0].workspace, id: result.notes[0].id })?.sources.map(source => source.sourceId), [first])
  assert.deepEqual(recall({ start_date: '2026-11-02' }).notes, [])
  assert.deepEqual(recall({ min_score: 10_000 }).notes, [])
  assert.deepEqual(JSON.parse(memory.handle(request, { ...origin, context: { ...topic, id: 'topic-b' } })).notes, [])
  const limited = JSON.parse(memory.handle({ ...request, query: 'meeting', limit: 99 }, contextualOrigin))
  assert.ok(limited.notes.length > 0 && limited.notes.length <= 50)
  assert.equal(limited.partial, true, 'whole-file evidence packets retain their response budget')
})

test('document consolidation waits for semantic evidence review before checkpointing and retries structural errors once', async t => {
  const { dir, defer } = scratch(t, 'viva-dream-checkpoint-')
  let now = Date.parse('2026-11-06T13:59:00Z')
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => now)
  const completeExtraction = deferred<string>()
  const beganExtraction = deferred<void>()
  const fact = 'I submit the quarterly report on the first Friday'
  const id = randomUUID()
  let dreams = 0
  const memory = createMemoryRuntime({
    store, now: () => now, dailyNotes: { noteInterval: 1 },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(job, _signal, tools) {
      if (job.stage === 'note') return JSON.stringify({ status: 'write', title: 'Report', markdown: fact })
      assert.equal(job.stage, 'dream')
      if (job.system === DREAM_EXTRACT_SYSTEM) {
        const input = JSON.parse(job.input)
        assert.equal(input.maxUnits, 5)
        if (++dreams === 1) return '{"units": ['
        assert(input.retry)
      }
      if (job.system === DREAM_VERIFY_SYSTEM) {
        const input = JSON.parse(job.input) as { canonicalSources: Array<{ text: string }> }
        assert.equal(input.canonicalSources[0]?.text, fact)
        beganExtraction.resolve()
        await completeExtraction.promise
      }
      return dreamModelStep(job, tools, { summary: fact })
    },
  })
  defer(() => memory.close())
  memory.accept(fact, origin, id)
  memory.recordNoteTurn!(origin.session, [id], 'OK')
  await memory.wake()
  now = Date.parse('2026-11-06T15:00:00Z')
  const running = memory.wake()
  await beganExtraction.promise
  assert.equal(store.db.prepare('SELECT processed FROM memory_daily_notes').get()?.processed, 0)
  completeExtraction.resolve('{}')
  await running
  assert.equal(dreams, 2)
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memories'").get(), undefined)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, 1)
  const note = store.db.prepare('SELECT processed,revision FROM memory_daily_notes').get()!
  assert.equal(note.processed, note.revision)
})

test('consolidation groups the two-day window by byte budget, bisects transport failures and keeps oversized notes', async t => {
  const { dir, defer } = scratch(t, 'viva-dream-batches-')
  let now = Date.parse('2026-11-04T15:01:00Z')
  const requests: string[][] = []
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => now)
  const memory = createMemoryRuntime({
    store, now: () => now, dailyNotes: { noteInterval: 1 },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(job) {
      const input = JSON.parse(job.input)
      if (job.stage === 'note') {
        const title = input.turns[0].user[0].text
        const markdown = '城'.repeat(title === 'large note' ? 61_000 : 4_000)
        return JSON.stringify({ status: 'write', title, markdown })
      }
      assert.equal(job.stage, 'dream')
      const notes = input.notes as Array<{ title: string, markdown: string }>
      requests.push(notes.map(note => note.title))
      if (notes.length > 1) throw new Error('fake transport overflow')
      if (notes[0]?.title === 'large note') {
        assert.equal([...notes[0].markdown.replace(/\n\n\[truncated\]$/u, '')].length, 60_000)
        assert.match(notes[0].markdown, /\[truncated\]$/u)
      }
      return JSON.stringify({ units: [] })
    },
  })
  defer(() => memory.close())

  async function note(session: string, title: string) {
    const id = randomUUID()
    memory.accept(title, { ...origin, session }, id)
    memory.recordNoteTurn!(session, [id], 'OK')
    await memory.wake()
  }

  await note('old', 'old note')
  now += 2 * 86_400_000
  // Move past the old scheduled run before seeding notes in the rolling window.
  await memory.wake()
  requests.length = 0
  await note('a', 'note A')
  await note('b', 'note B')
  await note('c', 'note C')
  await note('z', 'large note')
  now = Date.parse('2026-11-07T15:00:00Z')
  await memory.wake()
  assert.deepEqual(requests, [['note A', 'note B', 'note C'], ['note A'], ['note B', 'note C'], ['note B'], ['note C'], ['large note']])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM memory_daily_notes WHERE processed=revision').get()?.count, 4)
})

test('a partial daily-note batch survives restart and can be written once', async t => {
  const { dir, defer } = scratch(t, 'viva-daily-memory-recovery-')
  const file = path.join(dir, 'memory.db')
  let modelCalls = 0
  const start = () => createMemoryRuntime({
    store: openMemoryStore(file), dailyNotes: true,
    now: () => Date.parse('2026-11-04T12:00:00Z'), timezone: () => 'UTC',
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(job) {
      assert.equal(job.stage, 'note')
      modelCalls += 1
      return JSON.stringify({ status: 'write', title: '原型验证', markdown: '用户在检查原型，今天还要补测试。' })
    },
  })
  const first = start()
  const [one, two] = [randomUUID(), randomUUID()]
  first.accept('今天我在检查原型', origin, one)
  first.recordNoteTurn!(origin.session, [one], '好的')
  first.accept('还要补一轮测试', origin, two)
  first.recordNoteTurn!(origin.session, [two], '明白')
  await first.wake()
  first.close()
  assert.equal(modelCalls, 0)

  const resumed = start()
  defer(() => resumed.close())
  await resumed.wake()
  assert.equal(modelCalls, 1)
  assert.throws(() => resumed.recordNoteTurn!(origin.session, [two], '重复的回合'), /memory-request-input-mismatch/)
  resumed.recordNoteTurn!(origin.session, [two], '明白')
  await resumed.wake()
  const recalled = JSON.parse(resumed.handle({ op: 'recall', session: origin.session, query: '原型' }, origin))
  assert.deepEqual(recalled.notes.map((note: { id: string, workspace: string }) => resumed.readFile({ kind: 'daily', workspace: note.workspace, id: note.id })?.sources.map(source => source.sourceId)), [[one, two]])
  assert.equal(modelCalls, 1)
})

test('a recovered completed turn uses message time in configured timezone, accepts empty assistant text, and is immediately searchable', async t => {
  const { dir, defer } = scratch(t, 'viva-note-message-date-')
  let now = Date.parse('2026-11-14T15:59:00Z')
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => now)
  const memory = createMemoryRuntime({ store, now: () => now, dailyNotes: { noteInterval: 1, timezone: 'Asia/Shanghai' },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(job) {
      if (job.stage !== 'note') return '{"units":[]}'
      const input = JSON.parse(job.input)
      assert.equal(input.turns[0].user[0].at, Date.parse('2026-11-14T15:59:00Z'))
      assert.equal(input.turns[0].user[0].author, 'user')
      assert.equal(input.turns[0].user[0].version, 1)
      assert.equal(input.turns[0].assistant, '')
      return JSON.stringify({ status: 'write', title: '历史回合', markdown: '我的发布核对日是周五' })
    },
  })
  defer(() => memory.close())
  const id = randomUUID()
  memory.accept('我的发布核对日是周五', origin, id)
  now += 2 * 86_400_000
  memory.recordNoteTurn!(origin.session, [id], '')
  await memory.wake()
  const note = store.db.prepare('SELECT day FROM memory_daily_notes').get()
  assert.equal(note?.day, '2026-11-14')
  const result = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '发布核对日' }, origin))
  assert.equal(result.notes.length, 1)
})

test('a malformed note response is retried and never counted as a successful skip', async t => {
  const { dir, defer } = scratch(t, 'viva-note-retry-')
  let now = Date.parse('2026-11-14T12:00:00Z'), attempts = 0
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => now)
  const memory = createMemoryRuntime({ store, now: () => now, dailyNotes: { noteInterval: 1 },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(job) {
      assert.equal(job.stage, 'note')
      return ++attempts === 1 ? '{"broken":true}' : '{"status":"skip"}'
    },
  })
  defer(() => memory.close())
  const id = randomUUID()
  memory.accept('普通寒暄', origin, id)
  memory.recordNoteTurn!(origin.session, [id], '你好')
  await memory.wake()
  assert.equal(store.db.prepare('SELECT written FROM memory_note_turns').get()?.written, 0)
  assert.equal(store.readSource(id)?.outcome, 'note-pending')
  now += 2000
  await memory.wake()
  assert.equal(attempts, 2)
  assert.equal(store.db.prepare('SELECT written FROM memory_note_turns').get()?.written, 2)
  assert.equal(store.readSource(id)?.outcome, 'note-skipped')
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_daily_notes').get()?.n, 0)
})

for (const extraction of ['partial', 'empty'] as const) test(`daily files retain full session evidence after ${extraction} document dream integration and accept the next turn`, async t => {
  const { dir, defer } = scratch(t, 'viva-note-extraction-retention-')
  let now = Date.parse('2026-11-14T12:00:00Z'), notesWritten = 0
  const sourceId = randomUUID(), fact = '我的周报每周五提交'
  const text = `${fact}。今天还在调试界面`
  const store = openMemoryStore(path.join(dir, 'memory.db'), () => now)
  const memory = createMemoryRuntime({ store, now: () => now, dailyNotes: { timezone: 'UTC', noteInterval: 1 },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(job, _signal, tools) {
      if (job.stage === 'note') {
        notesWritten++
        return JSON.stringify({ status: 'write', title: '周报安排', markdown: text })
      }
      assert.equal(job.stage, 'dream')
      return dreamModelStep(job, tools, { empty: extraction === 'empty', summary: fact, evidenceId: sourceId })
    },
  })
  defer(() => memory.close())
  memory.accept(text, origin, sourceId)
  memory.recordNoteTurn!(origin.session, [sourceId], '先保留今天的进度')
  await memory.wake()
  now = Date.parse('2026-11-14T23:00:00Z')
  await memory.wake()
  assert.equal(store.readSource(sourceId)?.text, text)
  assert.equal(store.readSource(sourceId)?.outcome, 'note-ready')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, extraction === 'empty' ? 0 : 1)
  const read = () => JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '调试界面' }, origin)) as { notes: { markdown: string }[] }
  assert.equal(read().notes[0]?.markdown, text)
  const next = randomUUID()
  memory.accept('补上封面', origin, next)
  memory.recordNoteTurn!(origin.session, [next], '好的')
  await memory.wake()
  assert.equal(notesWritten, 2)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_note_turns WHERE written=0').get()?.n, 0)
  assert.equal(read().notes[0]?.markdown, text)
})


test('recovery finishes a receipted note generation before processing the remaining batch with a new operation', async t => {
  const { dir, defer } = scratch(t, 'viva-note-receipt-effect-gap-')
  const file = path.join(dir, 'memory.db'), now = Date.parse('2026-11-14T12:00:00Z')
  const initial = openMemoryStore(file, () => now)
  const effects = createEffects({ db: initial.db, now: () => now })
  const notes = openMemoryNotes(initial, () => true)
  let key = ''
  for (let index = 0; index < 7; index++) {
    const source = noteSource(initial, { session: origin.session, conversation: origin.conversation, at: now, timezone: 'UTC' })
    key = notes.add(origin.session, '2026-11-14', [source], `第${index + 1}回合已完成`)!
  }
  effects.queue('memory.note', key, { flush: true })
  const job = effects.get('memory.note', key)!
  const first = notes.pending(key, 5)
  notes.commit(key, first, { status: 'write', title: '首批记录', markdown: '前五回合已整理' }, job.generation, now,
    notes.snapshot(first.flatMap(row => row.sourceIds)), undefined)
  assert.equal(notes.jobState(key, job.generation), 'done')
  assert.equal(notes.pending(key).length, 2)
  // Exact durable state after a crash between the receipt/checkpoint transaction and finishing the effect.
  effects.close()
  initial.close()
  const reopened = openMemoryStore(file, () => now)
  const computed: number[] = []
  const memory = createMemoryRuntime({ store: reopened, now: () => now, dailyNotes: { timezone: 'UTC', noteInterval: 5 },
    route: () => ({ provider: 'fake', model: 'fake' }), quiesce: async () => {}, changed: () => {},
    async compute(request) {
      assert.equal(request.stage, 'note')
      const input = JSON.parse(request.input) as { existing: { markdown: string }, turns: unknown[] }
      assert.equal(input.existing.markdown, '前五回合已整理')
      assert.equal(input.turns.length, 2)
      computed.push(request.generation)
      return JSON.stringify({ status: 'write', title: '全部记录', markdown: '七个回合均已整理' })
    },
  })
  defer(() => memory.close())
  await memory.wake()
  assert.equal(computed.length, 1)
  assert.notEqual(computed[0], job.generation)
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM memory_note_turns WHERE written=0').get()?.n, 0)
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM effects WHERE kind='memory.note'").get()?.n, 0)
  assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM memory_file_intents WHERE id LIKE 'notes:note:%' AND state='done'").get()?.n, 2)
})
