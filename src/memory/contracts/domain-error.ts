import { z } from 'zod'

/** Stable domain codes; adapters provide localized wording without importing core implementation. */
export const memoryDomainErrorCode = z.enum([
  'change.pending', 'credentials', 'invalid.text', 'not.found', 'operation.conflict',
  'profile.confirmed_too_long', 'restore.explicit', 'revision.conflict',
])
export type MemoryDomainErrorCode = z.infer<typeof memoryDomainErrorCode>
export const memoryDomainErrorDetails = z.strictObject({
  limit: z.number().int().positive(),
  actual: z.number().int().nonnegative(),
})
export type MemoryDomainErrorDetails = z.infer<typeof memoryDomainErrorDetails>

export function parseMemoryDomainErrorDetails(value: unknown): MemoryDomainErrorDetails | undefined {
  const parsed = memoryDomainErrorDetails.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function memoryHostFailure(error: unknown): {
  code: string
  reason: string
  domainCode?: MemoryDomainErrorCode
  domainDetails?: MemoryDomainErrorDetails
} {
  const value = error instanceof Error ? error : new Error('Memory request failed')
  const domain = memoryDomainErrorCode.safeParse('code' in value ? value.code : undefined)
  const details = parseMemoryDomainErrorDetails(
    'details' in value ? value.details : 'domainDetails' in value ? value.domainDetails : undefined,
  )
  return domain.success ? {
    code: domain.data === 'revision.conflict' ? 'revision-conflict' : domain.data === 'operation.conflict' ? 'operation-id-conflict'
      : domain.data === 'change.pending' ? 'unavailable' : 'invalid-input',
    domainCode: domain.data,
    ...(details ? { domainDetails: details } : {}),
    reason: value.message,
  } : { code: error instanceof z.ZodError ? 'invalid-input' : 'unavailable', reason: value.message }
}
