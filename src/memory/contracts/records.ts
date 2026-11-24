import type { TextSpan } from './text-spans.ts'

import type { MemoryScope } from './memory-contract.ts'
/** Exact accepted file/policy snapshot carried by every derived request. */
export type MemoryFileDependency = {
  workspace: string
  id: string
  path: string
  revision: string
  usageVersion: number
  policyToken: string
  /** Body-free evidence of this accepted projection, retained even after it changes. */
  sourceRanges: Array<{ sourceId: string; spans?: TextSpan[] }>
}
export interface MemorySource {
  id: string
  operation: string
  version: number
  conversation: string | null
  session: string | null
  scope: MemoryScope
  context: MemoryScope | null
  project?: MemoryScope | null
  author: 'user' | 'manual' | 'answer'
  text: string | null
  hash: string | null
  length: number
  question: string | null
  questionAt?: number | null
  requestId: string | null
  questionId: string | null
  at: number
  timezone: string
  outcome: string
}
