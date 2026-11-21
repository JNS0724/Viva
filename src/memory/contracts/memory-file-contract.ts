import { z } from 'zod'

/** Document bucket and action vocabulary. Buckets organize documents, not predicates. */
export const digestBuckets = Object.freeze(['personal', 'procedure', 'wiki'] as const)
export type DigestBucket = typeof digestBuckets[number]
export const digestActions = Object.freeze(['CREATE', 'CORROBORATE', 'REFINE', 'CORRECT'] as const)
export type DigestAction = typeof digestActions[number]

/** Portable workspace-relative path. The backend additionally checks symlinks and ownership. */
export function validMemoryPath(value: string): boolean {
  if (!value || value.startsWith('/') || /[\\\u0000-\u001f\u007f:#|\[\]<>?*"]/u.test(value)) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..' &&
    !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}

export const memoryFilePath = z.string().refine(validMemoryPath, 'invalid-memory-path')
export const digestPath = memoryFilePath.refine(value =>
  /^digest\/(personal|procedure|wiki)\/.+\.md$/u.test(value), 'invalid-digest-path')
export const dailyPath = memoryFilePath.refine(value =>
  /^daily\/\d{4}-\d{2}-\d{2}(?:\/.+)?\.md$/u.test(value), 'invalid-daily-path')

export const dreamEditSchema = z.strictObject({
  oldText: z.string().min(1),
  newText: z.string(),
})
export type DreamEdit = z.output<typeof dreamEditSchema>

const dreamOperationBase = {
  path: digestPath,
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  dailyPaths: z.array(dailyPath).min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
}

export const dreamCreateOperationSchema = z.strictObject({
  action: z.literal('CREATE'),
  ...dreamOperationBase,
  body: z.string().trim().min(1),
})

export const dreamRefineOperationSchema = z.strictObject({
  action: z.literal('REFINE'),
  ...dreamOperationBase,
  body: z.string().trim().min(1).optional(),
  edits: z.array(dreamEditSchema).min(1).optional(),
}).refine(operation => (operation.body !== undefined) !== (operation.edits !== undefined), {
  message: 'REFINE must supply either body or edits, not both',
})

export const dreamOperationSchema = z.discriminatedUnion('action', [
  dreamCreateOperationSchema,
  dreamRefineOperationSchema,
])
export type DreamOperation = z.output<typeof dreamOperationSchema>

export interface DreamPlan {
  operations: DreamOperation[]
  hasMore: boolean
}

/** Validate every path, source ID, target uniqueness, and optional continuation signal against batch inputs. */
export function parseDreamPlan(
  value: unknown,
  allowedDailyPaths: ReadonlySet<string>,
  allowedSourceIds: ReadonlySet<string>,
  maxOperations: number,
): DreamPlan {
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 0) throw new Error('invalid-dream-budget')
  const { operations, hasMore = false } = z.strictObject({
    operations: z.array(dreamOperationSchema).max(maxOperations),
    hasMore: z.boolean().optional(),
  }).parse(value)
  const targets = new Set<string>()
  const normalized = operations.map(operation => {
    if (targets.has(operation.path)) throw new Error('duplicate-dream-target')
    targets.add(operation.path)
    const dailyPaths = [...new Set(operation.dailyPaths)]
    if (dailyPaths.some(path => !allowedDailyPaths.has(path))) throw new Error('unknown-dream-daily')
    const sourceIds = [...new Set(operation.sourceIds)]
    if (sourceIds.some(id => !allowedSourceIds.has(id))) throw new Error('unknown-dream-source')
    return { ...operation, dailyPaths, sourceIds }
  })
  return { operations: normalized, hasMore: hasMore && normalized.length > 0 }
}

export function parseDreamOperations(
  value: unknown,
  allowedDailyPaths: ReadonlySet<string>,
  allowedSourceIds: ReadonlySet<string>,
  maxOperations: number,
): DreamOperation[] {
  return parseDreamPlan(value, allowedDailyPaths, allowedSourceIds, maxOperations).operations
}
