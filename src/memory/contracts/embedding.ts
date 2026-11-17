export const MEMORY_EMBEDDING_DIMENSIONS = 384
export const MEMORY_EMBEDDING_BATCH = 8
export const MEMORY_EMBEDDING_MAX_CHARS = 1200



export type MemoryEmbeddingKind = 'query' | 'passage'
export type MemoryEmbeddingInput = { kind: MemoryEmbeddingKind, text: string }
export type MemoryEmbeddingResult = (Float32Array | null)[]

export interface MemoryEmbedder {
  /** Changes whenever model weights, normalization or input encoding change. */
  readonly fingerprint: string
  /** Adapter-declared vector width; core must not assume a particular model. */
  readonly dimensions: number
  embedBatch(inputs: readonly MemoryEmbeddingInput[], signal?: AbortSignal): Promise<MemoryEmbeddingResult | null>
  close(): void
}
