import { z } from 'zod'
import { MAX_MESSAGE_CHARS } from './text-limits.ts'

export const MEMORY_CONTRACT = 13
export const operationId = z.uuid()
export const memoryScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.enum(['conversation', 'task', 'project']), id: z.string().min(1).max(200) }),
])
export type MemoryScope = z.infer<typeof memoryScope>

export type { TextSpan as MemorySpan } from './text-spans.ts'

const session = z.string().min(1).max(128)
const query = z.string().trim().min(1).max(200)
const text = z.string().trim().min(1).max(MAX_MESSAGE_CHARS)
export const MEMORY_SEMANTIC_TIMEOUT_MS = 6000
export const memoryRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('context'), session, turn: z.number().int().positive(), question: z.string().max(MAX_MESSAGE_CHARS) }),
  z.object({ op: z.literal('recall'), session, query, scope: z.literal('project').optional(), asOf: z.iso.date().optional(), deep: z.boolean().optional(),
    limit: z.number().int().optional(), min_score: z.number().optional(), start_date: z.iso.date().optional(), end_date: z.iso.date().optional() }),
  z.object({ op: z.literal('file_read'), session, id: z.string().min(1).max(200), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() }),
  z.object({ op: z.literal('node_search'), session, query, limit: z.number().int().positive().max(50).optional() }),
  z.object({ op: z.literal('remember'), session, text }),
])
export type MemoryRequest = z.infer<typeof memoryRequest>
export const memoryCompute = z.object({
  id: operationId, sourceId: operationId, stage: z.enum(['question', 'note', 'dream']),
  generation: z.number().int().positive(), provider: z.string().min(1), model: z.string().min(1),
  system: z.string().max(6000), input: z.string(),
}).refine(job => isDailyMemoryStage(job.stage) || job.input.length <= 100_000, { path: ['input'] })

export function isDailyMemoryStage(stage: string) {
  return stage === 'note' || stage === 'dream'
}
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

export const automaticRecallResult = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('hit'),
    text: z.string(),
    partial: z.boolean(),
    hits: z.array(z.strictObject({ text: z.string(), names: z.array(z.string()) })),
  }),
  z.strictObject({ status: z.literal('empty') }),
  z.strictObject({ status: z.literal('skipped') }),
  z.strictObject({ status: z.literal('timeout') }),
  z.strictObject({ status: z.literal('unavailable') }),
])
export type AutomaticRecallResult = z.infer<typeof automaticRecallResult>
