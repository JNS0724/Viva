import { z } from 'zod'

const key = z.string().min(1).max(200)
const revision = z.number().int().nonnegative()

export const memorySourceReference = z.strictObject({ namespace: key, sourceId: key, occurrenceId: key.optional(), revision })
export type MemorySourceReference = z.infer<typeof memorySourceReference>
const sourceReferences = z.array(memorySourceReference).max(1_000)

export const memoryOperationOutcome = z.strictObject({
  operationId: z.uuid(),
  state: z.enum(['accepted', 'running', 'completed', 'failed', 'intent', 'preparing', 'prepared', 'host-committed', 'cleanup-pending']),
  revision: revision.optional(), changeId: key.optional(), targetId: key.optional(),
  sendFence: z.enum(['pending', 'complete']).optional(), cleanup: z.enum(['pending', 'complete']).optional(),
})
export type MemoryOperationOutcome = z.infer<typeof memoryOperationOutcome>

const hostEffect = {
  effectId: key, causeOperationId: z.uuid(), revision, hostNamespace: key,
  sources: sourceReferences, sessions: z.array(key).optional(),
}
export const memoryHostErasureRange = z.strictObject({
  sourceId: key, revision, length: z.int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/),
  afterHash: z.string().regex(/^[0-9a-f]{64}$/),
  spans: z.array(z.strictObject({ start: z.int().nonnegative(), end: z.int().positive() })).min(1),
}).refine(cut => cut.spans.every(span => span.start < span.end && span.end <= cut.length))
export type MemoryHostErasureRange = z.infer<typeof memoryHostErasureRange>
export const memoryHostEffect = z.discriminatedUnion('kind', [
  z.strictObject({ ...hostEffect, kind: z.enum(['erase-copies', 'invalidate-context']) }),
  z.strictObject({ ...hostEffect, kind: z.literal('erase-file-copies'), ranges: z.array(memoryHostErasureRange).min(1), traceSessions: z.array(key).optional() }),
])
export type MemoryHostEffect = z.infer<typeof memoryHostEffect>

/** Core model port: adapters retain provider reasoning/stream state, isolated by job ID. */
export type MemoryModelJob = Readonly<{
  jobId: string, purpose: 'note' | 'dream' | 'evidence' | 'profile',
  input: string, sources: readonly MemorySourceReference[],
  tools: readonly { name: string, description: string, schema: z.infer<ReturnType<typeof z.json>> }[],
}>
export type MemoryToolInvocation = Readonly<{ callId: string, name: string, input: z.infer<ReturnType<typeof z.json>> }>
export type MemoryToolResult = Readonly<{
  callId: string, state: 'completed' | 'rejected', content: string, sources: readonly MemorySourceReference[],
}>
export type MemoryToolExecutor = (invocation: MemoryToolInvocation) => Promise<MemoryToolResult>
