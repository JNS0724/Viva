import type { MemoryScope } from '../contracts/memory-contract.ts'
export const memoryScopeKey = (scope: MemoryScope) => scope.kind === 'user' ? '{"kind":"user"}' : JSON.stringify({ kind: scope.kind, id: scope.id })
