import { z } from 'zod'
import { memorySourceReference } from './service.ts'

const opaque = z.string().min(1).max(512)
export const memoryFileIdentity = z.strictObject({ kind: z.enum(['daily', 'digest']), workspace: opaque, id: opaque })
export const memoryFileVersion = z.strictObject({ contentRevision: opaque, usageVersion: z.number().int().nonnegative(), policyToken: opaque })
export const memoryFileRestrictionId = z.uuid()
export const memoryFileUseRestriction = z.strictObject({ id: memoryFileRestrictionId, version: memoryFileVersion })
export const memoryFileCursor = z.strictObject({ snapshot: opaque, offset: z.number().int().nonnegative() })
export const memoryFileListRequest = z.strictObject({ kind: z.enum(['daily', 'digest']).optional(),
  state: z.enum(['all', 'enabled', 'disabled']).optional(), query: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(), cursor: memoryFileCursor.optional() })
export const memoryFileActions = z.strictObject({ setEnabled: z.boolean(), edit: z.literal(false), forget: z.literal(false), stop: z.boolean().optional(),
  undo: z.strictObject({ changeId: opaque }).nullable() })
export const memoryFileSummary = z.strictObject({ identity: memoryFileIdentity, version: memoryFileVersion,
  path: z.string().min(1).max(4096), title: z.string().max(200), enabled: z.boolean(), day: z.string().optional(),
  applicability: z.enum(['current', 'superseded', 'unavailable']), actions: memoryFileActions,
  hasProjection: z.boolean().optional(), restrictions: z.array(memoryFileUseRestriction).optional() })
export const memoryFileDetail = memoryFileSummary.extend({ markdown: z.string(), sources: z.array(memorySourceReference),
  stoppedSnapshot: z.strictObject({ restrictionId: memoryFileRestrictionId, markdown: z.string().nullable(), sources: z.array(memorySourceReference) }).optional(),
})
export const memoryFileListResult = z.strictObject({ status: z.enum(['ok', 'stale']), snapshot: opaque,
  items: z.array(memoryFileSummary).max(100), nextCursor: memoryFileCursor.nullable() })
const mutation = { operationId: z.uuid(), identity: memoryFileIdentity, version: memoryFileVersion }
export const memoryFileSetEnabledRequest = z.strictObject({ ...mutation, enabled: z.boolean(), restrictionId: memoryFileRestrictionId.optional() })
export const memoryFileForgetRequest = z.strictObject({ ...mutation, restrictionId: memoryFileRestrictionId.optional() })
export const memoryFileUndoRequest = z.strictObject({ ...mutation, changeId: opaque })
export const memoryFileMutation = z.discriminatedUnion('action', [
  memoryFileSetEnabledRequest.extend({ action: z.literal('setEnabled') }),
  memoryFileUndoRequest.extend({ action: z.literal('undo') }),
])
/** Durable receipt only. Read the file again for its current policy-bound version. */
export const memoryFileMutationResult = z.strictObject({ operationId: z.uuid(), identity: memoryFileIdentity,
  contentRevision: opaque, usageVersion: z.number().int().nonnegative(), action: z.enum(['ENABLE', 'DISABLE', 'UNDO', 'FORGET']), restrictionId: memoryFileRestrictionId.optional() })
export type MemoryManagedFileIdentity = z.infer<typeof memoryFileIdentity>
export type MemoryManagedFileVersion = z.infer<typeof memoryFileVersion>
export type MemoryFileListRequest = z.infer<typeof memoryFileListRequest>
export type MemoryFileListResult = z.infer<typeof memoryFileListResult>
export type MemoryFileSummary = z.infer<typeof memoryFileSummary>
export type MemoryFileDetail = z.infer<typeof memoryFileDetail>
export type MemoryFileMutation = z.infer<typeof memoryFileMutation>
export type MemoryFileSetEnabledRequest = z.infer<typeof memoryFileSetEnabledRequest>
export type MemoryFileForgetRequest = z.infer<typeof memoryFileForgetRequest>
export type MemoryFileUndoRequest = z.infer<typeof memoryFileUndoRequest>
export type MemoryFileMutationResult = z.infer<typeof memoryFileMutationResult>
