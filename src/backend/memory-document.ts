import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'

const metadataSchema = z.record(z.string(), z.unknown())
export interface MemoryDocument {
  metadata: Record<string, unknown>
  body: string
  /** Original 1-based body start line, for later chunk/source mapping. */
  bodyStartLine: number
}

/** Plain Markdown is allowed. Malformed frontmatter fails closed on the write path. */
export function parseMemoryDocument(markdown: string): MemoryDocument {
  const lines = markdown.split('\n')
  const isDelimiter = (line: string) => line.replace(/\r$/u, '') === '---'
  if (!isDelimiter(lines[0] ?? '')) return { metadata: {}, body: markdown, bodyStartLine: 1 }
  const end = lines.findIndex((line, index) => index > 0 && isDelimiter(line))
  if (end === -1) throw new Error('unclosed-memory-frontmatter')
  const parsed = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true })
  if (parsed.errors.length) throw new Error('invalid-memory-frontmatter')
  const raw: unknown = parsed.toJS({ maxAliasCount: 0 })
  const metadata = metadataSchema.parse(raw ?? {})
  return { metadata, body: lines.slice(end + 1).join('\n'), bodyStartLine: end + 2 }
}

export function formatMemoryDocument(document: Pick<MemoryDocument, 'metadata' | 'body'>): string {
  const metadata = metadataSchema.parse(document.metadata)
  const result = `---\n${stringify(metadata, { lineWidth: 0 })}---\n${document.body}`
  // Do not persist output that our own reader cannot consume (e.g. cyclic/aliased metadata).
  parseMemoryDocument(result)
  return result
}

/** Frontmatter-only edit preserves the body and all unrelated fields. */
export function updateMemoryFrontmatter(markdown: string, patch: Record<string, unknown>): string {
  const document = parseMemoryDocument(markdown)
  return formatMemoryDocument({ ...document, metadata: { ...document.metadata, ...patch } })
}

export function readMemoryLines(markdown: string, startLine = 1, endLine?: number): string {
  const lines = markdown.split('\n')
  const end = endLine ?? Math.max(startLine, lines.length)
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(end) || startLine < 1 || end < startLine) {
    throw new Error('invalid-memory-line-range')
  }
  return lines.slice(startLine - 1, end).join('\n')
}
