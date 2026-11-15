import { z } from 'zod'
import { MAX_MESSAGE_CHARS } from './text-limits.ts'

export const MEMORY_CONTRACT = 6
export const MEMORY_QUESTION_PREFIX = 'memory-clarify:'
export const memoryKinds = ['fact', 'preference', 'person', 'project', 'role'] as const
export const memoryKind = z.enum(memoryKinds)
export const operationId = z.uuid()
export const memoryScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.enum(['conversation', 'task', 'project']), id: z.string().min(1).max(200) }),
])
export type MemoryScope = z.infer<typeof memoryScope>
export type MemoryKind = z.infer<typeof memoryKind>

const span = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
export type MemorySpan = z.infer<typeof span>
const revisionRef = z.object({ id: z.number().int().positive(), revision: z.number().int().positive() })
const predicateKey = z.string().trim().min(1).max(64).regex(/^[\p{L}][\p{L}\p{N}_-]*$/u)
const civilTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u).optional()
const civilBoundary = z.union([
  z.strictObject({ date: z.iso.date(), time: civilTime }),
  z.strictObject({ daysFromSource: z.number().int().min(-36_600).max(36_600), time: civilTime }),
])
const evidenceSpans = z.array(span).min(1).max(12)
const temporal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current'), evidence: evidenceSpans.optional() }),
  z.object({ kind: z.literal('interval'), from: civilBoundary.nullable(), to: civilBoundary.nullable(), evidence: evidenceSpans }),
  z.object({ kind: z.enum(['unknown', 'event']), evidence: evidenceSpans }),
])
export type MemoryTemporal = z.infer<typeof temporal>
const proposedFact = z.object({
  predicate: predicateKey,
  spans: evidenceSpans.optional(),
  relation: span,
  object: span,
  subject: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), span: span.optional() }),
    z.object({ kind: z.literal('named'), span }),
  ]),
  polarity: z.enum(['positive', 'negative', 'uncertain']),
  qualifiers: z.array(span).max(8).optional(),
})
const proposedChange = z.object({
  kind: z.enum(['correct', 'supersede', 'end', 'possible_conflict']),
  target: revisionRef,
  evidence: z.object({ action: span, target: span, effective: span.optional(), oldValues: evidenceSpans.optional() }),
  temporal: temporal.optional(),
})
const memoryProposal = z.object({
  spans: evidenceSpans, kind: memoryKind, scope: z.enum(['user', 'conversation', 'task', 'project']),
  modality: z.enum(['asserted', 'planned', 'hypothetical', 'reported']),
  attribution: z.enum(['self', 'third_party', 'context', 'uncertain']),
  keywords: z.array(z.string().max(20)).max(6),
  conditionSpans: evidenceSpans.optional(),
  temporal: temporal.optional(),
  independent: z.boolean().optional(),
  durableIntent: span.optional(),
  fact: proposedFact.optional(),
  change: proposedChange.optional(),
})
export const memoryProposals = z.object({ proposals: z.array(memoryProposal).max(8) })
export type MemoryProposal = z.infer<typeof memoryProposal>
export type MemoryChangeProposal = z.infer<typeof proposedChange>
const reviewIndex = z.number().int().min(0).max(7)
const draftId = z.string().regex(/^[a-f0-9]{64}$/u)
const conditions = z.enum(['equivalent', 'overlap', 'disjoint'])
const memoryReview = z.discriminatedUnion('verdict', [
  z.strictObject({ index: reviewIndex, verdict: z.literal('confirmed'), draftId, conditions: conditions.optional() }),
  z.strictObject({ index: reviewIndex, verdict: z.literal('rejected'), draftId }),
  z.strictObject({ index: reviewIndex, verdict: z.literal('uncertain'), draftId, sameRelation: z.literal(true).optional(), conditions: conditions.optional() }),
])
export const memoryReviews = z.object({ reviews: z.array(memoryReview).max(8) })
export type MemoryReview = z.infer<typeof memoryReview>

const session = z.string().min(1).max(128)
const query = z.string().trim().min(1).max(200)
const text = z.string().trim().min(1).max(MAX_MESSAGE_CHARS)
export const MEMORY_SEMANTIC_TIMEOUT_MS = 6000
export const memoryRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('context'), session, turn: z.number().int().positive(), question: z.string().max(MAX_MESSAGE_CHARS) }),
  z.object({ op: z.literal('recall'), session, query, scope: z.literal('project').optional(), asOf: z.iso.date().optional(), deep: z.boolean().optional() }),
  z.object({ op: z.literal('remember'), session, text, kind: memoryKind.optional(), keywords: z.array(z.string().max(20)).max(6).optional() }),
  z.object({ op: z.literal('forget'), session, id: z.number().int().positive() }),
  z.object({ op: z.literal('clarify'), session, ref: z.uuid() }),
])
export type MemoryRequest = z.infer<typeof memoryRequest>
const clarificationOption = z.object({ label: z.string().min(1), description: z.string().max(1000).optional() })
export const memoryClarificationResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), question: z.object({
    id: z.string().startsWith(MEMORY_QUESTION_PREFIX), question: z.string().min(1),
    options: z.tuple([clarificationOption, clarificationOption]),
  }) }),
  z.object({ status: z.literal('rejected'), reason: z.string() }),
])
export const memoryCompute = z.object({
  id: operationId, sourceId: operationId, stage: z.enum(['extract', 'review', 'question', 'profile']),
  generation: z.number().int().positive(), provider: z.string().min(1), model: z.string().min(1),
  system: z.string().max(6000), input: z.string().max(100_000),
})
export type MemoryCompute = z.infer<typeof memoryCompute>
export const memoryComputeFailure = z.enum(['max-tokens', 'tool-calls', 'aborted', 'error', 'missing-finish', 'dispatch-denied', 'timeout', 'call-failed'])
export type MemoryComputeFailure = z.infer<typeof memoryComputeFailure>
export const memoryComputeUsage = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  totalTokens: z.int().nonnegative().optional(),
  cacheReadTokens: z.int().nonnegative().optional(),
  cacheWriteTokens: z.int().nonnegative().optional(),
  reasoningTokens: z.int().nonnegative().optional(),
})
export type MemoryComputeUsage = z.infer<typeof memoryComputeUsage>
