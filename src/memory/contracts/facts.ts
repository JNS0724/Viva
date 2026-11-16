import type { MemorySpan } from './memory-contract.ts'
export interface FactTime {
  from: number | null
  to: number | null
  dated: boolean
  uncertain: boolean
}

export interface MemoryFact extends FactTime {
  subject: string
  predicate: string
  object: string
  relation: string
  polarity: 'positive' | 'negative' | 'uncertain'
  evidence: {
    statement: MemorySpan
    spans: MemorySpan[]
    subject?: MemorySpan
    relation: MemorySpan
    object: MemorySpan
    qualifiers: MemorySpan[]
    conditions: MemorySpan[]
    temporal: MemorySpan[]
  }
}

export interface MemoryInterval {
  from: number | null
  to: number | null
}
