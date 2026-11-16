import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'

const metadataSchema = z.record(z.string(), z.unknown())
export interface MemoryDocument {
  metadata: Record<string, unknown>
  body: string
  /** Original 1-based body start line, for later chunk/source mapping. */
  bodyStartLine: number
}

/** Every offset is UTF-16 in the original string. The newline occupies
 * [contentEndOffset, endOffset); CRLF is one newline, as are LF and lone CR. */
export interface MemoryDocumentLine { startOffset: number, contentEndOffset: number, endOffset: number }
export function memoryDocumentLines(markdown: string): MemoryDocumentLine[] {
  const lines: MemoryDocumentLine[] = []
  let startOffset = 0
  for (let offset = 0; offset < markdown.length; offset++) {
    if (markdown[offset] !== '\r' && markdown[offset] !== '\n') continue
    const contentEndOffset = offset
    if (markdown[offset] === '\r' && markdown[offset + 1] === '\n') offset++
    const endOffset = offset + 1
    lines.push({ startOffset, contentEndOffset, endOffset })
    startOffset = endOffset
  }
  // Match split-line semantics: an empty document and a final newline have an empty last line.
  lines.push({ startOffset, contentEndOffset: markdown.length, endOffset: markdown.length })
  return lines
}

/** Plain Markdown is allowed. Malformed frontmatter fails closed on the write path. */
export function parseMemoryDocument(markdown: string): MemoryDocument {
  const positions = memoryDocumentLines(markdown)
  const lines = positions.map(line => markdown.slice(line.startOffset, line.contentEndOffset))
  const isDelimiter = (line: string) => line === '---'
  if (!isDelimiter(lines[0] ?? '')) return { metadata: {}, body: markdown, bodyStartLine: 1 }
  const end = lines.findIndex((line, index) => index > 0 && isDelimiter(line))
  if (end === -1) throw new Error('unclosed-memory-frontmatter')
  const parsed = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true })
  if (parsed.errors.length) throw new Error('invalid-memory-frontmatter')
  const raw: unknown = parsed.toJS({ maxAliasCount: 0 })
  const metadata = metadataSchema.parse(raw ?? {})
  return { metadata, body: markdown.slice(positions[end]!.endOffset), bodyStartLine: end + 2 }
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
  const lines = memoryDocumentLines(markdown)
  const end = endLine ?? Math.max(startLine, lines.length)
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(end) || startLine < 1 || end < startLine) {
    throw new Error('invalid-memory-line-range')
  }
  const first = lines[startLine - 1], last = lines[Math.min(end, lines.length) - 1]
  return first && last ? markdown.slice(first.startOffset, last.contentEndOffset) : ''
}
