import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createMemoryHostEffects } from '../src/backend/memory-host-effects.ts'
import { APP_DB_PRAGMAS, transaction } from '../src/backend/app-db.ts'
import type { HostMemoryApi, HostMemoryCaller } from '../src/memory/contracts/host.ts'
import type { MemoryHostEffect } from '../src/memory/contracts/service.ts'

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
  const host = createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, invalidate() {},
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
  const openHost = () => createMemoryHostEffects({ db, call, eraseHistory: history.eraseMemoryCopies, invalidate() {},
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
