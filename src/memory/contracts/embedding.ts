export const MEMORY_EMBEDDING_DIMENSIONS = 384
export const MEMORY_EMBEDDING_BATCH = 8
export const MEMORY_EMBEDDING_FINGERPRINT = 'Xenova/multilingual-e5-small:q8:f80102d3f2a1229f:mean:query-passage-no-truncation-v1'
export const MEMORY_EMBEDDING_MAX_CHARS = 1200



export type MemoryEmbeddingKind = 'query' | 'passage'
export type MemoryEmbeddingInput = { kind: MemoryEmbeddingKind, text: string }
export type MemoryEmbeddingResult = (Float32Array | null)[]

export interface MemoryEmbedder {
  readonly fingerprint: string
  embedBatch(inputs: readonly MemoryEmbeddingInput[], signal?: AbortSignal): Promise<MemoryEmbeddingResult | null>
  close(): void
}
