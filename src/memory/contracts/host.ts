import type { MemoryDreamStatus } from './dream-status.ts'
import { z } from 'zod'
import type { MemoryScope } from './memory-contract.ts'
import type { TextSpan } from './text-spans.ts'
import type { MemoryOperationOutcome } from './service.ts'
import { memoryFileListRequest, memoryFileIdentity, memoryFileSetEnabledRequest, memoryFileForgetRequest, memoryFileUndoRequest, memoryFileCreateRequest, memoryFileEditRequest } from './file-management.ts'
import type { MemoryFileListRequest, MemoryFileListResult, MemoryManagedFileIdentity, MemoryFileDetail,
  MemoryFileSetEnabledRequest, MemoryFileForgetRequest, MemoryFileUndoRequest, MemoryFileMutationResult, MemoryFileCreateRequest, MemoryFileEditRequest } from './file-management.ts'

/** Trusted parent-process adapter protocol. This is not available to model tools. */
export const MEMORY_HOST_PROTOCOL = 4
/** Business lifetime metadata, never part of the optional diagnostic envelope. */
export const memoryHostRead = z.strictObject({ readBatchId: z.uuid(), budgetMs: z.number().positive().max(10_000) })
export const MEMORY_PAGE_READ_METHODS: ReadonlySet<string> = new Set(['profilePage', 'cleanupPending', 'revision', 'listFiles', 'readFile'])
export type MemoryProject = { kind: 'project', id: string }
export type MemoryProfileSnapshot = { epoch: string, revision: number, text: string }
type HostQuestionCard = { id: string, question: string, header: string, multiSelect: boolean, options: Array<{ label: string, description?: string }> }
export type MemorySourceAlias = {
  operationId: string, sourceId: string, session: string, conversation: string,
  text: string, wireText: string, wireSpans?: TextSpan[], cwd?: string | null, context?: MemoryScope, project?: MemoryProject,
  origin?: 'original' | 'derived',
}
type Args<A extends readonly unknown[], O> = { input: { args: A }, output: O }
/** Deliberate whitelist: adding a host operation requires adding a decoder and an owner handler. */
export interface HostMemoryApi {
  dreamStatus: Args<[operationId?: string], MemoryDreamStatus>
  requestDream: Args<[operationId?: string], MemoryDreamStatus>
  listFiles: Args<[request: MemoryFileListRequest], MemoryFileListResult>
  readFile: Args<[identity: MemoryManagedFileIdentity], MemoryFileDetail | null>
  setFileEnabled: Args<[request: MemoryFileSetEnabledRequest], MemoryFileMutationResult>
  createFile: Args<[request: MemoryFileCreateRequest], MemoryFileMutationResult>
  editFile: Args<[request: MemoryFileEditRequest], MemoryFileMutationResult>
  forgetFile: Args<[request: MemoryFileForgetRequest], MemoryFileMutationResult>
  undoFile: Args<[request: MemoryFileUndoRequest], MemoryFileMutationResult>
  profilePage: Args<[project?: MemoryProject], { cleanupPending: number, revision: number, residentProfile: MemoryManagedFileIdentity | null }>
  revision: Args<[], number>
  epoch: Args<[], number>
  cleanupPending: Args<[], number>
  rebuildIndexes: Args<[], { fullText: boolean, semantic: boolean, files?: { lexical: boolean, vectorGeneration: number } }>
  acceptQuestionAnswer: { input: { operationId: string, session: string, conversation: string, text: string, turn: number, cards: readonly HostQuestionCard[], requestId: string, questionId: string, context: MemoryScope, project?: MemoryProject, questionAt?: number, questionProfileGen?: number }, output: { sourceId: string } }
  sourceAlias: { input: MemorySourceAlias, output: { sourceId: string, status?: 'accepted' | 'ignored' } }
  getOperation: { input: { operationId: string }, output: MemoryOperationOutcome | null }
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
// Node's JSON IPC encodes an undefined tuple slot as null. Only optional slots
// are restored; nullable domain values keep their meaning.
const args = <T extends z.ZodTuple>(schema: T) => z.strictObject({ args: z.preprocess(value => Array.isArray(value)
  ? value.map((item, index) => item === null && schema.def.items[index] && z.safeParse(schema.def.items[index], undefined).success ? undefined : item)
  : value, schema) })
const empty = args(z.tuple([]))
export const hostMemoryInputSchemas = {
  dreamStatus: args(z.tuple([z.uuid().optional()])), requestDream: args(z.tuple([z.uuid().optional()])),
  createFile: args(z.tuple([memoryFileCreateRequest])), editFile: args(z.tuple([memoryFileEditRequest])),
  listFiles: args(z.tuple([memoryFileListRequest])), readFile: args(z.tuple([memoryFileIdentity])),
  setFileEnabled: args(z.tuple([memoryFileSetEnabledRequest])), undoFile: args(z.tuple([memoryFileUndoRequest])), forgetFile: args(z.tuple([memoryFileForgetRequest])),
  profilePage: args(z.tuple([project.optional()])),
  revision: empty, epoch: empty, cleanupPending: empty, rebuildIndexes: empty,
  acceptQuestionAnswer: z.strictObject({ operationId: z.uuid(), session: key, conversation: key, text, turn: z.number().int().positive(),
    cards: z.array(z.strictObject({ id: key, question: text, header: z.string(), multiSelect: z.boolean(), options: z.array(z.strictObject({ label: text, description: text.optional() })) })),
    requestId: key, questionId: key, context: scope, project: project.optional(), questionAt: integer.optional(), questionProfileGen: integer.optional() }),
  sourceAlias: z.strictObject({ operationId: key, sourceId: key, session: key, conversation: key, text, wireText: text, wireSpans, cwd: z.string().nullish(), context: scope.optional(), project: project.optional(), origin: z.enum(['original', 'derived']).optional() }),
  getOperation: z.strictObject({ operationId: z.uuid() }),
} satisfies Record<HostMemoryMethod, z.ZodType>
export function parseHostMemoryCommand(method: unknown, input: unknown): HostMemoryCommand {
  if (typeof method !== 'string' || !Object.hasOwn(hostMemoryInputSchemas, method)) throw new Error('Unknown memory host method')
  const name = method as HostMemoryMethod
  return { method: name, input: hostMemoryInputSchemas[name].parse(input) } as HostMemoryCommand
}
export const memoryOwnerState = z.strictObject({ type: z.literal('memory_owner_state'), protocol: z.literal(MEMORY_HOST_PROTOCOL),
  epoch: key, state: z.enum(['ready', 'recovering', 'unavailable']), revision: integer, coreEpoch: integer, effectsRevision: integer.optional(), profileDeletionGen: integer.optional(), pid: z.number().int().positive().optional() })
export type MemoryOwnerState = z.infer<typeof memoryOwnerState>

/** Schema-agnostic L2 resident profile snapshot pushed by memory worker on ready and change. */
export const memoryOwnerProfile = z.strictObject({ type: z.literal('memory_owner_profile'), protocol: z.literal(MEMORY_HOST_PROTOCOL),
  epoch: key, revision: integer, text, profileDeletionGen: integer.optional() })
export type MemoryOwnerProfile = z.infer<typeof memoryOwnerProfile>

/** Transient committed-change receipt; never stored in the metadata snapshot. */
export const memoryOwnerChange = z.strictObject({ type: z.literal('memory_owner_change'), protocol: z.literal(MEMORY_HOST_PROTOCOL),
  epoch: key, revision: integer })
export type MemoryOwnerChange = z.infer<typeof memoryOwnerChange>

export const memoryOwnerContextUsed = z.strictObject({ type: z.literal('memory_owner_context_used'), protocol: z.literal(MEMORY_HOST_PROTOCOL),
  epoch: key, revision: integer, session: key, conversation: key.nullable(), turn: integer, at: integer,
  pushed: z.array(z.strictObject({ text, names: z.array(text) })) })
export type MemoryOwnerContextUsed = z.infer<typeof memoryOwnerContextUsed>
