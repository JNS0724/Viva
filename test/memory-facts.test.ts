import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compatibleTransitionTime, groundedChange, groundedFact, localDay, proposalSpans, resolveMemoryTime, sourceText } from '../src/memory/core/memory-facts.ts'
import { memoryProposals } from '../src/memory/contracts/memory-contract.ts'
import type { MemoryChangeProposal, MemoryProposal, MemorySpan, MemoryTemporal } from '../src/memory/contracts/memory-contract.ts'

const at = Date.parse('2026-11-14T12:00:00Z')
const zone = 'Asia/Shanghai'

function span(text: string, part: string): MemorySpan {
  const start = text.indexOf(part)
  assert.notEqual(start, -1)
  return { start, end: start + part.length }
}

function proposal(text: string, parts: Partial<MemoryProposal> = {}): MemoryProposal {
  return memoryProposals.parse({ proposals: [{
    spans: [{ start: 0, end: text.length }], attribution: 'self', scope: 'user',
    kind: 'fact', modality: 'asserted', keywords: [], ...parts,
  }] }).proposals[0]
}

test('arbitrary predicates preserve separated original qualifiers and negation', () => {
  const condition = '用于开源项目时'
  const exception = '客户合同指定的除外'
  const body = '我没有使用许可证 XYZ'
  const text = condition + '，请先读取项目说明。' + body + '；' + exception
  const spans = [condition, body, exception].map(part => span(text, part))
  const input = proposal(text, {
    spans,
    conditionSpans: [spans[0], spans[2]],
    fact: { subject: { kind: 'user', span: span(text, '我') }, predicate: '新的_开放谓词42', polarity: 'negative',
      relation: span(text, '使用许可证'), object: span(text, 'XYZ'), qualifiers: [span(text, '没有')] },
  })
  const fact = groundedFact(text, input, at, zone)
  assert.ok(fact)
  assert.equal(fact.predicate, '新的_开放谓词42')
  assert.equal(fact.polarity, 'negative')
  assert.equal(sourceText(text, fact.evidence.spans), '用于开源项目时 … 我没有使用许可证 XYZ … 客户合同指定的除外')
  assert.deepEqual(fact.evidence.conditions, [spans[0], spans[2]])
  assert.equal(groundedFact(text, { ...input, spans: [spans[1]] }, at, zone), null)
  assert.equal(groundedFact(text, { ...input, attribution: 'third_party' }, at, zone), null)
})

test('evidence must stay within the allowed original UTF-16 ranges', () => {
  const text = '🟣我使用许可证 XYZ'
  const fact = {
    subject: { kind: 'user' as const, span: span(text, '我') }, predicate: 'license', polarity: 'positive' as const,
    relation: span(text, '使用许可证'), object: span(text, 'XYZ'),
  }
  const input = proposal(text, { fact })
  assert.ok(groundedFact(text, input, at, zone))
  assert.equal(proposalSpans(text, { ...input, spans: [{ start: 1, end: text.length }] }, [{ start: 0, end: text.length }]), null)
  assert.equal(groundedFact(text, input, at, zone, [span(text, '许可证 XYZ')]), null)
  assert.equal(groundedFact(text, { ...input, fact: { ...fact, relation: { start: 5, end: text.length } } }, at, zone), null)
  assert.equal(groundedFact(text, { ...input, fact: { ...fact, object: { start: 5, end: text.length + 1 } } }, at, zone), null)
})

function replacement(text: string, action: string, target: string) {
  const effective = span(text, '11 月 16 日零点起')
  const change: MemoryChangeProposal = {
    kind: 'supersede', target: { id: 17, revision: 5 },
    evidence: { action: span(text, action), target: span(text, target), effective },
    temporal: { kind: 'interval', from: { date: '2026-11-16', time: '00:00' }, to: null, evidence: [effective] },
  }
  return proposal(text, { change, fact: {
    subject: { kind: 'user', span: span(text, '我') }, predicate: 'team', polarity: 'positive',
    relation: span(text, action), object: span(text, '风控组'),
  } })
}

test('a change draft requires the actual revision, valid evidence and a compatible new boundary', () => {
  const text = '11 月 16 日零点起，我从支付组切换至风控组'
  const input = replacement(text, '切换至', '支付组')
  const old = { id: 17, revision: 5, fact: { subject: 'user', object: '支付组', polarity: 'positive' as const } }
  assert.equal(groundedChange(text, input, { ...old, revision: 6 }, at, zone), null)
  assert.equal(groundedChange(text, input, { ...old, fact: { ...old.fact, subject: 'named:other' } }, at, zone), null)
  assert.equal(groundedChange(text, input, old, at, zone)?.effectiveAt, localDay('2026-11-16', zone))
  assert.equal(groundedChange(text, { ...input, modality: 'reported' }, old, at, zone), null)
  const changed = { ...input.change!, evidence: { ...input.change!.evidence, action: { start: 0, end: text.length + 1 } } }
  assert.equal(groundedChange(text, { ...input, change: changed }, old, at, zone), null)
  const temporal: MemoryTemporal = { kind: 'interval', from: { date: '2026-11-17' }, to: null, evidence: [span(text, '11 月 16 日零点起')] }
  const change = groundedChange(text, { ...input, temporal }, old, at, zone)
  assert.ok(change)
  assert.equal(compatibleTransitionTime(change, groundedFact(text, { ...input, temporal }, at, zone)), false)
  const sameStart = groundedFact(text, { ...input, temporal: { ...temporal, from: { date: '2026-11-16' } } }, at, zone)
  assert.equal(compatibleTransitionTime({ ...change, affectedTo: localDay('2026-11-17', zone) }, sameStart), false)
})

test('civil time uses source zone and refuses impossible, ambiguous and unresolved bounds', () => {
  const evidence = [{ start: 0, end: 1 }]
  const boundary = (date: string, time?: string): MemoryTemporal => ({ kind: 'interval', from: { date, time }, to: null, evidence })
  assert.equal(resolveMemoryTime(boundary('2026-01-02'), at, zone).from, Date.parse('2026-01-01T16:00:00Z'))
  assert.equal(resolveMemoryTime({ kind: 'interval', from: { daysFromSource: 1 }, to: null, evidence },
    Date.parse('2026-01-01T17:00:00Z'), zone).from, Date.parse('2026-01-02T16:00:00Z'))
  assert.equal(resolveMemoryTime(boundary('2026-01-02', '13:20'), at, zone).from, Date.parse('2026-01-02T05:20:00Z'))
  assert.equal(resolveMemoryTime(boundary('2026-02-31'), at, zone).uncertain, true)
  assert.equal(resolveMemoryTime(boundary('2026-03-08', '02:30'), at, 'America/New_York').uncertain, true)
  assert.equal(resolveMemoryTime(boundary('2026-11-01', '01:30'), at, 'America/New_York').uncertain, true)
  assert.equal(resolveMemoryTime({ kind: 'event', evidence }, at, zone).uncertain, true)
  assert.equal(resolveMemoryTime({ kind: 'unknown', evidence }, at, zone).uncertain, true)
})
