import { createHash } from 'node:crypto'
import { memorySemanticCases } from './memory-semantic-cases.ts'
import type { MemorySemanticCase } from './memory-semantic-cases.ts'

/** Frozen before the first real-provider request. A new corpus requires a separately named evaluation. */
export const MEMORY_SEMANTIC_FIXTURE_SHA256 = 'a008de4ab50817fb8a55ac862b14a9dfce7c13605770e03900acf926f3b8fa83'

export function checkMemorySemanticFreeze(cases: readonly MemorySemanticCase[] = memorySemanticCases) {
  const actual = createHash('sha256').update(JSON.stringify(cases)).digest('hex')
  if (actual !== MEMORY_SEMANTIC_FIXTURE_SHA256) throw new Error('Memory semantic corpus changed after its first real-model run')
  return actual
}
