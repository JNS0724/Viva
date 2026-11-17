import type { MemoryScope } from '../contracts/memory-contract.ts'
export const memoryScopeKey = (scope: MemoryScope) => scope.kind === 'user' ? '{"kind":"user"}' : JSON.stringify({ kind: scope.kind, id: scope.id })

/** A user source is global. Other sources require the owning active scope. */
export function contextAllows(owned: MemoryScope, scope: MemoryScope | undefined) {
  return owned.kind === 'user' || (scope?.kind !== 'user' && scope?.kind === owned.kind && scope.id === owned.id)
}
