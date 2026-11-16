import { z } from 'zod'

/** Public host protocol. No process handles, filesystem paths or model credentials cross it. */
export const MEMORY_SERVICE_PROTOCOL = 1
const key = z.string().min(1).max(200)
const revision = z.number().int().nonnegative()
const text = z.string().min(1).max(64_000)
const operation = { operationId: z.uuid() }
const target = { id: key, expectedRevision: revision }
export const memoryAccessScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.enum(['project', 'thread', 'task']), id: key }),
])
export type MemoryAccessScope = z.infer<typeof memoryAccessScope>
export const memorySourceReference = z.strictObject({ namespace: key, sourceId: key, occurrenceId: key.optional(), revision })
export type MemorySourceReference = z.infer<typeof memorySourceReference>
const sourceReferences = z.array(memorySourceReference).max(1_000)
const memoryRecord = z.strictObject({
  id: key, revision, text, enabled: z.boolean(), scope: memoryAccessScope,
  sources: sourceReferences,
})
export type MemoryRecord = z.infer<typeof memoryRecord>
const query = z.strictObject({ scope: memoryAccessScope, query: z.string().max(8_000).optional(), cursor: key.optional(), limit: z.number().int().min(1).max(200).optional() })
const sourceChange = z.strictObject({
  ...operation, target: memorySourceReference, expectedRevision: revision,
  kind: z.enum(['remove-occurrence', 'revise-occurrence', 'forget-canonical']),
})

/** Unknown properties are rejected, including self-asserted owner/client identities. */
export const memoryCommandSchemas = {
  status: z.strictObject({}),
  list: query,
  search: z.strictObject({ scope: memoryAccessScope, query: text, limit: z.number().int().min(1).max(200).optional() }),
  read: z.strictObject({ id: key, expectedRevision: revision.optional() }),
  getProfile: z.strictObject({ scope: memoryAccessScope }),
  remember: z.strictObject({ ...operation, text, scope: memoryAccessScope, category: key.optional(),
    input: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('explicit-user') }),
      z.strictObject({ kind: z.literal('model-proposal'), sources: sourceReferences.min(1) }),
    ]),
  }),
  revise: z.strictObject({ ...operation, ...target, text, sources: sourceReferences }),
  setEnabled: z.strictObject({ ...operation, ...target, enabled: z.boolean() }),
  forget: z.strictObject({ ...operation, ...target }),
  undo: z.strictObject({ ...operation, changeId: key, expectedRevision: revision }),
  setProfile: z.strictObject({ ...operation, scope: memoryAccessScope, expectedRevision: revision, fields: z.record(key, z.string().max(8_000)) }),
  runDream: z.strictObject({ ...operation, scope: memoryAccessScope }),
  rescan: z.strictObject({ ...operation, scope: memoryAccessScope }),
  reindex: z.strictObject({ ...operation, scope: memoryAccessScope }),
  getOperation: z.strictObject({ operationId: z.uuid() }),
  answerClarification: z.strictObject({ ...operation, questionId: key, expectedRevision: revision, answer: text }),
  bindContext: z.strictObject({ threadId: key, projectId: key.optional(), sessionId: key }),
  linkSources: z.strictObject({ ...operation, source: memorySourceReference, occurrence: memorySourceReference }),
  attachDependencies: z.strictObject({ sessionId: key, sources: sourceReferences }),
  prepareSourceChange: sourceChange,
  commitSourceChange: z.strictObject({ ...operation, ticket: key }),
  pendingHostEffects: z.strictObject({ cursor: key.optional() }),
  ackHostEffect: z.strictObject({ effectId: key, causeOperationId: z.uuid(), revision }),
} as const
export type MemoryMethod = keyof typeof memoryCommandSchemas
export type MemoryInput<M extends MemoryMethod> = z.infer<(typeof memoryCommandSchemas)[M]>
export type MemoryCommand = { [M in MemoryMethod]: { method: M, input: MemoryInput<M> } }[MemoryMethod]
const methods = Object.keys(memoryCommandSchemas) as [MemoryMethod, ...MemoryMethod[]]
export const memoryMethod = z.enum(methods)
export const memoryServiceStatus = z.strictObject({
  protocol: z.literal(MEMORY_SERVICE_PROTOCOL), instanceEpoch: key,
  state: z.enum(['ready', 'recovering', 'unavailable']), capabilities: z.array(memoryMethod),
})
export type MemoryServiceStatus = z.infer<typeof memoryServiceStatus>
export const memoryOperationOutcome = z.strictObject({
  operationId: z.uuid(),
  state: z.enum(['accepted', 'running', 'completed', 'failed', 'intent', 'preparing', 'prepared', 'host-committed', 'cleanup-pending']),
  revision: revision.optional(), changeId: key.optional(), targetId: key.optional(),
  sendFence: z.enum(['pending', 'complete']).optional(), cleanup: z.enum(['pending', 'complete']).optional(),
})
export type MemoryOperationOutcome = z.infer<typeof memoryOperationOutcome>
const page = z.strictObject({ items: z.array(memoryRecord), cursor: key.optional(), partial: z.boolean(), reason: z.string().max(200).optional() })
const profile = z.strictObject({ revision, fields: z.record(key, z.string().max(8_000)), sources: sourceReferences })
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
const ack = z.strictObject({ accepted: z.literal(true) })
export const memoryResultSchemas = {
  status: memoryServiceStatus, list: page, search: page, read: memoryRecord.nullable(), getProfile: profile,
  remember: memoryOperationOutcome, revise: memoryOperationOutcome, setEnabled: memoryOperationOutcome,
  forget: memoryOperationOutcome, undo: memoryOperationOutcome, setProfile: memoryOperationOutcome,
  runDream: memoryOperationOutcome, rescan: memoryOperationOutcome, reindex: memoryOperationOutcome,
  getOperation: memoryOperationOutcome.nullable(), answerClarification: memoryOperationOutcome,
  bindContext: ack, linkSources: memoryOperationOutcome, attachDependencies: ack,
  prepareSourceChange: z.strictObject({ operation: memoryOperationOutcome, ticket: key.optional() }),
  commitSourceChange: memoryOperationOutcome,
  pendingHostEffects: z.strictObject({ effects: z.array(memoryHostEffect), cursor: key.optional() }),
  ackHostEffect: ack,
} as const
export type MemoryOutput<M extends MemoryMethod> = z.infer<(typeof memoryResultSchemas)[M]>
export type MemoryResult = MemoryOutput<MemoryMethod>
export const memoryErrorCode = z.enum(['unauthorized', 'invalid-input', 'revision-conflict', 'unavailable', 'protocol-mismatch', 'operation-id-conflict'])
export type MemoryErrorCode = z.infer<typeof memoryErrorCode>
export const memoryServiceError = z.strictObject({ code: memoryErrorCode, reason: key.optional() })
export type MemoryServiceFailure = z.infer<typeof memoryServiceError>
export const memoryRequestEnvelope = z.strictObject({
  protocol: z.number().int(), requestId: key, instanceEpoch: key.optional(),
  method: z.union([z.literal('connect'), memoryMethod]), input: z.unknown(),
})
export type MemoryRequestEnvelope = z.infer<typeof memoryRequestEnvelope>
export type MemoryResponseEnvelope = { requestId: string, instanceEpoch: string } & (
  { ok: true, result: MemoryServiceStatus | MemoryResult } | { ok: false, error: MemoryServiceFailure }
)

/** Trusted adapter output, never accepted from the request body. Scope/target checks remain mandatory. */
export type MemoryClientBinding = Readonly<{
  clientId: string, namespace: string, kind: 'user-interface' | 'model' | 'host',
  capabilities: readonly MemoryMethod[],
}>
export const MEMORY_HOST_METHODS: ReadonlySet<MemoryMethod> = new Set([
  'bindContext', 'linkSources', 'attachDependencies', 'prepareSourceChange', 'commitSourceChange', 'pendingHostEffects', 'ackHostEffect',
])
export const MEMORY_RECOVERY_METHODS: ReadonlySet<MemoryMethod> = new Set([
  'status', 'getOperation', 'prepareSourceChange', 'commitSourceChange', 'pendingHostEffects', 'ackHostEffect',
])

/** Normalized ingress separates reliable receipt from completed-turn processing. */
const eventFields = { eventId: key, cursor: key, threadId: key, sessionId: key.optional(), projectId: key.optional(),
  scope: memoryAccessScope, at: z.number().finite() }
export const memoryConversationEvent = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventFields, kind: z.literal('received'), source: memorySourceReference,
    role: z.enum(['user', 'assistant']), origin: z.enum(['original', 'derived']), admission: z.enum(['received', 'admitted']), text, dependencies: sourceReferences }),
  z.strictObject({ ...eventFields, kind: z.literal('revised'), source: memorySourceReference, previousRevision: revision,
    role: z.enum(['user', 'assistant']), origin: z.enum(['original', 'derived']), text, dependencies: sourceReferences }),
  z.strictObject({ ...eventFields, kind: z.literal('completed'), sources: sourceReferences }),
  z.strictObject({ ...eventFields, kind: z.literal('withdrawn'), source: memorySourceReference, extent: z.enum(['occurrence', 'canonical']) }),
])
export type MemoryConversationEvent = z.infer<typeof memoryConversationEvent>
export interface MemoryConversationFeed {
  /** Authenticated host binding is supplied by composition, not deserialized from an event or model output. */
  readonly binding: { hostId: string, namespace: string }
  replay(after: string | null): AsyncIterable<MemoryConversationEvent>
  persistThrough(cursor: string): Promise<void>
}
export interface MemoryHostEffects {
  apply(effect: MemoryHostEffect): Promise<void>
}

/** Core model port: adapters retain provider reasoning/stream state, isolated by job ID. */
export type MemoryModelJob = Readonly<{
  jobId: string, purpose: 'note' | 'dream' | 'evidence' | 'profile',
  input: string, sources: readonly MemorySourceReference[],
  tools: readonly { name: string, description: string, schema: z.infer<ReturnType<typeof z.json>> }[],
}>
export type MemoryModelCompletion =
  | { state: 'completed', text: string }
  | { state: 'incomplete', reason: 'cancelled' | 'truncated' | 'unavailable' }
export type MemoryToolInvocation = Readonly<{ callId: string, name: string, input: z.infer<ReturnType<typeof z.json>> }>
export type MemoryToolResult = Readonly<{
  callId: string, state: 'completed' | 'rejected', content: string, sources: readonly MemorySourceReference[],
}>
export type MemoryToolExecutor = (invocation: MemoryToolInvocation) => Promise<MemoryToolResult>
export interface MemoryModelCompute {
  /** Core owns execution/authorization. Adapter feeds tool results back and updates dynamic dependencies
   * before every following model send; provider tool IDs/reasoning stay inside the adapter's isolated job. */
  run(job: MemoryModelJob, options: { signal: AbortSignal, executeTool: MemoryToolExecutor }): Promise<MemoryModelCompletion>
}
export interface MemoryEmbedding {
  readonly space: { fingerprint: string, dimensions: number, normalized: boolean }
  embed(input: { kind: 'query' | 'passage', texts: readonly string[] }, signal: AbortSignal): Promise<readonly (readonly number[])[] | null>
}
