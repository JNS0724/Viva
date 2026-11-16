import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { localDay } from '../src/memory/core/memory-facts.ts'
import { createMemoryRuntime } from './fixtures/localized-memory-runtime.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { createMemoryWithdrawal } from '../src/backend/memory-withdrawal.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { memoryOwnerCaller } from './fixtures/memory-owner-caller.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAppDb, transaction } from '../src/backend/app-db.ts'
import { createEffects } from '../src/backend/effects.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { registerRewindIpc } from '../src/backend/rewind-ipc.ts'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import type { MemoryChangeProposal, MemoryProposal, MemoryTemporal } from '../src/memory/contracts/memory-contract.ts'

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
const date = (day: string) => localDay(day, timezone)!
const january = '2026-01-01'
const march = '2026-03-01'
const may = '2026-05-01'
const a = 'amber@example.test'
const b = 'cobalt@example.test'
const c = 'jade@example.test'
const relation = '周报邮箱'
const period = (day: string) => `从${day}起`
const span = (text: string, part: string) => ({ start: text.indexOf(part), end: text.indexOf(part) + part.length })

function assertion(day: string, value: string, change?: { kind: MemoryChangeProposal['kind'], old: string, oldDay?: string, targetRelation?: boolean,
  temporal?: MemoryTemporal, oldValueEvidence?: string }) {
  const time = period(day)
  const statement = change?.kind === 'end' ? `我的${relation} ${value} 不再使用`
    : change?.kind === 'supersede' ? `我的${relation}从 ${change.old} 改为 ${value}`
      : change?.kind === 'possible_conflict' ? `我唯一的${relation}是 ${value}` : `我的${relation}是 ${value}`
  const previous = change?.kind === 'correct' ? `${period(change.oldDay!)}，之前说的 ${change.old} 有误。` : ''
  const text = `${previous}${time}，${statement}`
  const temporal: MemoryTemporal = { kind: 'interval', from: { date: day }, to: null, evidence: [span(text, time)] }
  const objectStart = text.lastIndexOf(value)
  const fact: MemoryProposal['fact'] = change?.kind === 'end' ? undefined : {
    subject: { kind: 'user' as const, span: span(text, '我') }, relation: span(text, relation), object: { start: objectStart, end: objectStart + value.length },
    predicate: 'report_email', polarity: 'positive' as const,
  }
  return { text, value, fact, change, temporal }
}

function fixture(t: TestContext) {
  const now = () => date('2026-07-01')
  const store = openMemoryStore(':memory:', now)
  const inputs = new Map<string, ReturnType<typeof assertion>>()
  const memory = createMemoryRuntime({ store, now, quiesce: async () => {}, changed: () => {},
    route: () => ({ provider: 'test', model: 'test' }),
    compute: async job => {
      const { user, related, proposals } = JSON.parse(job.input) as {
        user: string, related: { id: number, revision: number, object?: string }[], proposals?: { index: number, draft: { id: string } }[],
      }
      if (job.stage === 'review') return JSON.stringify({ reviews: proposals?.map(({ index, draft }) => ({ index, verdict: 'confirmed', draftId: draft.id })) })
      const input = inputs.get(user)
      assert.ok(input)
      const target = input.change && related.find(row => row.object === input.change!.old)
      let change: MemoryChangeProposal | undefined
      if (input.change && target) {
        const { kind } = input.change
        change = { kind, target: { id: target.id, revision: target.revision }, evidence: {
          action: span(user, kind === 'supersede' ? '改为' : kind === 'end' ? '不再' : kind === 'correct' ? '有误' : '唯一'),
          target: span(user, kind === 'possible_conflict' || input.change.targetRelation ? relation : input.change.old),
          ...(input.change.oldValueEvidence ? { oldValues: [span(user, input.change.oldValueEvidence)] } : {}),
        } }
        if (kind === 'correct') {
          const oldDay = input.change.oldDay!
          const evidence = span(user, period(oldDay))
          change.temporal = { kind: 'interval', from: { date: oldDay }, to: null, evidence: [evidence] }
          change.evidence.effective = evidence
        } else if (kind !== 'possible_conflict') {
          change.temporal = input.change.temporal ?? input.temporal
          change.evidence.effective = change.temporal.evidence?.[0]
        }
      }
      const proposal: MemoryProposal = { spans: [{ start: 0, end: user.length }], kind: 'fact', scope: 'user',
        modality: 'asserted', attribution: 'self', keywords: [relation], temporal: input.temporal, fact: input.fact, change }
      return JSON.stringify({ proposals: [proposal] })
    },
  })
  t.after(() => memory.close())
  async function add(input: ReturnType<typeof assertion>) {
    inputs.set(input.text, input)
    const conversation = randomUUID()
    memory.accept(input.text, { conversation, session: conversation })
    await memory.wake()
    return conversation
  }
  const entry = (object: string) => {
    const result = store.list().find(row => row.fact?.object === object)
    assert.ok(result, object)
    return result
  }
  const current = () => memory.listMemories().items.map(row => row.fact?.object)
  return { memory, store, add, entry, current }
}

test('withdrawing a later scheduled change restores the preceding open assertion', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  const later = await add(assertion(may, c, { kind: 'supersede', old: a }))
  await add(assertion(march, b, { kind: 'supersede', old: a }))
  assert.deepEqual(entry(a).windows, [{ from: date(january), to: date(march) }])
  assert.deepEqual(entry(b).windows, [{ from: date(march), to: date(may) }])
  assert.equal(entry(b).assertedTo, null)
  assert.deepEqual(current(), [c])
  memory.withdraw({ conversation: later, ids: [] })
  assert.deepEqual(entry(b).windows, [{ from: date(march), to: null }])
  assert.deepEqual(current(), [b])
})

test('withdrawing a middle replacement retains its independently evidenced successor', async t => {
  const { memory, add, entry, current } = fixture(t)
  const original = await add(assertion(january, a))
  const middle = await add(assertion(march, b, { kind: 'supersede', old: a }))
  await add(assertion(may, c, { kind: 'supersede', old: b }))
  memory.withdraw({ conversation: middle, ids: [] })
  assert.deepEqual(entry(a).windows, [{ from: date(january), to: date(may) }])
  assert.deepEqual(entry(b).windows, [])
  assert.deepEqual(current(), [c])
  const result = JSON.parse(memory.handle({ op: 'recall', session: original, query: relation, asOf: '2026-04-01' },
    { conversation: original, session: original }))
  assert.match(result.memories[0].text, /amber@example\.test/)
})

test('withdrawing a transition preserves separately asserted values as a dispute only where they overlap', async t => {
  const { memory, add, current } = fixture(t)
  const original = await add(assertion(january, a))
  const transition = await add(assertion(march, b, { kind: 'supersede', old: a }))
  await add(assertion(may, b))
  memory.withdraw({ conversation: transition, ids: [] })
  assert.deepEqual(current(), [])
  const disputes = memory.listInvalid().filter(row => row.state === 'disputed')
  assert.deepEqual(new Set(disputes.map(row => row.fact?.object)), new Set([a, b]))
  assert.deepEqual(disputes[0].links.find(link => link.kind === 'conflict')?.windows, [{ from: date(may), to: null }])
  const result = JSON.parse(memory.handle({ op: 'recall', session: original, query: relation, asOf: '2026-04-01' },
    { conversation: original, session: original }))
  assert.match(result.memories[0].text, /amber@example\.test/)
})

test('undo checks current record versions and keeps a later explicit successor', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  await add(assertion(march, b, { kind: 'supersede', old: a }))
  const before = memory.listChanges()[0]
  await add(assertion(may, c, { kind: 'supersede', old: b }))
  const stale = await memory.undoChange(before.id, before.revision, randomUUID(), before.expectedRevisions)
  assert.equal(stale.status, 'conflict')
  assert.ok(stale.status === 'conflict' && stale.current.some(ref => ref.id === entry(c).id))
  const fresh = memory.listChanges().find(row => row.id === before.id)!
  const key = randomUUID()
  assert.deepEqual(await memory.undoChange(fresh.id, fresh.revision, key, fresh.expectedRevisions), { status: 'applied' })
  assert.deepEqual(entry(a).windows, [{ from: date(january), to: date(may) }])
  assert.deepEqual(entry(b).windows, [])
  assert.deepEqual(current(), [c])
  assert.deepEqual(await memory.undoChange(fresh.id, fresh.revision, key, fresh.expectedRevisions), { status: 'applied' })
})

test('confirming a historical dispute preserves the uncontested later window', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  await add(assertion(march, b, { kind: 'possible_conflict', old: a }))
  await add(assertion(may, b, { kind: 'end', old: b }))
  const left = entry(a)
  const right = entry(b)
  const id = left.links.find(link => link.id === right.id)?.changeId
  assert.ok(id)
  assert.deepEqual(current(), [a])
  assert.equal(await memory.resolveConflictPair({ id: right.id, revision: right.revision }, { id: left.id, revision: left.revision },
    { kind: 'keep-first' }, undefined, id, { from: date(march), to: date(may) }), true)
  assert.deepEqual(entry(a).windows, [{ from: date(january), to: date(march) }, { from: date(may), to: null }])
  assert.deepEqual(current(), [a])
})

test('a correction can explicitly replace an incorrect start date with a different date', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(march, a))
  await add(assertion(january, b, { kind: 'correct', old: a, oldDay: march }))
  assert.deepEqual(entry(a).windows, [])
  assert.deepEqual(entry(b).windows, [{ from: date(january), to: null }])
  assert.deepEqual(current(), [b])
  const change = memory.listChanges()[0]
  assert.deepEqual(await memory.undoChange(change.id, change.revision, randomUUID(), change.expectedRevisions), { status: 'applied' })
  assert.deepEqual(entry(a).windows, [{ from: date(march), to: null }])
  assert.deepEqual(entry(b).windows, [])
})

test('a correction of a historical predecessor preserves the reviewed later replacement', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  await add(assertion(march, b, { kind: 'supersede', old: a }))
  await add(assertion(may, c, { kind: 'supersede', old: b }))
  const corrected = 'corrected@example.test'
  await add(assertion(march, corrected, { kind: 'correct', old: b, oldDay: march }))
  assert.deepEqual(entry(b).windows, [])
  assert.deepEqual(entry(corrected).windows, [{ from: date(march), to: date(may) }])
  assert.deepEqual(current(), [c])

  const correction = memory.listChanges().find(change => change.kind === 'correct')!
  assert.deepEqual(await memory.undoChange(correction.id, correction.revision, randomUUID(), correction.expectedRevisions), { status: 'applied' })
  assert.deepEqual(entry(b).windows, [{ from: date(march), to: date(may) }])
  assert.deepEqual(entry(corrected).windows, [])
  assert.deepEqual(current(), [c])
})

test('correcting history preserves a later explicit end and undo cannot silently detach that end', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  await add(assertion(march, b, { kind: 'supersede', old: a }))
  await add(assertion(may, b, { kind: 'end', old: b }))
  const transition = memory.listChanges().find(change => change.kind === 'supersede')!
  assert.deepEqual(await memory.undoChange(transition.id, transition.revision, randomUUID(), transition.expectedRevisions),
    { status: 'conflict', current: transition.expectedRevisions })
  assert.deepEqual(current(), [])

  const corrected = 'corrected@example.test'
  await add(assertion(march, corrected, { kind: 'correct', old: b, oldDay: march }))
  assert.deepEqual(entry(b).windows, [])
  assert.deepEqual(entry(corrected).windows, [{ from: date(march), to: date(may) }])
  assert.deepEqual(current(), [])
})

test('deleting a replacement rechecks the independent assertion of its value', async t => {
  const { memory, add, current } = fixture(t)
  await add(assertion(january, a))
  await add(assertion(march, b, { kind: 'supersede', old: a }))
  await add(assertion(may, b))
  const change = memory.listChanges()[0]
  const replacement = change.expectedRevisions.find(item => item.id === change.replacementId)!
  assert.equal(await memory.forget(replacement.id, replacement.revision, 'delete'), true)
  assert.deepEqual(current(), [])
  const disputed = memory.listInvalid().filter(row => row.state === 'disputed')
  assert.deepEqual(new Set(disputed.map(row => row.fact?.object)), new Set([a, b]))
  assert.deepEqual(disputed[0].links.find(link => link.kind === 'conflict')?.windows, [{ from: date(may), to: null }])
})

test('deleting an old value redacts it from replacement evidence even if the target span names the relation', async t => {
  const { memory, store, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  const segment = await add(assertion(march, b, { kind: 'supersede', old: a, targetRelation: true }))
  const old = entry(a)
  assert.equal(await memory.forget(old.id, old.revision, 'delete'), true)
  const source = store.readSource(store.sourceIds(segment)[0])!
  assert.ok(!source.text?.includes(a))
  assert.ok(!entry(b).text.includes(a))
  assert.ok(!JSON.stringify(memory.listChanges()).includes(a))
  assert.deepEqual(current(), [b])
})

test('a finite replacement does not reactivate an indefinitely discontinued old value', async t => {
  const { add, entry, current } = fixture(t)
  await add(assertion(january, a))
  const replacement = assertion(march, b, { kind: 'supersede', old: a })
  const limit = `新邮箱只用到${may}，旧邮箱此后继续停用`
  const text = `${replacement.text}，${limit}`
  await add({ ...replacement, text, change: { ...replacement.change!, temporal: replacement.temporal }, temporal: {
    kind: 'interval', from: { date: march }, to: { date: may }, evidence: [span(text, period(march)), span(text, limit)],
  } })
  assert.deepEqual(entry(a).windows, [{ from: date(january), to: date(march) }])
  assert.deepEqual(entry(b).windows, [{ from: date(march), to: date(may) }])
  assert.deepEqual(current(), [])
})

test('withdrawing a replacement leaves its later ending pending without making the predecessor current', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  const replacement = await add(assertion(march, b, { kind: 'supersede', old: a }))
  await add(assertion(may, b, { kind: 'end', old: b }))
  assert.deepEqual(current(), [])
  memory.withdraw({ conversation: replacement, ids: [] })
  assert.deepEqual(entry(a).windows, [{ from: date(january), to: date(may) }])
  assert.equal(memory.listChanges().find(row => row.kind === 'end')?.status, 'pending')
  assert.deepEqual(current(), [])
  const lookup = (query: string) => JSON.parse(memory.handle({ op: 'recall', session: 'lookup', query }, { conversation: 'lookup', session: 'lookup' }))
  assert.equal(lookup(relation).partial, true)
  assert.ok(lookup(relation).reasons.includes('pending-end'))
  assert.ok(!lookup('办公椅').reasons.includes('pending-end'))
})

test('deleting a replacement preserves a later ending from another source', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  await add(assertion(march, b, { kind: 'supersede', old: a }))
  await add(assertion(may, b, { kind: 'end', old: b }))
  const replacement = entry(b)
  await memory.forget(replacement.id, replacement.revision, 'delete')
  assert.deepEqual(entry(a).windows, [{ from: date(january), to: date(may) }])
  assert.equal(memory.listChanges().find(row => row.kind === 'end')?.status, 'pending')
  assert.deepEqual(current(), [])
})

test('deleting the old value preserves the replacement when its grounded value contains the old spelling', async t => {
  const { memory, store, add, entry, current } = fixture(t)
  const old = 'a@example.test', next = 'ba@example.test'
  await add(assertion(january, old))
  const source = await add(assertion(march, next, { kind: 'supersede', old, oldValueEvidence: old }))
  const oldEntry = entry(old)
  assert.equal(await memory.forget(oldEntry.id, oldEntry.revision, 'delete'), true)
  assert.deepEqual(current(), [next])
  assert.match(store.readSource(store.sourceIds(source)[0])?.text ?? '', /改为 ba@example\.test/)
  assert.doesNotMatch(entry(next).text, /从\s+a@example\.test/)
})

test('deleting an old atom preserves a new qualifier and unrelated token containing those letters', async t => {
  const { memory, store, add, entry, current } = fixture(t)
  const old = 'A', next = 'B'
  await add(assertion(january, old))
  const base = assertion(march, next, { kind: 'supersede', old })
  const text = `${base.text}，由 AWS 托管，ARC 负责部署`
  const source = await add({ ...base, text, fact: { ...base.fact!, qualifiers: [span(text, '由 AWS 托管')] } })
  const target = entry(old)
  assert.equal(await memory.forget(target.id, target.revision, 'delete'), true)
  assert.deepEqual(current(), [next])
  assert.match(store.readSource(store.sourceIds(source)[0])?.text ?? '', /AWS 托管，ARC 负责部署/)
  assert.doesNotMatch(entry(next).text, /从 A 改为/)
})

test('undo stops for an overlapping candidate whose independently used relationship wording is unverified', async t => {
  const { memory, add, entry, current } = fixture(t)
  await add(assertion(january, a))
  await add(assertion(march, b, { kind: 'supersede', old: a }))
  const independently = assertion(may, b)
  const text = independently.text.replace(relation, '周报提交地址')
  await add({ ...independently, text, fact: { ...independently.fact!, relation: span(text, '周报提交地址'), object: span(text, b) } })
  const change = memory.listChanges()[0]
  assert.ok(change.expectedRevisions.some(row => row.id === entry(b).id && row.id !== change.replacementId))
  assert.deepEqual(await memory.undoChange(change.id, change.revision, randomUUID(), change.expectedRevisions),
    { status: 'conflict', current: change.expectedRevisions })
  assert.ok(!current().includes(a))
})

for (const remove of ['withdraw', 'delete'] as const) test(`${remove} holds only the restored overlap when a surviving relationship is unverified`, async t => {
  const { memory, store, add, entry, current } = fixture(t)
  const original = await add(assertion(january, a))
  const transition = await add(assertion(march, b, { kind: 'supersede', old: a }))
  const replacement = entry(b)
  const independently = assertion(may, b)
  const wording = '周报提交地址'
  const text = independently.text.replace(relation, wording)
  const surviving = await add({ ...independently, text, fact: { ...independently.fact!, relation: span(text, wording), object: span(text, b) } })
  if (remove === 'delete') await memory.forget(replacement.id, replacement.revision, 'delete')
  else memory.withdraw({ conversation: transition, ids: [] })

  const originalSource = store.sourceIds(original)[0]
  const lookup = (query: string, asOf?: string) => JSON.parse(memory.handle({ op: 'recall', session: original, query, asOf },
    { conversation: original, session: original, foregroundTurn: 'turn' }))
  assert.deepEqual(current(), [b])
  assert.equal(memory.dispatchSourceCurrent(originalSource), false)
  assert.equal(memory.dispatchSourceCurrent(originalSource, date('2026-04-01')), true)
  assert.equal(memory.dispatchDeadline([], [originalSource], date('2026-04-01')), date(may))
  assert.ok(memory.listInvalid().some(entry => entry.fact?.object === a && 'pendingRelation' in entry))
  const pending = lookup(relation)
  assert.ok(pending.reasons.includes('pending-relation'))
  assert.deepEqual(pending.conflicts, [])
  assert.deepEqual(pending.pendingChanges, [])
  assert.match(lookup(relation, '2026-04-01').memories[0].text, /amber@example\.test/)
  assert.ok(!lookup('办公椅').reasons.includes('pending-relation'))

  memory.withdraw({ conversation: surviving, ids: [] })
  assert.deepEqual(current(), [a])
  assert.equal(memory.dispatchSourceCurrent(originalSource), true)
  assert.ok(!lookup(relation).reasons.includes('pending-relation'))
})

test('editing a historical message withdraws only its original source while the folded conversation remains readable', async t => {
  const app = openAppDb({ file: ':memory:' })
  const db = openHistoryDb({ db: app.db })
  const effects = createEffects({ db: app.db })
  const directory = mkdtempSync(join(tmpdir(), 'viva-edit-owner-'))
  const owner = openMemoryOwner({ root: directory, quiesce: async () => {}, route: () => null, compute: () => null })
  await owner.recover()
  const memory = owner.runtime
  t.after(async () => { await owner.close(); effects.close(); app.close(); rmSync(directory, { recursive: true, force: true }) })
  let selected = db.create({ sessionId: 'first', cwd: '/work' })
  const first = selected
  const note = { role: 'user' as const, text: '记住：每周五交周报', sourceId: randomUUID(), receipt: null }
  const old = { role: 'user' as const, text: '记住：我常用红色打印机', sourceId: randomUUID(), receipt: null }
  const edited = '记住：我常用绿色打印机'
  for (const row of [note, old]) memory.accept(row.text, { conversation: first.id, session: first.sessionId }, row.sourceId)
  selected = db.save(selected, [note, old])
  let failWithdrawal = false
  const call = memoryOwnerCaller(owner, method => {
    if (failWithdrawal && method === 'commitSourceChange') { failWithdrawal = false; throw new Error('simulated stop before withdrawal') }
  })
  const coordinator = createMemoryWithdrawal({ history: () => db, effects: () => effects, memory: () => ({ call }),
    apply: (_kind, _data, work) => ({ value: transaction(app.db, work) }), changing: async work => work() })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  let canEditSource = false
  let switches = 0
  registerRewindIpc(checkedIpc({ handle: (channel, handler) => { handlers.set(channel, handler) }, on: () => {} }), {
    db, current: () => selected, agentInfo: () => ({}), isBusy: () => false, replaySource: memory.replaySource,
    canEditSource: () => canEditSource,
    commitEdit: coordinator.commitEdit,
    rebuild: (_previous, kept, force) => {
      assert.equal(force, true)
      return { text: note.text, turns: 1, evidence: kept.map(row => ({ ...row, segmentId: first.id })) }
    },
    selectSession: work => work({
      select: row => { selected = row },
      forkAgent: async () => ({ ok: true, info: { sessionId: 'forked' } }),
      switchAgent: async () => { switches++; return { sessionId: 'clean' } },
    }),
  })
  const rewind = handlers.get('timeline:rewind')!
  const redo = await rewind({}, { words: old.text, text: old.text, keep: 1 }) as { sourceId: string, newSource?: boolean }
  assert.equal(redo.sourceId, old.sourceId)
  assert.equal(redo.newSource, undefined)
  assert.equal(memory.replaySource(old.sourceId, old.text), true)

  const unavailable = await rewind({}, { words: old.text, text: edited, keep: 1 }) as { ok: boolean, problem?: string }
  assert.equal(unavailable.ok, false)
  assert.match(unavailable.problem ?? '', /memory|记忆/i)
  assert.equal(switches, 0)
  assert.equal(effects.list().length, 0)
  assert.equal(memory.replaySource(old.sourceId, old.text), true)

  canEditSource = true
  failWithdrawal = true
  await assert.rejects(async () => rewind({}, { words: old.text, text: edited, keep: 1 }), /simulated stop/)
  const replacement = db.latest()!
  const newSource = replacement.messages[1].sourceId!
  assert.notEqual(newSource, old.sourceId)
  assert.equal(replacement.conversation.sessionId, 'clean')
  assert.equal(memory.sourceCurrent(old.sourceId), false, 'pending withdrawal is already excluded from model access')
  assert.equal(effects.list().length, 1)
  await coordinator.recover()
  await coordinator.recover()
  assert.equal(effects.list().length, 0)
  assert.equal(memory.replaySource(old.sourceId, old.text), false)
  assert.equal(memory.replaySource(note.sourceId, note.text), true)
  await owner.receiveSource({ sessionId: 'clean', messageId: newSource, text: edited, at: Date.now(), timezone, turn: 1, step: 1, admitted: true, inherited: false })
  assert.equal(memory.replaySource(newSource, edited), true)
  assert.equal(db.get(first.id)?.messages[1].text, old.text)
  assert.equal(memory.sourceCurrent(old.sourceId), false)
  assert.equal(memory.sourceCurrent(note.sourceId), true)
  assert.equal(memory.sourceCurrent(newSource), true)
})
