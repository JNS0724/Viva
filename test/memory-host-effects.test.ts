import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createMemoryHostEffects } from '../src/backend/memory-host-effects.ts'
import { APP_DB_PRAGMAS, transaction } from '../src/backend/app-db.ts'
import { createEffects, type Effect } from '../src/backend/effects.ts'
import { createReportRecords } from '../src/backend/report-records.ts'
import { REPORT, type ReportPayload } from '../src/backend/task-reports.ts'
import { openFeedStore } from '../src/backend/feed-store.ts'
import { createScheduleRuns, SCHEDULE_SOURCE } from '../src/backend/schedule-runs.ts'
import { openScheduleStore } from '../src/backend/schedule-store.ts'
import type { MemoryProvenance } from '../src/memory/contracts/provenance.ts'
import type { HostMemoryApi, HostMemoryCaller } from '../src/memory/contracts/host.ts'
import type { MemoryHostEffect, MemoryHostErasureRange } from '../src/memory/contracts/service.ts'
import { t as translate } from '../src/shared/i18n/translate.ts'

test('host erasure preserves unrelated original messages, rejects stale-save resurrection, retries ack without echo', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec(APP_DB_PRAGMAS)
  const history = openHistoryDb({ db })
  const sourceId = randomUUID(), unrelated = randomUUID(), session = randomUUID()
  const original = [{ role: 'user' as const, text: '敏感旧原文', sourceId, receipt: null },
    { role: 'assistant' as const, text: '依赖旧原文的回答', receipt: null },
    { role: 'user' as const, text: '独立的新问题', sourceId: unrelated, receipt: null },
    { role: 'user' as const, text: '模型生成的任务简述', receipt: null }]
  const conversation = history.save(history.create({ sessionId: session }), original)
  db.exec('CREATE TABLE background_tasks (id TEXT PRIMARY KEY, task TEXT NOT NULL)')
  db.prepare('INSERT INTO background_tasks VALUES (?,?)').run(session, JSON.stringify({ id: session, words: '模型生成的任务简述' }))
  const effect: MemoryHostEffect = { effectId: randomUUID(), causeOperationId: randomUUID(), revision: 8, hostNamespace: 'viva',
    kind: 'erase-copies', sources: [{ namespace: 'viva', sourceId, revision: 1 }], sessions: [session], memoryIds: [3] }
  const methods: string[] = [], mutations: string[] = []
  let pending = true, failAck = true
  const call: HostMemoryCaller = async (method, input) => {
    methods.push(method)
    let result: unknown
    if (method === 'pendingHostEffects') result = pending ? [effect] : []
    else if (method === 'ackHostEffect') {
      assert.equal((input as HostMemoryApi['ackHostEffect']['input']).causeOperationId, effect.causeOperationId)
      if (failAck) { failAck = false; throw new Error('lost ack') }
      pending = false; result = { accepted: true }
    } else assert.fail(`Unexpected outbound operation ${method}`)
    return result as HostMemoryApi[typeof method]['output']
  }
  const host = createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges, invalidate() {},
    apply: (kind, _data, write) => { mutations.push(kind); return { value: transaction(db, write) } } })
  t.after(() => host.close())
  await assert.rejects(host.recover(), /lost ack/)
  assert.deepEqual(history.get(conversation.id)?.messages.map(row => row.text), ['', '', '独立的新问题', ''])
  history.save(conversation, original)
  assert.deepEqual(history.get(conversation.id)?.messages.map(row => row.text), ['', '', '独立的新问题', ''], 'renderer replay cannot restore erased copies')
  await host.recover()
  assert.equal(mutations.length, 1)
  assert.equal(methods.includes('prepareSourceChange'), false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_host_receipts').get()?.n, 1)
  assert.equal(history.searchMessages('敏感').length, 0)
  assert.equal(history.search('敏感').length, 0, 'stale save cannot recreate erased text in automatic title')
})

test('foreground answers keep per-card sources so forgetting the second preserves the first', async t => {
  const { createQuestionDesk } = await import('../src/backend/question-channel.ts')
  const { decodeAgentEvent } = await import('../src/renderer/agent-event-decoder.ts')
  const { initialState, reduce } = await import('../src/renderer/state.ts')
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const history = openHistoryDb({ db }), session = randomUUID()
  const conversation = history.create({ sessionId: session })
  const first = randomUUID(), second = randomUUID()
  const cards = [{ id: 'first', question: '第一条资料？', header: '', options: [], multiSelect: false }, { id: 'second', question: '第二条资料？', header: '', options: [], multiSelect: false }]
  let state = reduce(initialState, { type: 'question_request', questionId: 'cards', questions: cards, at: 1 })
  const desk = createQuestionDesk({ sessionId: () => session, send() {},
    conversationContext: () => ({ conversationId: conversation.id, sessionId: session }),
    onAnswer: () => ({ sourceIds: { first, second } }),
    emit: raw => {
      const event = decodeAgentEvent(raw)
      if (event?.type === 'question_answered') state = reduce(state, { ...event, at: 2 })
    },
  })
  await desk.receive({ type: 'question', id: 'cards', sessionId: session, questions: cards })
  assert.equal(await desk.answer('cards', [{ id: 'first', selected: [], custom: '保留的独立资料' }, { id: 'second', selected: [], custom: '需要遗忘的资料' }]), true)
  history.save(conversation, state.messages)
  assert.deepEqual(history.get(conversation.id)?.messages.map(row => row.sourceId), [first, second])
  history.eraseMemoryCopies([second], [session])
  history.save(conversation, state.messages) // Even a stale renderer save cannot restore the forgotten card.
  assert.deepEqual(history.get(conversation.id)?.messages.map(row => row.text), ['保留的独立资料', ''])
  assert.equal(history.searchMessages('需要遗忘').length, 0)
})

test('host erasure waits for the WAL and replays only the acknowledgement after restart', async t => {
  const { dir } = scratch(t, 'memory-host-erase-wal-')
  const path = join(dir, 'host.db'), db = new DatabaseSync(path)
  db.exec(APP_DB_PRAGMAS)
  const history = openHistoryDb({ db }), sourceId = randomUUID()
  const marker = 'Native history replica of the selected item'
  const effect: MemoryHostEffect = { effectId: randomUUID(), causeOperationId: randomUUID(), revision: 9,
    hostNamespace: 'viva', kind: 'erase-copies', sources: [{ namespace: 'canonical', sourceId, revision: 1 }] }
  let pending = true, applications = 0
  const call: HostMemoryCaller = async method => {
    if (method === 'pendingHostEffects') return (pending ? [effect] : []) as HostMemoryApi[typeof method]['output']
    assert.equal(method, 'ackHostEffect')
    assert.equal(readFileSync(path + '-wal').includes(Buffer.from(marker)), false)
    pending = false
    return { accepted: true } as HostMemoryApi[typeof method]['output']
  }
  const openHost = () => createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges, invalidate() {},
    apply: (_kind, _data, write) => { applications++; return { value: transaction(db, write) } } })
  const host = openHost(), reader = new DatabaseSync(path)
  let reopened: ReturnType<typeof openHost> | undefined
  try {
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM messages').get()
    history.save(history.create({ sessionId: randomUUID() }), [{ role: 'user', text: marker, sourceId, receipt: null }])
    await assert.rejects(host.recover(), /pending a durable checkpoint/)
    assert.equal(history.searchMessages(marker).length, 0)
    assert(readFileSync(path + '-wal').includes(Buffer.from(marker)))
    assert.equal(pending, true)
    host.close()
    reader.exec('COMMIT')
    reopened = openHost()
    await reopened.recover()
    assert.equal(pending, false)
    assert.equal(applications, 1)
  } finally { host.close(); reopened?.close(); reader.close(); db.close() }
})

function range(sourceId: string, revision: number, text: string, selection: string): MemoryHostErasureRange {
  const start = text.indexOf(selection), end = start + selection.length
  assert(start >= 0)
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  return { sourceId, revision, length: text.length, hash: digest(text),
    afterHash: digest(text.slice(0, start) + ' '.repeat(selection.length) + text.slice(end)), spans: [{ start, end }] }
}

test('consecutive source cuts keep direct and formatted history, stars, and unrelated text across stale saves and reopening', t => {
  const { dir } = scratch(t, 'memory-range-history-')
  const file = join(dir, 'host.db'), sourceId = randomUUID()
  const history = openHistoryDb({ file })
  const first = 'qxz🚲', second = 'zqw contract', independent = 'Keep separate plans'
  const original = `${first}\r\n${second}\n${independent}`
  const one = original.replace(first, ' '.repeat(first.length)), both = one.replace(second, ' '.repeat(second.length))
  const a = range(sourceId, 1, original, first), b = range(sourceId, 2, one, second)
  const row = { role: 'user' as const, sourceId, key: 'first-user', text: original }
  const choices = '保留选择、'
  const direct = history.save(history.create({ sessionId: randomUUID() }), [row, { role: 'assistant', text: 'Independent answer' }])
  const formatted = history.save(history.create({ sessionId: randomUUID() }), [{ ...row, text: choices + original }])
  assert(history.setStar(direct.id, 0, true))
  history.eraseFileRanges([a])
  assert.deepEqual(history.get(direct.id)?.messages.map(({ text }) => text), [one, 'Independent answer'])
  assert.deepEqual(history.get(formatted.id)?.messages.map(({ text }) => text), [choices + one])
  assert.equal(history.searchMessages('qxz').length, 0)
  assert.equal(history.search('qxz').length, 0)
  history.eraseFileRanges([b])
  history.eraseFileRanges([a])
  history.close()

  const reopened = openHistoryDb({ file }); t.after(() => reopened.close())
  reopened.save(direct, [{ ...row, sourceId: undefined }, { role: 'assistant', text: 'Independent answer' }])
  reopened.save(formatted, [{ ...row, text: choices + one }])
  const fork = reopened.save(reopened.create({ sessionId: randomUUID() }), [{ ...row, sourceId: undefined, key: undefined }],
    { copy: { from: direct.id, count: 1 } })
  assert.deepEqual(reopened.get(direct.id)?.messages.map(({ text, sourceId }) => [text, sourceId]), [[both, sourceId], ['Independent answer', undefined]])
  assert.equal(reopened.get(formatted.id)?.messages[0]?.text, choices + both)
  assert.equal(reopened.get(fork.id)?.messages[0]?.text, both)
  assert.equal(reopened.get(fork.id)?.messages[0]?.sourceId, sourceId)
  assert.equal(reopened.starredMessages().length, 1)
  assert.equal(reopened.searchMessages('zqw').length, 0)
  assert.equal(reopened.searchMessages(independent).length, 3)
  reopened.save(direct, [{ role: 'user', text: 'Another question' }, { role: 'user', text: original }])
  assert.equal(reopened.get(direct.id)?.messages[1]?.text, both, 'a shifted source-less row from the same history cannot replay erased text')
  reopened.save(direct, [{ ...row, sourceId: randomUUID() }])
  assert.equal(reopened.get(direct.id)?.messages[0]?.text, original, 'distinct admitted input is scoped to its own identity')
  reopened.save(direct, [row])
  const inspection = new DatabaseSync(file); t.after(() => inspection.close())
  for (const { block } of inspection.prepare('SELECT block FROM messages_fts_data').all()) {
    const bytes = Buffer.from(block as Uint8Array)
    assert.equal(bytes.includes(Buffer.from('qxz')), false)
    assert.equal(bytes.includes(Buffer.from('zqw')), false)
  }
})

test('range erasure rolls back on an unrecognized live replica and still fences late first saves', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const history = openHistoryDb({ db }), sourceId = randomUUID(), lateId = randomUUID()
  const original = 'erase this piece then retain remaining'
  const cut = range(sourceId, 1, original, 'erase this piece')
  assert.throws(() => history.eraseFileRanges([{ ...cut, spans: [{ start: 0, end: original.length + 1 }] }]))
  const row = { role: 'user' as const, sourceId, text: original }
  const known = history.save(history.create(), [row])
  const unexpected = history.save(history.create(), [{ ...row, text: `unexpected formatting ${original} trailing text` }])
  assert.throws(() => history.eraseFileRanges([cut]), /no matching erasure proof/)
  assert.equal(history.get(known.id)?.messages[0]?.text, original)
  assert.equal(history.get(unexpected.id)?.messages[0]?.text, `unexpected formatting ${original} trailing text`)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_erased_source_ranges').get()?.n, 0)
  history.eraseFileRanges([{ ...cut, sourceId: lateId }])
  const late = history.save(history.create(), [{ ...row, sourceId: lateId }])
  assert.equal(history.get(late.id)?.messages[0]?.text, original.replace('erase this piece', ' '.repeat(16)))
  history.save(late, [{ ...row, sourceId: lateId, text: 'unrecognized stale text' }])
  assert.match(history.get(late.id)!.messages[0].text, /^\s+then retain remaining$/)
})

test('durable history range cleanup retains the host effect for the remaining copies', async t => {
  const { dir } = scratch(t, 'memory-host-ranges-wal-')
  const path = join(dir, 'host.db'), db = new DatabaseSync(path)
  db.exec(APP_DB_PRAGMAS)
  const history = openHistoryDb({ db }), sourceId = randomUUID(), reader = new DatabaseSync(path)
  const marker = 'secret range phrase', original = `${marker} and retained history`
  const effect: MemoryHostEffect = { effectId: randomUUID(), causeOperationId: randomUUID(), revision: 9,
    hostNamespace: 'viva', kind: 'erase-file-copies', sources: [{ namespace: 'canonical', sourceId, revision: 1 }],
    ranges: [range(sourceId, 1, original, marker)] }
  const call: HostMemoryCaller = async method => {
    assert.equal(method, 'pendingHostEffects', 'the host must not confirm outstanding derived and native copies')
    return [effect] as HostMemoryApi[typeof method]['output']
  }
  const openHost = () => createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges,
    invalidate() {}, apply: (_kind, _data, write) => ({ value: transaction(db, write) }) })
  const first = openHost()
  let restarted: ReturnType<typeof openHost> | undefined
  try {
    reader.exec('BEGIN'); reader.prepare('SELECT count(*) FROM messages').get()
    history.save(history.create(), [{ role: 'user', sourceId, text: original }])
    await assert.rejects(first.recover(), /pending a durable checkpoint/)
    assert.equal(history.searchMessages(marker).length, 0)
    assert.equal(history.searchMessages('retained history').length, 1)
    assert(readFileSync(path + '-wal').includes(Buffer.from(marker)))
    first.close()
    reader.exec('COMMIT')
    restarted = openHost()
    await restarted.recover()
    assert.equal(readFileSync(path + '-wal').includes(Buffer.from(marker)), false)
    assert.equal(readFileSync(path).includes(Buffer.from(marker)), false)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_erased_source_ranges').get()?.n, 1)
  } finally { first.close(); restarted?.close(); reader.close(); db.close() }
})

test('one unverifiable source does not starve later independent host effects', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec(APP_DB_PRAGMAS)
  const history = openHistoryDb({ db }), bad = randomUUID(), good = randomUUID()
  const badRow = history.save(history.create(), [{ role: 'user', sourceId: bad, text: 'Unverified representation' }])
  const text = 'Erase this part. Retain the rest.'
  const goodRow = history.save(history.create(), [{ role: 'user', sourceId: good, text }])
  const a = range(bad, 1, text, 'Erase this part.'), b = range(good, 1, text, 'Erase this part.')
  const base = (revision: number) => ({ effectId: randomUUID(), causeOperationId: randomUUID(), revision, hostNamespace: 'viva', sources: [] })
  const invalidation: MemoryHostEffect = { ...base(11), kind: 'invalidate-context' }
  const effects: MemoryHostEffect[] = [
    { ...base(9), kind: 'erase-file-copies', ranges: [a] },
    { ...base(10), kind: 'erase-file-copies', ranges: [b] },
    invalidation,
  ]
  const acknowledged: string[] = []
  const call: HostMemoryCaller = async (method, input) => {
    if (method === 'pendingHostEffects') return effects as HostMemoryApi[typeof method]['output']
    assert.equal(method, 'ackHostEffect')
    acknowledged.push((input as HostMemoryApi['ackHostEffect']['input']).effectId)
    return { accepted: true } as HostMemoryApi[typeof method]['output']
  }
  const host = createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges,
    invalidate() {}, apply: (_kind, _data, write) => ({ value: transaction(db, write) }) })
  t.after(() => host.close())
  await assert.rejects(host.recover(), /no matching erasure proof/)
  assert.deepEqual(acknowledged, [invalidation.effectId])
  assert.equal(history.get(badRow.id)?.messages[0]?.text, 'Unverified representation')
  assert.equal(history.get(goodRow.id)?.messages[0]?.text.trim(), 'Retain the rest.')
})

test('file forgetting physically removes affected schedules, run inputs and feed items without touching a disjoint historical file', async t => {
  const { dir } = scratch(t, 'memory-derived-erase-')
  const path = join(dir, 'app.db'), db = new DatabaseSync(path)
  t.after(() => db.close())
  db.exec(APP_DB_PRAGMAS)
  const history = openHistoryDb({ db }), effects = createEffects({ db }), feed = openFeedStore({ db })
  const now = Date.parse('2026-11-06T10:00:00+08:00'), store = openScheduleStore({ db, now: () => now })
  const runner = createScheduleRuns({ db, store, feed, now: () => now,
    async run() { return { ok: true, text: '' } }, keep() {}, delivered() {} })
  t.after(() => runner.close())
  const sourceId = randomUUID(), text = 'erase report, keep tea'
  const a = range(sourceId, 1, text, 'erase report')
  const base: MemoryProvenance = { dependencies: [], sources: [sourceId], turnOnly: false, epoch: 0 }
  const file = (id: string, start: number, end: number): MemoryProvenance => ({ ...base, fileSources: [sourceId], files: [{
    id, workspace: 'a'.repeat(64), path: `digest/wiki/${id}.md`, revision: 'historical-revision', usageVersion: 1, policyToken: 'historical-policy',
    sourceRanges: [{ sourceId, spans: [{ start, end }] }],
  }] })
  const affected = file('report', 0, 12), independent = file('tea', 14, text.length)
  const rule = { kind: 'at' as const, at: '2026-11-06T11:00:00+08:00' }
  const scheduleA = store.create({ title: 'Affected', prompt: 'Erase report', cwd: '/w', rule, memory: affected })
  const scheduleB = store.create({ title: 'Independent', prompt: 'Keep tea', cwd: '/w', rule, memory: independent })
  const queue = db.prepare(`INSERT INTO schedule_runs(key,schedule_id,at,title,prompt,cwd,due_at,memory,schedule_revision) VALUES (?,?,?,?,?,?,?,?,?)`)
  queue.run('old-a', scheduleA.id, rule.at, 'Old A', 'Erase report', '/w', now, JSON.stringify(affected), 0)
  queue.run('historical-a', scheduleB.id, rule.at, 'Historical A', 'Erase report', '/w', now, JSON.stringify(affected), 0)
  queue.run('current-b', scheduleB.id, rule.at, 'Current B', 'Keep tea', '/w', now, JSON.stringify(independent), 0)
  const derived = (key: string, memory: MemoryProvenance) => {
    const { item } = feed.add({ source: SCHEDULE_SOURCE, key, title: key, body: key, memory, origin: { label: 'Test', ref: scheduleB.id } })
    effects.queue('feed-notice', item.id, { text: key })
    return item.id
  }
  const raw = derived('Raw source result', base), related = derived('File A result', affected), retained = derived('File B result', independent)
  const invalidatedFeed: string[][] = []
  const effect: MemoryHostEffect = { kind: 'erase-file-copies', effectId: randomUUID(), causeOperationId: randomUUID(), revision: 10,
    sources: [{ namespace: 'canonical', sourceId, revision: 1 }], ranges: [a], hostNamespace: 'viva' }
  const call: HostMemoryCaller = async method => {
    assert.equal(method, 'pendingHostEffects')
    return [effect] as HostMemoryApi[typeof method]['output']
  }
  const host = createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges,
    invalidate() {}, feedCopiesRemoved(ids) { invalidatedFeed.push([...ids].sort()) },
    apply: (_kind, _data, write) => ({ value: transaction(db, write) }) })
  t.after(() => { host.close(); effects.close() })
  await host.recover()
  assert.deepEqual(invalidatedFeed, [[raw, related].sort()], 'only proved erased results are invalidated once')
  await host.recover()
  assert.equal(invalidatedFeed.length, 1)
  assert.equal(store.get(scheduleA.id), null)
  assert.equal(store.get(scheduleB.id)?.record.prompt, 'Keep tea')
  assert.deepEqual(db.prepare('SELECT key FROM schedule_runs').all().map(row => row.key), ['current-b'])
  assert.deepEqual(feed.list().map(item => item.id), [retained])
  assert.equal(effects.get('feed-notice', raw), null)
  assert.equal(effects.get('feed-notice', related), null)
  assert(effects.get('feed-notice', retained))
  assert.throws(() => derived('Raw source result', base), { message: translate('main.feed.erased') })
  for (const file of [path, path + '-wal']) {
    const bytes = readFileSync(file)
    for (const erased of ['Raw source result', 'File A result', 'Erase report']) assert.equal(bytes.includes(Buffer.from(erased)), false)
  }
})

test('feed erasure replays exact durable identities after a failed volatile notification', async t => {
  const { dir } = scratch(t, 'memory-feed-retry-')
  const db = new DatabaseSync(join(dir, 'app.db'))
  t.after(() => db.close())
  db.exec(APP_DB_PRAGMAS)
  const history = openHistoryDb({ db }), feed = openFeedStore({ db })
  const sourceId = randomUUID(), text = 'private source'
  const proof: MemoryProvenance = { sources: [sourceId], dependencies: [], turnOnly: false, epoch: 0 }
  const secret = feed.add({ source: 'schedule', key: 'same body', title: 'title', body: 'same body', memory: proof, origin: { label: 'run' } }).item
  const independent = feed.add({ source: 'mail', key: 'same body', title: 'title', body: 'same body', origin: { label: 'mail' } }).item
  const effect: MemoryHostEffect = { kind: 'erase-file-copies', effectId: randomUUID(), causeOperationId: randomUUID(), revision: 1,
    hostNamespace: 'viva', sources: [], ranges: [range(sourceId, 1, text, text)] }
  const call: HostMemoryCaller = async method => {
    assert.equal(method, 'pendingHostEffects')
    return [effect] as HostMemoryApi[typeof method]['output']
  }
  let fail = true
  const notices: string[][] = []
  const host = createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges,
    apply: (_kind, _data, work) => ({ value: transaction(db, work) }), invalidate() {},
    feedCopiesRemoved(ids) { if (fail) throw new Error('window stream unavailable'); notices.push([...ids]) } })
  t.after(() => host.close())
  await assert.rejects(host.recover(), /window stream unavailable/)
  assert.deepEqual(feed.list().map(item => item.id), [independent.id])
  fail = false
  await host.recover()
  assert.deepEqual(notices, [[secret.id]])
  assert.equal(feed.continuationCurrent(feed.continuation(independent.id)!), true)
})

test('saved reports retain proof across conversations and erase only the exact affected runs', async t => {
  const { dir } = scratch(t, 'memory-report-erase-scope-')
  const path = join(dir, 'app.db'), db = new DatabaseSync(path)
  db.exec(APP_DB_PRAGMAS)
  const history = openHistoryDb({ db }), effects = createEffects({ db }), sourceId = randomUUID()
  const here = history.save(history.create({ sessionId: randomUUID() }), [{ role: 'user', text: 'Independent recipient conversation' }])
  const apply: Parameters<typeof createMemoryHostEffects>[0]['apply'] = (_kind, _data, write) => ({ value: transaction(db, write) })
  const shown: string[] = [], removed: string[] = []
  const records = createReportRecords({ history: () => history, effects: () => effects, current: () => here, apply,
    show: item => { shown.push(item.reportId) } })
  const secret = 'The private report body', retained = 'The retained independent report', original = `${secret} then ${retained}`
  const provenance = (start: number, end: number): MemoryProvenance => ({ dependencies: [], epoch: 0, turnOnly: false,
    sources: [sourceId], fileSources: [sourceId], files: [{ workspace: 'f'.repeat(64), id: `doc-${start}`, path: 'digest/wiki/notes.md',
      revision: 'read-before-rebuild', usageVersion: 2, policyToken: `proof-${start}`,
      sourceRanges: [{ sourceId, spans: [{ start, end }] }] }] })
  const afflicted = provenance(0, secret.length), independent = provenance(secret.length + 6, original.length)
  const id = (run: string) => `same-task:${run}`
  const queue = (runId: string, output: string, memory: MemoryProvenance) => {
    const report: ReportPayload = { taskId: 'same-task', runId, title: 'Report', status: 'done', host: null,
      output, memory, deliveredTo: here.sessionId }
    effects.queue(REPORT, id(runId), report)
    return effects.get(REPORT, id(runId)) as Effect<ReportPayload>
  }
  records.read(queue('independent', retained, independent))
  const caught = queue('read', secret, afflicted)
  records.read(caught)
  const moved = history.save(history.create({ sessionId: randomUUID() }), [{ role: 'user', text: 'Folded recipient timeline' }])
  assert.equal(history.moveRecords({ from: here.id, to: moved.id, upTo: 1 }), 2)
  const waiting = queue('queued', secret, afflicted)
  const clean = queue('other-queued', retained, independent)
  records.written(waiting)
  const exposed = queue('shown-only', secret, afflicted)
  records.written(exposed)
  effects.cancel(REPORT, exposed.key)
  const erasure: MemoryHostEffect = { kind: 'erase-file-copies', hostNamespace: 'viva', effectId: randomUUID(), causeOperationId: randomUUID(), revision: 2,
    ranges: [range(sourceId, 1, original, secret)], sources: [{ namespace: 'canonical', sourceId, revision: 1 }] }
  const call: HostMemoryCaller = async method => {
    assert.equal(method, 'pendingHostEffects')
    return [erasure] as HostMemoryApi[typeof method]['output']
  }
  const host = createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, eraseFileHistory: history.eraseFileRanges,
    reportsRemoved: ids => removed.push(...ids), invalidate() {}, apply })
  try {
    await host.recover()
    await host.recover()
    assert.deepEqual(history.recordsOf(moved.id).map(row => row.reportId), [id('independent')])
    assert(effects.holds(clean))
    assert.deepEqual(new Set(removed), new Set([id('read'), id('queued'), id('shown-only')]))
    assert.equal(removed.length, 3, 'recovery does not repeat renderer invalidation')
    records.read(waiting)
    const late = queue('late', secret, afflicted)
    records.written(late)
    records.read(late)
    assert(!shown.includes(late.key))
    assert.equal(history.hasRecord(late.key), false)
    await host.recover()
    for (const file of [path, path + '-wal']) {
      assert.equal(readFileSync(file).includes(Buffer.from(secret)), false)
    }
  } finally { host.close(); effects.close(); db.close() }
})
