import assert from 'node:assert/strict'
import test from 'node:test'
import { providerReceivedTaskBrief, taskFirstRequestEvidence } from './fixtures/task-first-request.ts'

const brief = 'Start only from this independent brief'
const sessionId = 'new-task-session'
const delivery = '\n\n<memory-delivery id="f1636502-25d8-4129-8078-7d59d6389329" />'
const opening = 'The previous generated context has been retired. The following are authorized earlier user messages, retained as historical context.'
const closing = '\n[End of earlier user messages]\n'
const text = (text: string) => ({ type: 'text', text })
const user = (words: string, id = 'brief-original') => ({ role: 'user', id, source: { kind: 'user' }, content: [text(words)] })
const recovery = (originalMessageIds: string[] = [], content = [text(opening), text(closing)]) => ({
  type: 'user/message', surfaceOp: 'append', data: { role: 'user', id: 'empty-recovery',
    source: { kind: 'viva-memory-recovery', originalMessageIds }, content },
})

type FixtureEvent = { type: string, data: unknown, surfaceOp?: unknown }
function prefix(before: FixtureEvent[] = [], after: FixtureEvent[] = []): Array<Record<string, unknown>> {
  const original = user(brief + delivery)
  return [
    { type: 'session', version: 4, id: sessionId, isSeeded: false },
    ...[
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [original] } },
      { type: 'turn/start', data: { turn: 1 } },
      ...before,
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'system', content: [text('The actual system persona')] } } },
      { type: 'user/message', surfaceOp: 'append', data: original },
      ...after,
      { type: 'request/header', data: { header: { config: { model: 'fixture' } } } },
    ].map((event, seq) => ({ ...event, seq })),
  ]
}
const inspect = (rows: unknown[]) => taskFirstRequestEvidence(rows, sessionId, brief)

test('a fresh native task begins with one brief, with or without an exactly empty recovery frame', () => {
  assert.equal(inspect(prefix()).ok, true)
  const evidence = inspect(prefix([recovery()]))
  assert.equal(evidence.ok, true)
  assert.equal(evidence.humanMessages, 1)
  assert.equal(evidence.recoveryFrames, 1)
})

test('declared runtime, skill and memory projections are context rather than parent conversational originals', () => {
  const contexts = ['runtime-context', 'skill-catalog', 'viva-memory'].map(kind => ({ type: 'user/message', surfaceOp: 'append',
    data: { role: 'user', id: kind, source: { kind }, content: [text('Authorized context, even when it describes a previously saved fact')] } }))
  const evidence = inspect(prefix([recovery()], contexts))
  assert.equal(evidence.ok, true)
  assert.deepEqual(evidence.contextKinds, ['runtime-context', 'skill-catalog', 'viva-memory'])
})

test('a nonempty native recovery fails even when the provider parser could discard its earlier user history', () => {
  for (const frame of [
    recovery(['parent-original']),
    recovery([], [text(opening), text('\n[Earlier user message 1]\nparent conversation'), text(closing)]),
    recovery([], [text(opening), text('parent conversation' + closing)]),
  ]) {
    const evidence = inspect(prefix([frame]))
    assert.equal(evidence.ok, false)
    assert.match(evidence.reason!, /Recovery contains earlier/)
  }
})

test('raw parent originals remain forbidden when a later empty recovery or surface edit would hide them', () => {
  for (const words of ['parent question', '<system-reminder>\nparent question\n</system-reminder>']) {
    const evidence = inspect(prefix([{ type: 'user/message', surfaceOp: 'append', data: user(words, 'parent-message') }, recovery()]))
    assert.equal(evidence.ok, false)
    assert.match(evidence.reason!, /Parent or different human/)
  }
})

test('copied assistant and tool records cannot precede a fresh task request', () => {
  for (const type of ['assistant/message', 'tool/call', 'tool/result', 'compaction']) {
    const evidence = inspect(prefix([{ type, surfaceOp: 'append', data: { text: 'parent generated answer' } }]))
    assert.equal(evidence.ok, false)
    assert.match(evidence.reason!, /Unexpected prior native event/)
  }
})

test('seeded sessions, additional turns, unknown projections and missing first request fail closed', () => {
  const seeded = prefix(); seeded[0] = { type: 'session', version: 4, id: sessionId, isSeeded: true }
  assert.equal(inspect(seeded).ok, false)
  assert.equal(inspect(prefix([{ type: 'turn/start', data: { turn: 2 } }])).ok, false)
  assert.equal(inspect(prefix([], [{ type: 'user/message', surfaceOp: 'append', data: {
    role: 'user', source: { kind: 'unknown-context' }, content: [text('parent context')],
  } }])).ok, false)
  assert.equal(inspect(prefix().slice(0, -1)).ok, false)
})

test('the initial inbox and genuine human event must identify the same sole original', () => {
  const otherInbox = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [user('parent question', 'parent-message')] } }
  assert.equal(inspect(prefix([otherInbox])).ok, false)
  const repeated = { type: 'user/message', surfaceOp: 'append', data: user(brief + delivery, 'another-original') }
  assert.equal(inspect(prefix([], [repeated])).ok, false)
  const mutation = prefix().map(row => row.type === 'user/message' ? { ...row, data: user(brief + ' mutated') } : row)
  assert.equal(inspect(mutation).ok, false)
})

test('actual provider brief evidence tolerates earlier framing but never removes or reinterprets that framing', () => {
  const request = { messages: [{ role: 'user', content: [text(opening), text(closing),
    text('<system-reminder>\nThe actual system persona\n</system-reminder>'), text(brief + delivery)] }] }
  assert.equal(providerReceivedTaskBrief([request], brief), true)
  assert.equal(providerReceivedTaskBrief([{ messages: [{ role: 'assistant', content: brief }] }], brief), false)
  assert.equal(providerReceivedTaskBrief([{ messages: [{ role: 'user', content: 'Background request: ' + brief }] }], brief), false)
  // A raw provider request containing a parent user plus the brief still cannot
  // satisfy the independent native freshness audit.
  assert.equal(providerReceivedTaskBrief([{ messages: [{ role: 'user', content: brief + delivery }] }], brief), true)
  assert.equal(inspect(prefix([recovery(['parent-original'])])).ok, false)
})
