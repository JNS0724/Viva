import { MEMORY_EMBEDDING_MAX_CHARS } from '../contracts/embedding.ts'
import type { MemoryFileChunk } from './ports/file-index.ts'

export interface MemoryFileEmbeddingPassage {
  /** Safe document title and all ancestor headings, repeated for every passage. */
  context: string
  body: string
  text: string
}
const passage = (context: string, body: string): MemoryFileEmbeddingPassage => ({ context, body, text: context + body })

/** The encoder budget includes context. Never silently drop a title/condition heading
 * to make a passage fit; callers fall back to lexical retrieval when context is too large. */
export function memoryFileEmbeddingPassages(chunk: Pick<MemoryFileChunk, 'text' | 'headingPath'>, name: string,
  width = MEMORY_EMBEDDING_MAX_CHARS): MemoryFileEmbeddingPassage[] | null {
  if (!Number.isSafeInteger(width) || width < 2) throw new Error('invalid-memory-passage-budget')
  const headings = [...new Set([name, ...chunk.headingPath].map(text => text.trim()).filter(Boolean))]
  const context = headings.length ? headings.join('\n') + '\n\n' : ''
  const available = width - context.length
  if (available < 2) return null
  const result: MemoryFileEmbeddingPassage[] = []
  let start = 0
  while (start < chunk.text.length) {
    let end = Math.min(start + available, chunk.text.length)
    if (end < chunk.text.length && /[\uD800-\uDBFF]/u.test(chunk.text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(chunk.text[end]!)) end--
    const body = chunk.text.slice(start, end)
    if (body.trim()) result.push(passage(context, body))
    start = end
  }
  return result
}

/** Retry a tokenizer-overflowing passage by bisecting its body, preserving the whole
 * contextual prefix. A single Unicode scalar cannot be split any further. */
export function splitMemoryFileEmbeddingPassage(input: MemoryFileEmbeddingPassage): MemoryFileEmbeddingPassage[] | null {
  let middle = Math.floor(input.body.length / 2)
  if (middle && /[\uD800-\uDBFF]/u.test(input.body[middle - 1]!) && /[\uDC00-\uDFFF]/u.test(input.body[middle]!)) middle += middle === 1 ? 1 : -1
  if (!middle || middle >= input.body.length) return null
  return [passage(input.context, input.body.slice(0, middle)), passage(input.context, input.body.slice(middle))]
}
