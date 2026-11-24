import { memoryDomainErrorDetails, type MemoryDomainErrorDetails } from './domain-error.ts'

export const MEMORY_OWNER_RPC = 'memory_owner_rpc'
export const OWNER_RPC_MAX_BUDGET_MS = 3_600_000
export const OWNER_RPC_DEFAULT_BUDGET_MS = 5_000
export const OWNER_RPC_MAX_ACTIVE = 64

type Failure = { message: string, code?: string, reason?: string, details?: MemoryDomainErrorDetails }
type Envelope = { type: typeof MEMORY_OWNER_RPC }
export type OwnerRpcFrame = Envelope & (
  | { kind: 'request', id: string, method: string, input: unknown, budgetMs: number }
  | { kind: 'cancel', id: string }
  | { kind: 'result', id: string, ok: true, result: unknown }
  | { kind: 'result', id: string, ok: false, error: Failure }
  | { kind: 'event', event: unknown }
)

export function ownerRpcFrame(value: unknown): OwnerRpcFrame | null {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== MEMORY_OWNER_RPC || !('kind' in value)) return null
  if (value.kind === 'event' && 'event' in value) return value as OwnerRpcFrame
  if (!('id' in value) || typeof value.id !== 'string' || value.id.length !== 36) return null
  switch (value.kind) {
    case 'request':
      if ('method' in value && typeof value.method === 'string' && value.method.length < 64
        && 'budgetMs' in value && typeof value.budgetMs === 'number' && Number.isFinite(value.budgetMs)
        && value.budgetMs > 0 && value.budgetMs <= OWNER_RPC_MAX_BUDGET_MS) return value as OwnerRpcFrame
      return null
    case 'cancel': return value as OwnerRpcFrame
    case 'result':
      if (!('ok' in value)) return null
      if (value.ok === true) return value as OwnerRpcFrame
      if (value.ok === false && 'error' in value && value.error && typeof value.error === 'object'
        && 'message' in value.error && typeof value.error.message === 'string') {
        if ('details' in value.error && value.error.details !== undefined
          && !memoryDomainErrorDetails.safeParse(value.error.details).success) return null
        return value as OwnerRpcFrame
      }
      return null
    default: return null
  }
}
