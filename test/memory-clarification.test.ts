import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createMemoryRuntime } from '../src/backend/memory-runtime.ts'
import { localDay } from '../src/backend/memory-facts.ts'
import { memoryHash, openMemoryStore } from '../src/backend/memory-store.ts'
import { createQuestionDesk } from '../src/backend/question-channel.ts'
import { MEMORY_QUESTION_PREFIX, memoryClarificationResult } from '../src/shared/memory-contract.ts'
import type { MemoryInterval } from '../src/backend/memory-intervals.ts'
import type { MemoryScope } from '../src/shared/memory-contract.ts'
import type { MemoryCompute } from '../src/shared/memory-contract.ts'

const at = Date.parse('2026-11-14T12:00:00Z')
const since = at - 10_000
const open = { from: since, to: null }
const user = { kind: 'user' } as const
const session = 'main'
const foreground = { session, conversation: 'weekly-report', foregroundTurn: 'prompt-1' }
const amber = '我的周报提交邮箱是 amber@example.com'
const jade = '我唯一的周报提交邮箱是 jade@example.com'
type Recalled = {
  partial: boolean,
  reasons: string[],
  memories: { id: number, windows: MemoryInterval[] }[],
  conflicts: {
    ref?: string,
    scope: MemoryScope,
    windows: MemoryInterval[],
    evidence: { text: string }[],
    sides: { id: number, evidence: { text: string }[] }[],
  }[],
}

function fixture(t: TestContext, compute?: (job: MemoryCompute) => Promise<string> | null) {
  const dir = mkdtempSync(join(tmpdir(), 'viva-memory-clarification-'))
  const store = openMemoryStore(join(dir, 'memory.db'), () => at)
  const memory = createMemoryRuntime({
    store, route: () => compute ? { provider: 'fake', model: 'fake' } : null,
    compute: compute ?? (() => null), quiesce: async () => {}, changed: () => {}, now: () => at,
  })
  t.after(() => { memory.close(); rmSync(dir, { recursive: true, force: true }) })
  function add(text: string, scope: MemoryScope = user, interval: MemoryInterval = open, updatedAt = since) {
    const sourceId = randomUUID()
    const source = {
      id: sourceId, operation: sourceId, version: 1, conversation: sourceId, session, scope, context: null,
      author: 'user' as const, text, hash: memoryHash(text), length: text.length, question: null, requestId: null,
      questionId: null, at: since, timezone: 'UTC', outcome: 'accepted', withdrawn: false,
    }
    store.insertSource(source)
    const id = store.insert({
      text, scope, kind: 'fact', source: 'agent', modality: 'asserted', conditional: false, keywords: [],
      conversationId: source.conversation,
    }, store.nextRevision(), updatedAt, interval)
    store.evidence(id, source, 0, text.length, null, null, interval, [{ start: 0, end: text.length }])
    return { id, source, text }
  }
  function dispute(first: ReturnType<typeof add>, second: ReturnType<typeof add>, interval: MemoryInterval = open) {
    return store.recordChange({
      kind: 'possible_conflict', targetId: first.id, replacementId: second.id, sourceId: second.source.id, sourceVersion: 1,
      spans: [{ start: 0, end: second.text.length }], ...interval, intentFrom: interval.from, intentTo: interval.to,
      derivedFrom: null, effectiveAt: null, revision: store.nextRevision(),
      createdAt: at, automatic: false,
    })
  }
  const read = (origin: Parameters<typeof memory.handle>[1] = foreground, query = '周报提交邮箱', asOf?: string) =>
    JSON.parse(memory.handle({ op: 'recall', session: origin.session ?? session, query, asOf }, origin)) as Recalled
  const ask = (ref: string, origin: Parameters<typeof memory.handle>[1] = foreground) =>
    memoryClarificationResult.parse(JSON.parse(memory.handle({ op: 'clarify', session: origin.session ?? session, ref }, origin)))
  return { memory, store, add, dispute, read, ask }
}

test('recall provides complete authorized pairs, their actual overlap and exact evidence', t => {
  const { add, dispute, read } = fixture(t)
  const a = add(amber, user, { from: since, to: at + 10_000 })
  const b = add(jade, user, { from: since + 5_000, to: at + 20_000 })
  dispute(a, b)
  const project = { kind: 'project', id: 'private' } as const
  dispute(add(amber, project), add(jade, project))
  const result = read()
  assert.deepEqual(result.memories, [])
  assert.equal(result.conflicts.length, 1)
  const [conflict] = result.conflicts
  assert.deepEqual(conflict.scope, user)
  assert.deepEqual(conflict.windows, [{ from: since + 5_000, to: at + 10_000 }])
  assert.deepEqual(conflict.sides.map(side => side.evidence[0].text), [amber, jade])
  assert.equal(conflict.evidence[0].text, jade)
  assert.ok(conflict.ref)
})

test('a bounded conflict result keeps the directly matching side and reports omitted pairs', t => {
  const { add, dispute, read } = fixture(t)
  const central = add(amber)
  for (let index = 1; index <= 11; index++) {
    dispute(central, add(`我的工作地址是 peer${index}@example.com`, user, open, since + index))
  }
  const result = read()
  assert.equal(result.conflicts.length, 5)
  assert.ok(result.conflicts.every(conflict => conflict.sides[0].id === central.id && conflict.sides.length === 2))
  assert.equal(result.partial, true)
  assert.ok(result.reasons.includes('dispute-limit'))
})

test('dated recall retains undisputed hours on either side of the conflict', t => {
  const { add, dispute, read } = fixture(t)
  const day = '2026-11-14'
  const start = localDay(day, Intl.DateTimeFormat().resolvedOptions().timeZone)!
  const nine = start + 9 * 3_600_000
  const noon = start + 12 * 3_600_000
  const a = add(amber, user, { from: start, to: noon })
  const b = add(jade, user, { from: nine, to: null })
  dispute(a, b, { from: nine, to: noon })
  const result = read(foreground, '周报提交邮箱', day)
  assert.deepEqual(result.conflicts[0].windows, [{ from: nine, to: noon }])
  assert.deepEqual(result.memories.map(({ id, windows }) => ({ id, windows })).sort((left, right) => left.id - right.id), [
    { id: a.id, windows: [{ from: start, to: nine }] },
    { id: b.id, windows: [{ from: noon, to: null }] },
  ])
})

test('dispatch expires at the start of a scheduled dispute for a used fact or source', t => {
  const { memory, store, add, dispute } = fixture(t)
  const start = at + 60_000
  const a = add(amber)
  const b = add(jade, user, { from: start, to: null })
  dispute(a, b, { from: start, to: null })
  const revision = store.get(a.id)!.revision
  assert.equal(memory.dispatchDeadline([{ id: a.id, revision }], [], at), start)
  assert.equal(memory.dispatchDeadline([], [a.source.id], at), start)
  assert.equal(memory.dispatchDeadline([{ id: a.id, revision, asOf: '2026-11-13' }], [], at), null)
  assert.equal(memory.dependenciesCurrent([{ id: a.id, revision }], start - 1), true)
  assert.equal(memory.dependenciesCurrent([{ id: a.id, revision }], start), false)
})

test('the desk admits a current foreground ticket once and discards stale answers', t => {
  const { memory, add, dispute, read, ask } = fixture(t)
  const a = add(amber)
  const b = add(jade)
  dispute(a, b)
  const [conflict] = read().conflicts
  assert.ok(conflict.ref)
  const background = { session: 'task', conversation: 'task', context: { kind: 'task', id: 'task' } as const }
  assert.equal(read(background).conflicts[0].ref, undefined)
  assert.deepEqual(ask(conflict.ref, background), { status: 'rejected', reason: 'foreground-only' })
  assert.deepEqual(ask(conflict.ref, { ...foreground, foregroundTurn: 'next' }), { status: 'rejected', reason: 'unknown-dispute' })
  const prepared = ask(conflict.ref)
  assert.equal(prepared.status, 'ready')
  if (prepared.status !== 'ready') return
  assert.deepEqual(ask(conflict.ref), { status: 'rejected', reason: 'already-asked' })
  const events: { type: string }[] = []
  const replies: object[] = []
  const intake: string[] = []
  const desk = createQuestionDesk({
    emit: event => events.push(event), send: response => replies.push(response), sessionId: () => session, taskOf: id => id,
    onAnswer: entry => { intake.push(entry.kind) },
    memoryClarificationQuestion: (id, questionId, phase) =>
      memory.clarificationQuestion(id, foreground.foregroundTurn, questionId, phase),
  })
  const plugin = (id: string, sessionId: string, questionId = prepared.question.id) =>
    desk.receive({ type: 'question', id, sessionId, questions: [{ id: questionId, question: 'arbitrary model wording' }] })
  plugin('forged', session, MEMORY_QUESTION_PREFIX + randomUUID())
  plugin('background', 'task')
  plugin('valid', session)
  plugin('duplicate', session)
  const [pending] = desk.pendingOf(null)
  assert.equal(pending.questionId, 'valid')
  assert.equal(pending.questions[0].question, prepared.question.question)
  assert.equal(pending.questions[0].options.length, 2)
  assert.equal(events.filter(event => event.type === 'question').length, 1)
  memory.holdWithdrawal(b.source.conversation)
  assert.equal(desk.answer('valid', [{ id: prepared.question.id, selected: [prepared.question.options[0].label] }]), false)
  assert.deepEqual(intake, [])
  assert.deepEqual(replies, [
    { type: 'decline', id: 'forged' }, { type: 'decline', id: 'background' },
    { type: 'decline', id: 'duplicate' }, { type: 'decline', id: 'valid' },
  ])
  assert.deepEqual(desk.pendingOf(null), [])
  memory.finishTurn(session)
  assert.deepEqual(ask(conflict.ref), { status: 'rejected', reason: 'unknown-dispute' })
})

test('ordinary cards that offer both exact disputed records cannot bypass a dispute before or after recall', async t => {
  const { memory, add, dispute, read } = fixture(t)
  const first = add(amber), second = add(jade)
  dispute(first, second)
  const background = { session: 'task', conversation: 'task', turn: 'job-turn' }
  const sent: object[] = []
  const events: object[] = []
  const desk = createQuestionDesk({
    send: message => sent.push(message), emit: event => events.push(event), sessionId: () => session,
    taskOf: id => id === background.session ? id : null,
    allowGeneralQuestion: (id, cards) => memory.authorizeGeneralQuestion({ session: id,
      conversation: id, turn: id === session ? foreground.foregroundTurn : background.turn }, cards),
  })
  const general = (id: string, sessionId: string, question = '周报提交邮箱用哪一个？') => desk.receive({ type: 'question', id, sessionId,
    questions: [{ id: 'email', question, options: [{ label: `#${first.id}` }, { label: `#${second.id}` }] }] })
  general('main-before-recall', session)
  read(background)
  general('task-generic', background.session)
  assert.deepEqual(sent, [
    { type: 'decline', id: 'main-before-recall', reason: 'memory-clarification' },
    { type: 'decline', id: 'task-generic', reason: 'memory-clarification' },
  ])
  assert.deepEqual(events, [])
  memory.finishTurn(session)
  assert.equal(await memory.authorizeGeneralQuestion({ ...background, turn: 'next-turn' },
    [{ question: '天气看哪个城市？', options: [] }]), false, 'unavailable independent check fails closed only when disputes exist')
})

test('ordinary card review uses relation descriptions and lets an independent question share a heading', async t => {
  const seen: string[] = []
  const { memory, store, add, dispute } = fixture(t, async job => {
    seen.push(job.input)
    const { snapshotId } = JSON.parse(job.input) as { snapshotId: string }
    return JSON.stringify({ verdict: 'unrelated', snapshotId })
  })
  const a = add(amber), b = add(jade)
  for (const [entry, value] of [[a, 'amber@example.com'], [b, 'jade@example.com']] as const) {
    const span = (word: string) => ({ start: entry.text.indexOf(word), end: entry.text.indexOf(word) + word.length })
    store.recordFact(entry.id, { predicate: 'report_email', subject: 'user', relation: '周报提交邮箱', object: value, polarity: 'positive',
      from: since, to: null, dated: false, uncertain: false, evidence: { statement: span(entry.text), spans: [span(entry.text)],
        relation: span('周报提交邮箱'), object: span(value), qualifiers: [], conditions: [], temporal: [] } })
  }
  dispute(a, b)
  dispute(add('我的治疗计划是方案甲 r9independent'), add('我的治疗计划是方案乙 t4independent'))
  const origin = { ...foreground, turn: 'active' }
  const allowed = await memory.authorizeGeneralQuestion(origin, [{ header: '周报提交邮箱', question: '周报附件用 PDF 还是 Word？',
    options: [{ label: 'PDF' }, { label: 'Word' }] }])
  assert.equal(typeof allowed === 'function' ? allowed() : allowed, true)
  assert.equal(seen.length, 1)
  const input = JSON.parse(seen[0])
  assert.deepEqual(input.disputes, [{ relations: ['周报提交邮箱'] }])
  assert.equal(input.unknownRelations, 1)
  assert.doesNotMatch(seen[0], /amber@|jade@|治疗计划|r9independent|t4independent/)
  assert.equal(await memory.authorizeGeneralQuestion(origin, [{ question: '请选择',
    options: [{ label: 'amber@example.com' }, { label: 'jade@example.com' }] }]), false)
  assert.equal(seen.length, 1, 'exact candidate values are checked locally')
})

test('an accepted foreground card only attributes a source supplied by backend intake', () => {
  const events: Array<{ type: string, sourceId?: unknown }> = []
  const context = { conversationId: 'topic', sessionId: session }
  const operation = randomUUID()
  const sourceId = randomUUID()
  const desk = createQuestionDesk({
    emit: event => events.push(event), send: () => {}, sessionId: () => session, conversationContext: () => context,
    onAnswer: (_entry, answers) => answers.some(answer => answer.custom) ? sourceId : undefined,
  })
  for (const [id, answer] of [['pick', { selected: ['One'] }], ['typed', { selected: [], custom: 'Second' }]] as const) {
    desk.receive({ type: 'question', id, sessionId: session, questions: [{ id: 'value', question: 'Which?', options: [{ label: 'One' }] }] })
    assert.equal(desk.answer(id, [{ id: 'value', ...answer }], operation), true)
  }
  assert.deepEqual(events.filter(event => event.type === 'question_answered').map(event => event.sourceId), [undefined, sourceId])
})

test('semantic question admission is bound to the active card, scoped snapshot and live evidence', async t => {
  const jobs: { job: MemoryCompute, resolve: (answer: string) => void }[] = []
  const { memory, add, dispute } = fixture(t, job => new Promise(resolve => jobs.push({ job, resolve })))
  const first = add(amber)
  const second = add(jade)
  dispute(first, second)
  const events: object[] = []
  const responses: object[] = []
  const desk = createQuestionDesk({
    send: response => responses.push(response), emit: event => events.push(event), sessionId: () => session,
    allowGeneralQuestion: (id, cards, waiting) => memory.authorizeGeneralQuestion({ ...foreground, session: id, turn: 'active' }, cards, waiting),
  })
  const general = (id: string, question = '天气看哪个城市？') => desk.receive({ type: 'question', id, sessionId: session,
    questions: [{ id: 'weather', question }] })
  general('credential', '请问 password: secret-value 对吗？')
  assert.equal(jobs.length, 0, 'credential text never reaches the classifier')
  general('cancelled')
  const cancelled = jobs.shift()!
  assert.ok(memory.computeAdmission(cancelled.job.id))
  desk.receive({ type: 'question_closed', id: 'cancelled' })
  assert.equal(memory.computeAdmission(cancelled.job.id), null)
  const reply = ({ job, resolve }: typeof cancelled) => resolve(JSON.stringify({ verdict: 'unrelated', snapshotId: JSON.parse(job.input).snapshotId }))
  reply(cancelled)
  general('stale')
  const stale = jobs.shift()!
  memory.holdWithdrawal(second.source.conversation)
  assert.equal(memory.computeAdmission(stale.job.id), null)
  reply(stale)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, [])
  assert.deepEqual(responses.map(response => 'id' in response ? response.id : null), ['credential', 'stale'])
  general('unrelated')
  assert.equal(jobs.length, 0)
  assert.deepEqual(desk.pendingOf(null).map(card => card.questionId), ['unrelated'])
})
