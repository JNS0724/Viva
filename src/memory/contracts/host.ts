import { z } from 'zod'
import { memoryProvenanceSchema } from './provenance.ts'
import type { MemoryEntry, MemoryEvidence, MemoryDependency, MemoryProvenance, MemoryChange } from './records.ts'
import type { MemoryScope } from './memory-contract.ts'
import type { MemoryInterval } from './facts.ts'
import type { TextSpan } from './text-spans.ts'
import type { MemoryHostEffect, MemoryOperationOutcome } from './service.ts'
import { memoryFileListRequest, memoryFileIdentity, memoryFileRestrictionId, memoryFileSetEnabledRequest, memoryFileForgetRequest, memoryFileUndoRequest, memoryFileCreateRequest, memoryFileEditRequest } from './file-management.ts'
import type { MemoryFileListRequest, MemoryFileListResult, MemoryManagedFileIdentity, MemoryFileDetail, MemoryFileProfile,
  MemoryFileSetEnabledRequest, MemoryFileForgetRequest, MemoryFileUndoRequest, MemoryFileMutationResult, MemoryFileCreateRequest, MemoryFileEditRequest } from './file-management.ts'

/** Trusted parent-process adapter protocol. This is not available to model tools. */
export const MEMORY_HOST_PROTOCOL = 1
export type MemoryProject = { kind: 'project', id: string }
export type MemoryHistoryOccurrence = { segmentId: string, role: string, text: string, sourceId?: string | null, sessionId?: string | null }
export type MemoryProfile = Record<string, { value: string, updatedAt: number, revision: number, source: string }>
export type MemoryProfileView = { generated: boolean, items: Array<{ text: string, dependency: MemoryDependency, evidence?: MemoryEvidence & { text: string } }> }
export type MemoryChangeView = Pick<MemoryChange, 'id' | 'revision' | 'targetId' | 'replacementId' | 'from' | 'to' | 'effectiveAt' | 'createdAt'> & {
  kind: 'correct' | 'supersede' | 'end', status: 'applied' | 'undone' | 'withdrawn' | 'pending',
  before: string | null, after: string | null, scope: MemoryScope | null,
  expectedRevisions: Array<{ id: number, revision: number }>,
  evidence: Array<{ start: number, end: number, sourceId: string, conversationId: string | null, text: string | null }>,
}
export type HostMemoryQuestion = { id: string, question: string, topic?: string, options: Array<{ label: string, description?: string }> }
export type HostQuestionCard = HostMemoryQuestion & { header: string, multiSelect: boolean }
export type MemorySourceAlias = {
  operationId: string, sourceId: string, session: string, conversation: string,
  text: string, wireText?: string, wireSpans?: TextSpan[], context?: MemoryScope, project?: MemoryProject,
  origin?: 'original' | 'derived', dependencies?: MemoryProvenance,
}
export type SourceChangeInput = { operationId: string, conversation: string, ids: string[], onlySources?: true,
  replacement?: { sourceId: string, segmentId: string, projectId?: string | null } }
type Side = { id: number, revision: number }
type Resolution = { kind: 'keep-first' | 'keep-both' | 'discard-both' } | { kind: 'replace', text: string }
type Scope = MemoryProject | { kind: 'user' }
type EntryPage = { items: MemoryEntry[], total: number, invalid: number }
type Args<A extends readonly unknown[], O> = { input: { args: A }, output: O }
/** Deliberate whitelist: adding a host operation requires adding a decoder and an owner handler. */
export interface HostMemoryApi {
  listFiles: Args<[request: MemoryFileListRequest], MemoryFileListResult>
  readFile: Args<[identity: MemoryManagedFileIdentity, restrictionId?: string], MemoryFileDetail | null>
  setFileEnabled: Args<[request: MemoryFileSetEnabledRequest], MemoryFileMutationResult>
  createFile: Args<[request: MemoryFileCreateRequest], MemoryFileMutationResult>
  editFile: Args<[request: MemoryFileEditRequest], MemoryFileMutationResult>
  forgetFile: Args<[request: MemoryFileForgetRequest], MemoryFileMutationResult>
  undoFile: Args<[request: MemoryFileUndoRequest], MemoryFileMutationResult>
  listMemories: Args<[query?: string], EntryPage>
  listInvalid: Args<[], Array<MemoryEntry & { pendingRelation?: boolean }>>
  listChanges: Args<[], MemoryChangeView[]>
  profile: Args<[], MemoryProfile>
  profileView: Args<[scope: Scope], MemoryProfileView>
  fileProfile: Args<[project?: MemoryProject], MemoryFileProfile>
  revision: Args<[], number>
  epoch: Args<[], number>
  cleanupPending: Args<[], number>
  onboarding: Args<[], string>
  setOnboarding: Args<[status: string], string>
  rebuildIndexes: Args<[], { fullText: boolean, semantic: boolean, files?: { lexical: boolean, vectorGeneration: number } }>
  setProfile: Args<[fields: Record<string, unknown>, operation?: string], MemoryProfile>
  addMemory: Args<[text: string, category?: string, operation?: string], MemoryEntry | null>
  editMemory: Args<[id: number, text: string, revision: number, operation?: string], MemoryEntry | null>
  stopMemory: Args<[id: number, revision: number, operation?: string], boolean>
  restoreMemory: Args<[id: number, revision: number, operation?: string], MemoryEntry | null>
  deleteMemory: Args<[id: number, revision: number, operation?: string], { status: 'cleared' | 'stopped' }>
  resolveConflictPair: Args<[first: Side, second: Side, resolution: Resolution, operation?: string, changeId?: number, interval?: MemoryInterval], boolean>
  undoChange: Args<[id: number, revision: number, operation: string | undefined, expected: readonly Side[]], { status: 'applied' } | { status: 'conflict', current: readonly Side[] }>
  bindProject: Args<[session: string, project?: MemoryProject], boolean>
  projectChanged: Args<[session: string | null | undefined, project?: MemoryProject], boolean>
  allowsEvidence: Args<[evidence: MemoryProvenance | null | undefined, project?: MemoryProject], boolean>
  stale: Args<[session: string | null | undefined, project?: MemoryProject], boolean>
  allowsSession: Args<[session: string, project?: MemoryProject], boolean>
  /** Trusted native adapter only: rebuild an idle model surface and acknowledge its durable replacement. */
  recoverContext: Args<[session: string], boolean>
  transferable: Args<[evidence: MemoryProvenance | null | undefined], boolean>
  transferStatus: Args<[evidence: MemoryProvenance | null | undefined, project: MemoryProject | undefined, transportReady: boolean], 'ready' | 'stale' | 'memory-unavailable'>
  transfer: Args<[session: string, evidence: MemoryProvenance | null | undefined, project: MemoryProject | undefined, transportReady: boolean], boolean>
  canInherit: Args<[source: string, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, transportReady: boolean], boolean>
  inherit: Args<[source: string, target: string, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, transportReady: boolean], boolean>
  inheritFork: Args<[source: string, target: string, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, transportReady: boolean], boolean>
  allowsProjectHistory: Args<[row: MemoryHistoryOccurrence, sourceProject: MemoryProject | undefined, targetProject: MemoryProject | undefined, sessionProject?: MemoryProject], boolean>
  useHistory: Args<[session: string | undefined, row: MemoryHistoryOccurrence], void>
  provenance: Args<[session: string], MemoryProvenance>
  authorizedProvenance: { input: { session: string, prior?: MemoryProvenance, sourceId?: string }, output: MemoryProvenance | null }
  recordSession: Args<[session: string], void>
  sessionProject: Args<[session: string], string | undefined>
  recordSessionProject: Args<[session: string, project: string], void>
  recordDeliveredSource: Args<[source: string, conversation: string, derived: boolean, session: string], void>
  isDerivedDelivery: Args<[source: string], boolean>
  replaySources: Args<[sources: readonly string[], text: string, project?: MemoryProject], boolean>
  forgetIntent: Args<[text: string, scope?: MemoryScope, project?: MemoryProject], MemoryEntry | false | null>
  correctionIntent: Args<[text: string, scope?: MemoryScope, project?: MemoryProject], { entry: MemoryEntry, text: string } | false | null>
  bindWireAlias: Args<[session: string, text: string, wireText: string, sourceId?: string, wireSpans?: TextSpan[]], { wireText: string }>
  cancelFileClarification: Args<[session: string, questionId: string], boolean>
  clarificationQuestion: Args<[session: string, turn: string, id: string, phase: 'show' | 'check'], HostMemoryQuestion | null>
  authorizeGeneralQuestion: Args<[session: string, turn: string, cards: readonly HostQuestionCard[], conversation: string | null, context: MemoryScope, project?: MemoryProject, phase?: 'show' | 'check'], boolean>
  acceptQuestionAnswer: { input: { operationId: string, session: string, conversation: string, text: string, question: string, requestId: string, questionId: string, context: MemoryScope, project?: MemoryProject }, output: { sourceId: string } }
  sourceAlias: { input: MemorySourceAlias, output: { sourceId: string } }
  prepareSourceChange: { input: SourceChangeInput, output: { ticket: string, operation: MemoryOperationOutcome } }
  commitSourceChange: { input: { operationId: string, ticket: string }, output: MemoryOperationOutcome }
  getOperation: { input: { operationId: string }, output: MemoryOperationOutcome | null }
  pendingHostEffects: { input: Record<string, never>, output: MemoryHostEffect[] }
  ackHostEffect: { input: { effectId: string, causeOperationId: string, revision: number }, output: { accepted: true } }
}
export type HostMemoryMethod = keyof HostMemoryApi
export type HostMemoryCommand = { [M in HostMemoryMethod]: { method: M, input: HostMemoryApi[M]['input'] } }[HostMemoryMethod]
export type HostMemoryCaller = <M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input']) => Promise<HostMemoryApi[M]['output']>
const key = z.string().min(1).max(256)
const MAX_HOST_TEXT = 512_000
const text = z.string().max(MAX_HOST_TEXT)
const wireSpans = z.array(z.strictObject({ start: z.int().nonnegative(), end: z.int().positive() })).max(MAX_HOST_TEXT).optional()
const integer = z.number().int().nonnegative()
const project = z.strictObject({ kind: z.literal('project'), id: key })
const scope = z.union([z.strictObject({ kind: z.literal('user') }), z.strictObject({ kind: z.enum(['project', 'conversation', 'task']), id: key })])
const side = z.strictObject({ id: integer, revision: integer })
const interval = z.strictObject({ from: z.number().nullable(), to: z.number().nullable() })
const provenance = memoryProvenanceSchema
const maybeProvenance = provenance.nullish()
const occurrence = z.strictObject({ segmentId: key, role: key, text, sourceId: key.nullish(), sessionId: key.nullish() })
// Node's JSON IPC encodes an undefined tuple slot as null. Only optional slots
// are restored; nullable domain values keep their meaning.
const args = <T extends z.ZodTuple>(schema: T) => z.strictObject({ args: z.preprocess(value => Array.isArray(value)
  ? value.map((item, index) => item === null && schema.def.items[index] && z.safeParse(schema.def.items[index], undefined).success ? undefined : item)
  : value, schema) })
const empty = args(z.tuple([]))
const target = args(z.tuple([integer, integer, key.optional()]))
const transfer = [maybeProvenance, project.optional(), z.boolean()] as const
const inheritance = [key, project.optional(), project.optional(), z.boolean()] as const
export const hostMemoryInputSchemas = {
  createFile: args(z.tuple([memoryFileCreateRequest])), editFile: args(z.tuple([memoryFileEditRequest])),
  listFiles: args(z.tuple([memoryFileListRequest])), readFile: args(z.tuple([memoryFileIdentity, memoryFileRestrictionId.optional()])),
  setFileEnabled: args(z.tuple([memoryFileSetEnabledRequest])), undoFile: args(z.tuple([memoryFileUndoRequest])), forgetFile: args(z.tuple([memoryFileForgetRequest])),
  listMemories: args(z.tuple([text.optional()])), listInvalid: empty, listChanges: empty, profile: empty,
  profileView: args(z.tuple([z.union([project, z.strictObject({ kind: z.literal('user') })])])),
  fileProfile: args(z.tuple([project.optional()])),
  revision: empty, epoch: empty, cleanupPending: empty, onboarding: empty, rebuildIndexes: empty,
  setOnboarding: args(z.tuple([z.enum(['pending', 'done', 'skipped'])])),
  setProfile: args(z.tuple([z.record(z.string(), z.unknown()), key.optional()])),
  addMemory: args(z.tuple([text, key.optional(), key.optional()])),
  editMemory: args(z.tuple([integer, text, integer, key.optional()])),
  stopMemory: target, restoreMemory: target, deleteMemory: target,
  resolveConflictPair: args(z.tuple([side, side, z.discriminatedUnion('kind', [z.strictObject({ kind: z.enum(['keep-first', 'keep-both', 'discard-both']) }), z.strictObject({ kind: z.literal('replace'), text })]), key.optional(), integer.optional(), interval.optional()])),
  undoChange: args(z.tuple([integer, integer, key.optional(), z.array(side)])),
  bindProject: args(z.tuple([key, project.optional()])), projectChanged: args(z.tuple([key.nullish(), project.optional()])),
  allowsEvidence: args(z.tuple([maybeProvenance, project.optional()])), stale: args(z.tuple([key.nullish(), project.optional()])),
  allowsSession: args(z.tuple([key, project.optional()])), recoverContext: args(z.tuple([key])), transferable: args(z.tuple([maybeProvenance])),
  transferStatus: args(z.tuple(transfer)), transfer: args(z.tuple([key, ...transfer])),
  canInherit: args(z.tuple(inheritance)), inherit: args(z.tuple([key, ...inheritance])),
  inheritFork: args(z.tuple([key, ...inheritance])),
  allowsProjectHistory: args(z.tuple([occurrence, project.optional(), project.optional(), project.optional()])),
  useHistory: args(z.tuple([key.optional(), occurrence])), provenance: args(z.tuple([key])), authorizedProvenance: z.strictObject({ session: key, prior: provenance.optional(), sourceId: key.optional() }),
  recordSession: args(z.tuple([key])), sessionProject: args(z.tuple([key])), recordSessionProject: args(z.tuple([key, z.string()])),
  recordDeliveredSource: args(z.tuple([key, key, z.boolean(), key])), isDerivedDelivery: args(z.tuple([key])),
  replaySources: args(z.tuple([z.array(key), text, project.optional()])),
  forgetIntent: args(z.tuple([text, scope.optional(), project.optional()])), correctionIntent: args(z.tuple([text, scope.optional(), project.optional()])),
  bindWireAlias: args(z.tuple([key, text, text, key.optional(), wireSpans])),
  cancelFileClarification: args(z.tuple([key, key])),
  clarificationQuestion: args(z.tuple([key, key, key, z.enum(['show', 'check'])])),
  authorizeGeneralQuestion: args(z.tuple([key, key, z.array(z.strictObject({ id: key, question: text, header: z.string(), multiSelect: z.boolean(), options: z.array(z.strictObject({ label: text, description: text.optional() })) })), key.nullable(), scope, project.optional(), z.enum(['show', 'check']).optional()])),
  acceptQuestionAnswer: z.strictObject({ operationId: z.uuid(), session: key, conversation: key, text, question: text, requestId: key, questionId: key, context: scope, project: project.optional() }),
  sourceAlias: z.strictObject({ operationId: key, sourceId: key, session: key, conversation: key, text, wireText: text.optional(), wireSpans, context: scope.optional(), project: project.optional(), origin: z.enum(['original', 'derived']).optional(), dependencies: provenance.optional() }),
  prepareSourceChange: z.strictObject({ operationId: z.uuid(), conversation: key, ids: z.array(key), onlySources: z.literal(true).optional(), replacement: z.strictObject({ sourceId: key, segmentId: key, projectId: key.nullish() }).optional() }),
  commitSourceChange: z.strictObject({ operationId: z.uuid(), ticket: key }), getOperation: z.strictObject({ operationId: z.uuid() }),
  pendingHostEffects: z.strictObject({}), ackHostEffect: z.strictObject({ effectId: key, causeOperationId: z.uuid(), revision: integer }),
} satisfies Record<HostMemoryMethod, z.ZodType>
export function parseHostMemoryCommand(method: unknown, input: unknown): HostMemoryCommand {
  if (typeof method !== 'string' || !Object.hasOwn(hostMemoryInputSchemas, method)) throw new Error('Unknown memory host method')
  const name = method as HostMemoryMethod
  return { method: name, input: hostMemoryInputSchemas[name].parse(input) } as HostMemoryCommand
}
export const memoryOwnerState = z.strictObject({ type: z.literal('memory_owner_state'), protocol: z.literal(MEMORY_HOST_PROTOCOL),
  epoch: key, state: z.enum(['ready', 'recovering', 'unavailable']), revision: integer, coreEpoch: integer, effectsRevision: integer.optional() })
export type MemoryOwnerState = z.infer<typeof memoryOwnerState>

/** Transient committed-change receipt; never stored in the metadata snapshot. */
export const memoryOwnerChange = z.strictObject({ type: z.literal('memory_owner_change'), protocol: z.literal(MEMORY_HOST_PROTOCOL),
  epoch: key, revision: integer, ids: z.array(integer), learned: z.array(text).optional(), invalidated: z.array(integer).optional() })
export type MemoryOwnerChange = z.infer<typeof memoryOwnerChange>

export const memoryOwnerContextUsed = z.strictObject({ type: z.literal('memory_owner_context_used'), protocol: z.literal(MEMORY_HOST_PROTOCOL),
  epoch: key, revision: integer, session: key, conversation: key.nullable(), turn: integer, at: integer,
  pushed: z.array(z.strictObject({ text, names: z.array(text) })) })
export type MemoryOwnerContextUsed = z.infer<typeof memoryOwnerContextUsed>
export const memoryOwnerProjection = z.strictObject({ type: z.literal('memory_owner_projection'), protocol: z.literal(MEMORY_HOST_PROTOCOL),
  epoch: key, revision: integer })
export type MemoryOwnerProjection = z.infer<typeof memoryOwnerProjection>
