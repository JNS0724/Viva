import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openAppDb, transaction } from '../src/backend/app-db.ts'
import { createEffects } from '../src/backend/effects.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { memoryProjectScope } from '../src/backend/memory-project.ts'
import { createMemoryRuntime } from '../src/backend/memory-runtime.ts'
import { openMemoryStore } from '../src/backend/memory-store.ts'
import { createMemoryWithdrawal } from '../src/backend/memory-withdrawal.ts'
import { runToCrash } from './fixtures/memory-crash-process.ts'
import { extraction, memoryCrashCheckpoints, origin, text } from './fixtures/memory-intake-crash.ts'

const fixture = new URL('./fixtures/memory-intake-crash.ts', import.meta.url)

test('a pending rewind replacement keeps its original project association after Git changes', async t => {
  for (const scoped of [true, false]) await t.test(scoped ? 'Git directory recreated' : 'formerly unscoped directory gains Git', async t => {
    await recoverEditedSource(t, scoped)
  })
})

async function recoverEditedSource(t: import('node:test').TestContext, scoped: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'viva-memory-rewind-project-'))
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const cwd = join(directory, 'work')
  const git = join(cwd, '.git')
  function initGit() {
    mkdirSync(join(git, 'objects'), { recursive: true })
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
    const project = memoryProjectScope(cwd)
    assert.ok(project)
    return project
  }
  const project = scoped ? initGit() : undefined
  const firstId = randomUUID(), nextId = randomUUID(), oldSource = randomUUID(), newSource = randomUUID()
  const before = '项目构建要求为蓝色版本', revised = '项目构建要求为琥珀色版本'
  function open(crashBeforeWithdrawal = false) {
    const app = openAppDb({ file: join(directory, 'app.db') })
    const history = openHistoryDb({ db: app.db })
    const effects = createEffects({ db: app.db })
    const store = openMemoryStore(join(directory, 'memory.db'))
    const memory = createMemoryRuntime({ store, compute: () => null, route: () => null, quiesce: async () => {}, changed: () => {} })
    const withdrawal = createMemoryWithdrawal({ history: () => history, effects: () => effects,
      memory: () => ({ ...memory, withdraw(payload) {
        if (crashBeforeWithdrawal) throw new Error('stop after history commit')
        return memory.withdraw(payload)
      } }),
      apply: (_kind, _data, work) => ({ value: transaction(app.db, work) }), changing: async work => work(),
    })
    return { history, effects, store, memory, withdrawal, close() { memory.close(); effects.close(); app.close() } }
  }
  const first = open(true)
  try {
    const saved = first.history.save(first.history.create({ cwd, sessionId: firstId }), [{ role: 'user', text: before, sourceId: oldSource, receipt: null }])
    first.memory.recordSessionProject(firstId, project?.id ?? '')
    first.memory.accept(before, { conversation: saved.id, session: firstId, project }, oldSource)
    await assert.rejects(first.withdrawal.commitEdit({ oldSource, newSource, previous: saved }, () =>
      first.history.save(first.history.create({ cwd, sessionId: nextId, topicId: saved.topicId ?? saved.id }),
        [{ role: 'user', text: revised, sourceId: newSource, receipt: null }])), /stop after history commit/u)
    assert.equal(first.store.readSource(newSource), null)
    assert.ok(first.effects.get('memory.withdraw', newSource))
  } finally { first.close() }

  if (project) renameSync(git, join(cwd, 'previous-git'))
  const replacement = initGit()
  assert.notEqual(replacement.id, project?.id)
  const restarted = open()
  try {
    restarted.withdrawal.recover()
    assert.equal(restarted.effects.get('memory.withdraw', newSource), null)
    assert.equal(restarted.store.readSource(oldSource)?.withdrawn, true)
    assert.deepEqual(restarted.store.readSource(newSource)?.project, project ?? null)
    assert.equal(restarted.memory.sessionProject(nextId), project?.id ?? '')
    const source = { dependencies: [], sources: [newSource] }
    if (project) assert.equal(restarted.memory.projectAllows(source, replacement), false)
    assert.equal(restarted.memory.projectAllows(source, project), true)
  } finally { restarted.close() }
}

test('intake, acknowledgement and extraction recover at their transaction boundaries after process death', { timeout: 60_000 }, async t => {
  for (const checkpoint of memoryCrashCheckpoints) await t.test(checkpoint, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'viva-memory-recovery-'))
    const file = join(directory, 'memory.db')
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
    const id = randomUUID()
    const ack = await runToCrash(fixture, checkpoint, file, id)
    const intakeCommitted = checkpoint !== 'before-intake-commit'
    const acknowledged = intakeCommitted && checkpoint !== 'after-intake-commit'
    const resultCommitted = checkpoint === 'after-result-commit'
    assert.deepEqual(ack, acknowledged ? [JSON.stringify({ sourceId: id, outcome: 'pending' })] : [])

    const store = openMemoryStore(file)
    const generations: number[] = []
    const memory = createMemoryRuntime({ store,
      compute: async job => {
        if (job.stage !== 'extract') return '{"refs":[]}'
        assert.equal(job.sourceId, id)
        generations.push(job.generation)
        return extraction
      },
      route: () => ({ provider: 'fixture', model: 'fixture' }), quiesce: async () => {}, changed: () => {},
    })
    try {
      const pending = () => store.db.prepare("SELECT generation FROM effects WHERE kind='memory.extract' AND key=?").get(id)
      const held = pending()?.generation
      assert.equal(Boolean(held), intakeCommitted && !resultCommitted)
      assert.equal(store.readSource(id)?.outcome, resultCommitted ? 'accepted' : intakeCommitted ? 'pending' : undefined)
      assert.equal(memory.listMemories().total, Number(resultCommitted))

      await memory.wake()
      assert.equal(memory.listMemories().total, Number(intakeCommitted))
      assert.deepEqual(generations, held === undefined ? [] : [held])
      if (!intakeCommitted) assert.deepEqual(memory.accept(text, origin, id), { sourceId: id, outcome: 'pending' })
      await memory.wake()
      assert.deepEqual(memory.accept(text, origin, id), { sourceId: id, outcome: 'accepted' })
      await memory.wake()
      assert.equal(generations.length, resultCommitted ? 0 : 1)
      assert.equal(pending(), undefined)
      assert.equal(memory.listMemories().total, 1)
      const [entry] = memory.listMemories().items
      assert.equal(entry.text, text)
      assert.deepEqual(entry.evidence.map(edge => edge.sourceId), [id])
    } finally { memory.close() }
  })
})

test('memory deletion stops use immediately and confirms copy cleanup only after SQLite can checkpoint', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'viva-memory-cleanup-recovery-'))
  const file = join(directory, 'memory.db')
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const removed = '我的常喝饮品是燕麦拿铁'
  const surviving = '我的首选字体是 Inter'
  const words = `${removed} ${surviving}`
  const sourceId = randomUUID()
  const deletionId = randomUUID()
  const hasStoredText = (text: string) => [file, file + '-wal']
    .some(path => existsSync(path) && readFileSync(path).includes(Buffer.from(text)))
  let now = Date.now()
  const open = () => {
    const store = openMemoryStore(file, () => now)
    const memory = createMemoryRuntime({ store, now: () => now,
      route: () => ({ provider: 'fixture', model: 'fixture' }), quiesce: async () => {}, changed: () => {},
      compute: async () => JSON.stringify({ proposals: [removed, surviving].map(text => ({
        spans: [{ start: words.indexOf(text), end: words.indexOf(text) + text.length }],
        kind: 'preference', scope: 'user', modality: 'asserted', attribution: 'self', keywords: [],
      })) }),
    })
    return { store, memory }
  }
  const first = open()
  let deleted: { id: number, revision: number } | undefined
  try {
    first.memory.accept(words, origin, sourceId)
    await first.memory.wake()
    deleted = first.memory.listMemories().items.find(item => item.text === removed)
    assert.ok(deleted)
    assert.deepEqual(first.memory.listMemories().items.map(item => item.text).sort(), [removed, surviving].sort())
    const reader = new DatabaseSync(file, { readOnly: true })
    try {
      reader.exec('BEGIN')
      assert.equal(reader.prepare('SELECT text FROM memory_sources WHERE id=?').get(sourceId)?.text, words)
      assert.deepEqual(await first.memory.deleteMemory(deleted.id, deleted.revision, deletionId), { status: 'stopped' })
      assert.equal(first.memory.cleanupPending(), 1)
      assert.deepEqual(first.memory.listMemories().items.map(item => item.text), [surviving])
      assert.ok(first.store.sourceExcluded(sourceId))
      assert.equal(first.store.readSource(sourceId)?.text?.includes(removed), false)
      assert.equal(reader.prepare('SELECT text FROM memory_sources WHERE id=?').get(sourceId)?.text, words)
      assert.equal(hasStoredText(removed), true)
    } finally { reader.close() }
  } finally { first.memory.close() }

  assert.ok(deleted)
  now += 10 * 60_000
  const second = open()
  try {
    await second.memory.wake()
    assert.equal(second.memory.cleanupPending(), 0)
    assert.deepEqual(await second.memory.deleteMemory(deleted.id, deleted.revision, deletionId), { status: 'cleared' })
    assert.equal(second.store.get(deleted.id), null)
    assert.equal(second.store.readSource(sourceId)?.text?.includes(removed), false)
    assert.deepEqual(second.memory.listMemories().items.map(item => item.text), [surviving])
    assert.equal(second.memory.sourceCurrent(sourceId), false)
    assert.equal(hasStoredText(removed), false)
    assert.equal(hasStoredText(surviving), true)
  } finally { second.memory.close() }
})
