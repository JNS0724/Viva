import type { MemoryChangeProposal, MemoryProposal, MemorySpan, MemoryTemporal } from '../shared/memory-contract.ts'

// A delimiter distinguishes an immediate save command from ordinary prose.
const REMEMBER = /^(?:(?:请\s*)?(?:帮我\s*)?(?:记住|记一下|记下来)\s*[:：]|(?:please\s+)?remember(?:\s*[:：]|\s+that\s+))\s*(.+)$/isu

interface FactTime {
  from: number | null
  to: number | null
  dated: boolean
  uncertain: boolean
}

export interface MemoryFact extends FactTime {
  subject: string
  predicate: string
  object: string
  relation: string
  polarity: 'positive' | 'negative' | 'uncertain'
  evidence: {
    statement: MemorySpan
    spans: MemorySpan[]
    subject?: MemorySpan
    relation: MemorySpan
    object: MemorySpan
    qualifiers: MemorySpan[]
    conditions: MemorySpan[]
    temporal: MemorySpan[]
  }
}

export const factIdentity = (text: string) => text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()
export const sameRelation = (left: string, right: string) => factIdentity(left) === factIdentity(right)

/** Resolve a calendar boundary in the zone captured with the source. */
export function localDay(value: string, timezone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null
  const target = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== value) return null
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  // The first instant of the local date may have a midnight offset change.
  let low = target - 48 * 3_600_000
  let high = target + 48 * 3_600_000
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    if (formatter.format(mid) < value) low = mid
    else high = mid
  }
  return formatter.format(high) === value ? high : null
}

export function todayAt(at: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
}

export function nextDay(day: string) {
  return new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)
}

type CivilBoundary = NonNullable<Extract<MemoryTemporal, { kind: 'interval' }>['from']>
function localBoundary(boundary: CivilBoundary, assertedAt: number, timezone: string): number | null {
  const date = 'date' in boundary ? boundary.date
    : new Date(Date.parse(todayAt(assertedAt, timezone)) + boundary.daysFromSource * 86_400_000).toISOString().slice(0, 10)
  if (!boundary.time) return localDay(date, timezone)
  const time = boundary.time.length === 5 ? boundary.time + ':00' : boundary.time
  const civil = `${date}T${time}`
  const utc = Date.parse(civil + 'Z')
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 19) !== civil) return null
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const civilAt = (at: number) => formatter.format(at).replace(' ', 'T')
  // Sample offsets around the boundary, then round-trip each candidate. Repeated
  // and nonexistent local times both require clarification.
  const offsets = new Set([-48, -24, 0, 24, 48].map(hours => {
    const at = utc + hours * 3_600_000
    return Date.parse(civilAt(at) + 'Z') - at
  }))
  const matches = [...offsets].map(offset => utc - offset).filter(at => civilAt(at) === civil)
  return matches.length === 1 ? matches[0] : null
}

export function resolveMemoryTime(temporal: MemoryTemporal | undefined, assertedAt: number, timezone: string): FactTime {
  if (!temporal || temporal.kind === 'current') {
    return { from: assertedAt, to: null, dated: Boolean(temporal?.evidence), uncertain: false }
  }
  if (temporal.kind === 'interval') {
    const from = temporal.from === null ? null : localBoundary(temporal.from, assertedAt, timezone)
    const to = temporal.to === null ? null : localBoundary(temporal.to, assertedAt, timezone)
    if ((!temporal.from || from !== null) && (!temporal.to || to !== null)
      && (from !== null || to !== null) && (from === null || to === null || from < to)) return { from, to, dated: true, uncertain: false }
  }
  return { from: null, to: null, dated: true, uncertain: true }
}

export const statementIsQuestion = (text: string) => /[?？]\s*$/u.test(text)

export function rememberContent(text: string) {
  const body = REMEMBER.exec(text.trim())?.[1].trim()
  return body && !statementIsQuestion(body) ? body : undefined
}

const encloses = (outer: MemorySpan, inner: MemorySpan) => outer.start <= inner.start && inner.start < inner.end && inner.end <= outer.end
const overlapsSpan = (left: MemorySpan, right: MemorySpan) => left.start < right.end && right.start < left.end
const highSurrogate = (code: number) => code >= 0xD800 && code <= 0xDBFF
const lowSurrogate = (code: number) => code >= 0xDC00 && code <= 0xDFFF
const splitsScalar = (source: string, at: number) => highSurrogate(source.charCodeAt(at - 1)) && lowSurrogate(source.charCodeAt(at))
const slice = (source: string, span: MemorySpan) => source.slice(span.start, span.end)

function validSpan(source: string, span: MemorySpan) {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
    && encloses({ start: 0, end: source.length }, span)
    && !splitsScalar(source, span.start) && !splitsScalar(source, span.end) && Boolean(slice(source, span).trim())
}

function includesAll(outer: readonly MemorySpan[], inner: readonly MemorySpan[]) {
  return inner.every(part => outer.some(span => encloses(span, part)))
}

export function spanEnvelope(spans: readonly MemorySpan[]): MemorySpan {
  return { start: spans[0].start, end: spans[spans.length - 1].end }
}

export function sourceText(source: string, spans: readonly MemorySpan[]) {
  return spans.map(span => slice(source, span)).join(' … ').trim()
}

function checkedSpans(source: string, parts: readonly MemorySpan[], allowed: readonly MemorySpan[]) {
  if (!parts.length || !parts.every(span => validSpan(source, span)) || !includesAll(allowed, parts)) return null
  const ordered = [...parts].sort((a, b) => a.start - b.start || a.end - b.end)
  if (ordered.some((span, index) => index > 0 && overlapsSpan(ordered[index - 1], span))) return null
  return ordered
}

export function proposalSpans(source: string, proposal: MemoryProposal, allowed: readonly MemorySpan[]) {
  const spans = checkedSpans(source, proposal.spans, allowed)
  if (!spans) return null
  const extra = [...(proposal.conditionSpans ?? []), ...(proposal.temporal?.evidence ?? []), ...(proposal.durableIntent ? [proposal.durableIntent] : [])]
  return extra.every(span => validSpan(source, span)) && includesAll(spans, extra) ? spans : null
}

export function groundedFact(source: string, proposal: MemoryProposal, assertedAt: number, timezone: string,
  allowed: readonly MemorySpan[] = [{ start: 0, end: source.length }]): MemoryFact | null {
  const fact = proposal.fact
  const offered = proposalSpans(source, proposal, allowed)
  if (!fact || !offered) return null
  const spans = fact.spans ? checkedSpans(source, fact.spans, offered) : offered
  if (!spans) return null
  const { relation, object, subject } = fact
  const parts = [relation, object, ...(subject.span ? [subject.span] : [])]
  if (!parts.every(span => validSpan(source, span)) || !includesAll(spans, parts)
    || parts.some((part, index) => parts.slice(index + 1).some(other => overlapsSpan(part, other)))) return null
  const conditions = proposal.conditionSpans ?? []
  const temporal = proposal.temporal?.evidence ?? []
  const qualifiers = fact.qualifiers ?? []
  const modifiers = [...conditions, ...temporal, ...qualifiers]
  if (!modifiers.every(span => validSpan(source, span)) || !includesAll(spans, modifiers)) return null
  if ((subject.kind === 'user' && proposal.attribution !== 'self') || (subject.kind === 'named' && proposal.attribution !== 'third_party')) return null

  return {
    ...resolveMemoryTime(proposal.temporal, assertedAt, timezone),
    subject: subject.kind === 'user' ? 'user' : `named:${factIdentity(slice(source, subject.span))}`,
    predicate: fact.predicate,
    relation: slice(source, relation).trim(),
    object: slice(source, object).trim(),
    polarity: fact.polarity,
    evidence: { statement: spanEnvelope(spans), spans, subject: subject.span, relation, object, qualifiers, conditions, temporal },
  }
}

interface ChangeTarget {
  id: number
  revision: number
  fact: Pick<MemoryFact, 'subject' | 'object' | 'polarity'> | null
}

export type GroundedChange = Pick<MemoryChangeProposal, 'kind' | 'evidence'> & {
  effectiveAt: number | null
  affectedFrom?: number | null
  affectedTo?: number | null
  temporalSpans: MemorySpan[]
}

export function validChangeEvidence(source: string, change: MemoryChangeProposal, spans: readonly MemorySpan[]) {
  const { action, target, effective, oldValues = [] } = change.evidence
  const temporal = change.temporal?.evidence ?? []
  const parts = [action, target, ...(effective ? [effective] : []), ...temporal, ...oldValues]
  return parts.every(span => validSpan(source, span)) && includesAll(spans, parts)
    && (change.temporal?.kind !== 'interval' || Boolean(effective && temporal.some(span => encloses(span, effective))))
}

/** Derive the structurally supported bounds before asking for independent semantic review. */
export function groundedChange(source: string, proposal: MemoryProposal, old: ChangeTarget,
  assertedAt: number, timezone: string, allowed: readonly MemorySpan[] = [{ start: 0, end: source.length }]): GroundedChange | null {
  return deriveChange(source, proposal, old, assertedAt, timezone, allowed)
}

/** Keep verified event evidence available for clarification without assigning a date. */
export function groundedEventChange(source: string, proposal: MemoryProposal, old: ChangeTarget,
  assertedAt: number, timezone: string, allowed: readonly MemorySpan[]): (GroundedChange & { eventSpans: MemorySpan[] }) | null {
  const change = proposal.change
  const eventSpans = change?.temporal?.kind === 'event' ? change.temporal.evidence : proposal.temporal?.kind === 'event' ? proposal.temporal.evidence : undefined
  if (!eventSpans || (change?.kind !== 'supersede' && change?.kind !== 'end')) return null
  const draft = deriveChange(source, proposal, old, assertedAt, timezone, allowed, true)
  return draft ? { ...draft, eventSpans } : null
}

function deriveChange(source: string, proposal: MemoryProposal, old: ChangeTarget,
  assertedAt: number, timezone: string, allowed: readonly MemorySpan[], pendingEvent = false): GroundedChange | null {
  const change = proposal.change
  const spans = proposalSpans(source, proposal, allowed)
  if (!change || !spans || proposal.modality !== 'asserted' || proposal.attribution === 'uncertain'
    || change.target.id !== old.id || change.target.revision !== old.revision || !validChangeEvidence(source, change, spans)) return null
  const temporalSpans = change.temporal?.evidence ?? []

  const fact = groundedFact(source, proposal, assertedAt, timezone, allowed)
  if (proposal.fact && !fact) return null
  if (fact) {
    const { subject, relation, object, qualifiers, temporal, conditions } = fact.evidence
    const assertion = [subject, relation, object, ...qualifiers, ...temporal, ...conditions]
    if (change.evidence.oldValues?.some(span => assertion.some(part => part && overlapsSpan(span, part)))) return null
  }
  if (fact && old.fact && fact.subject !== old.fact.subject) return null
  if (change.kind === 'supersede' && (!fact || fact.polarity === 'uncertain'
    || (old.fact && factIdentity(fact.object) === factIdentity(old.fact.object) && fact.polarity === old.fact.polarity))) return null
  if (change.kind === 'possible_conflict' && (!fact || fact.polarity === 'uncertain' || !old.fact
    || (factIdentity(fact.object) === factIdentity(old.fact.object) && fact.polarity === old.fact.polarity))) return null

  const common = { kind: change.kind, evidence: change.evidence, temporalSpans }
  if (pendingEvent) return { ...common, effectiveAt: null }
  const time = change.temporal && resolveMemoryTime(change.temporal, assertedAt, timezone)
  if (time?.uncertain) return null
  if (change.kind === 'supersede' || change.kind === 'end') {
    if (time?.from == null) return null
    return { ...common, effectiveAt: time.from, affectedTo: time.to }
  }
  if (change.temporal?.kind === 'current') return null
  return { ...common, effectiveAt: null, affectedFrom: time?.from, affectedTo: time?.to }
}

/** A reviewed transition may not start the new claim before the claim's own date. */
export function compatibleTransitionTime(change: GroundedChange, fact: MemoryFact | null) {
  return change.kind !== 'supersede' || !fact?.dated || (!fact.uncertain
    && (fact.from === null || fact.from === change.effectiveAt)
    && (fact.to === null || (change.effectiveAt !== null && fact.to > change.effectiveAt))
    && (change.affectedTo == null || (fact.to !== null && fact.to <= change.affectedTo)))
}

export const covers = (from: number | null, to: number | null, at: number) =>
  (from === null || from <= at) && (to === null || at < to)
