import { z } from 'zod'

/** Stable domain codes; adapters provide localized wording without importing core implementation. */
export const memoryDomainErrorCode = z.enum([
  'change.pending', 'credentials', 'invalid.text', 'not.found', 'operation.conflict', 'restore.explicit', 'revision.conflict',
])
export type MemoryDomainErrorCode = z.infer<typeof memoryDomainErrorCode>
export function memoryHostFailure(error: unknown) {
  const value = error instanceof Error ? error : new Error('Memory request failed')
  const domain = memoryDomainErrorCode.safeParse('code' in value ? value.code : undefined)
  return domain.success ? {
    code: domain.data === 'revision.conflict' ? 'revision-conflict' : domain.data === 'operation.conflict' ? 'operation-id-conflict'
      : domain.data === 'change.pending' ? 'unavailable' : 'invalid-input',
    domainCode: domain.data, reason: value.message,
  } : { code: error instanceof z.ZodError ? 'invalid-input' : 'unavailable', reason: value.message }
}
