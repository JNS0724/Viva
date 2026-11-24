import { Lexer, Marked, Tokenizer } from 'marked'
import type { Token, Tokens } from 'marked'
import { isScalar, parseDocument, visit } from 'yaml'
import { DAILY_MEMORY_DEFAULTS } from '../contracts/memory-daily-defaults.ts'
import { memoryDocumentLines, parseMemoryDocument } from './memory-document.ts'

export interface MemoryMarkdownChunk {
  text: string
  startLine: number
  endLine: number
  /** UTF-16 offsets in the complete original file; endOffset is exclusive. */
  startOffset: number
  endOffset: number
  headingPath: string[]
  searchText: string
}
export interface MemoryMarkdownLink { path: string, anchor?: string, label?: string, line: number }
export interface ParsedMemoryMarkdown {
  metadata: Record<string, unknown>
  chunks: MemoryMarkdownChunk[]
  links: MemoryMarkdownLink[]
}

export function memoryWikiLink(content: string): Omit<MemoryMarkdownLink, 'line'> {
  const pipe = content.indexOf('|')
  const reference = (pipe < 0 ? content : content.slice(0, pipe)).trim()
  const hash = reference.indexOf('#')
  const path = (hash < 0 ? reference : reference.slice(0, hash)).trim()
  return { path, ...(hash < 0 ? {} : { anchor: reference.slice(hash + 1) }),
    ...(pipe < 0 ? {} : { label: content.slice(pipe + 1) }) }
}

function maskWikiLinks(text: string, erased: (path: string) => boolean, decode = (value: string): string | undefined => value) {
  return text.replace(/\[\[([^\]\r\n]+)\]\]/gu, (link, content: string) => {
    const decoded = decode(content)
    if (decoded === undefined) return link
    const { path } = memoryWikiLink(decoded)
    // The Markdown table tokenizer unescapes a pipe before lexing inline links.
    const tablePath = memoryWikiLink(decoded.replace(/\\\|/gu, '|')).path
    return erased(path) || erased(tablePath) ? ' '.repeat(link.length) : link
  })
}

function quotedScalar(text: string): string | undefined {
  const parsed = parseDocument(text)
  return !parsed.errors.length && isScalar(parsed.contents) && typeof parsed.contents.value === 'string' ? parsed.contents.value : undefined
}

/** Mask retired links while preserving the original source offsets and line endings. */
export function maskMemoryWikiLinks(markdown: string, erased: (path: string) => boolean): string {
  const projected = maskWikiLinks(markdown, erased)
  if (!/^---(?:\r\n|\r|\n)/u.test(projected)) return projected
  const lines = memoryDocumentLines(projected), start = lines[0]!.endOffset
  const end = lines.slice(1).find(line => projected.slice(line.startOffset, line.contentEndOffset) === '---')?.startOffset
  if (end === undefined) return projected
  // Match the reader's treatment of bare CR without shifting the original offsets.
  const frontmatter = parseDocument(projected.slice(start, end).replace(/\r(?!\n)/gu, '\n'))
  if (frontmatter.errors.length) return projected
  const replacements: Array<{ start: number, end: number, text: string }> = []
  visit(frontmatter, { Scalar(_, scalar) {
    const { range, type, value } = scalar
    if (!range || typeof value !== 'string' || (type !== 'QUOTE_DOUBLE' && type !== 'QUOTE_SINGLE') || maskWikiLinks(value, erased) === value) return
    const from = start + range[0], to = start + range[1]
    const raw = projected.slice(from, to), quote = raw[0]!
    const masked = maskWikiLinks(raw, erased, content => quotedScalar(`${quote}${content}${quote}`))
    const decoded = quotedScalar(masked)
    // Encoded brackets or folded escapes can hide the physical boundaries of a link.
    // If the narrower masking cannot be verified, hide this scalar's value as a whole.
    const text = decoded !== undefined && maskWikiLinks(decoded, erased) === decoded
      ? masked : quote + raw.slice(1, -1).replace(/[^\r\n]/g, ' ') + quote
    replacements.push({ start: from, end: to, text })
  } })
  return replacements.sort((a, b) => b.start - a.start).reduce((text, item) => text.slice(0, item.start) + item.text + text.slice(item.end), projected)
}

// The default lexer drops duplicate reference definitions. Keep their AST blocks
// so raw tokens remain a complete source partition; reference resolution stays first-wins.
const definitionTokenizer = new Tokenizer()
new Lexer({ gfm: true, tokenizer: definitionTokenizer })
const parser = new Marked({ gfm: true, extensions: [{
  name: 'memory_definition', level: 'block',
  tokenizer(source) {
    const token = definitionTokenizer.def(source)
    if (!token) return undefined
    this.lexer.tokens.links[token.tag] ??= { href: token.href, title: token.title ?? null }
    return { ...token, type: 'memory_definition' }
  },
}, {
  name: 'memory_wikilink', level: 'inline',
  start: source => source.indexOf('[['),
  tokenizer(source) {
    const match = /^\[\[([^\]\n]+)\]\]/u.exec(source)
    if (match) return { type: 'memory_wikilink', raw: match[0] }
    return undefined
  },
}] })
/** Top-level tokens partition the normalized Markdown body, including its whitespace. */
export function lexMemoryMarkdownBody(body: string) { return parser.lexer(body) }

const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).byteLength

type Mapped = { text: string, offsets: number[] }
/** Marked normalizes line endings. Keep a boundary map back to the untouched file. */
function normalized(markdown: string, start: number): Mapped {
  let text = ''
  const offsets: number[] = []
  for (let i = start; i < markdown.length; i++) {
    offsets.push(i)
    if (markdown[i] === '\r') {
      text += '\n'
      if (markdown[i + 1] === '\n') i++
    } else text += markdown[i]
  }
  offsets.push(markdown.length)
  return { text, offsets }
}
function sliceMapped(parent: Mapped, start: number, end: number): Mapped {
  return { text: parent.text.slice(start, end), offsets: parent.offsets.slice(start, end + 1) }
}
/** Locate child raw within its own AST parent, in sibling order. Nested list/quote
 * lexing removes indentation, so map lines separately rather than searching the file. */
function childMapped(parent: Mapped, raw: string, from: number): { mapped: Mapped, end: number } | null {
  let cursor = from
  const offsets: number[] = []
  const parts = raw.split('\n')
  for (const [i, part] of parts.entries()) {
    let start = part ? parent.text.indexOf(part, cursor) : cursor
    let expandedPrefix = 0
    if (start < 0) {
      // A tab in list indentation is expanded before the nested AST is lexed.
      // Map those synthetic leading spaces onto the original indentation only.
      expandedPrefix = /^[ \t]*/u.exec(part)![0].length
      if (!expandedPrefix || expandedPrefix === part.length) return null
      start = parent.text.indexOf(part.slice(expandedPrefix), cursor)
      if (start < 0 || /[^\t >]/u.test(parent.text.slice(cursor, start))) return null
    }
    if (start < 0 || (i > 0 && /[^\t >]/u.test(parent.text.slice(cursor, start)))) return null
    for (let j = 0; j < expandedPrefix; j++) offsets.push(parent.offsets[cursor]!)
    for (let j = expandedPrefix; j < part.length; j++) offsets.push(parent.offsets[start + j - expandedPrefix]!)
    cursor = start + part.length - expandedPrefix
    if (i < parts.length - 1) {
      if (parent.text[cursor] !== '\n') return null
      offsets.push(parent.offsets[cursor]!)
      cursor++
    }
  }
  offsets.push(parent.offsets[cursor]!)
  return { mapped: { text: raw, offsets }, end: cursor }
}

export function parseMemoryMarkdown(markdown: string, { maxBytes = DAILY_MEMORY_DEFAULTS.markdownChunkBytes }: { maxBytes?: number } = {}): ParsedMemoryMarkdown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error('invalid-memory-chunk-budget')
  const document = parseMemoryDocument(markdown)
  const lineStarts = memoryDocumentLines(markdown).map(line => line.startOffset)
  const bodyStart = lineStarts[document.bodyStartLine - 1] ?? markdown.length
  const body = normalized(markdown, bodyStart)
  const tokens = lexMemoryMarkdownBody(body.text)
  const chunks: MemoryMarkdownChunk[] = []
  const links: MemoryMarkdownLink[] = []
  const headings: Array<{ depth: number, text: string }> = []
  function lineAt(offset: number) {
    let lo = 0, hi = lineStarts.length
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid]! <= offset) lo = mid; else hi = mid }
    return lo + 1
  }
  function collect(sequence: readonly Token[], parent: Mapped) {
    let cursor = 0
    for (const token of sequence) {
      if (!token.raw) continue
      const located = childMapped(parent, token.raw, cursor)
      if (!located) continue // Never manufacture a source location when normalization is unmappable.
      cursor = located.end
      const mapped = located.mapped
      if (token.type === 'memory_wikilink') {
        const link = memoryWikiLink(token.raw.slice(2, -2))
        if (link.path) links.push({ ...link, line: lineAt(mapped.offsets[0]!) })
      } else if (token.type === 'list') collect((token as Tokens.List).items, mapped)
      else if (token.type === 'table') {
        const table = token as Tokens.Table
        // Cells omit delimiters; a monotonic cursor across the whole table disambiguates repeated cells.
        const cells = [table.header, ...table.rows].flat()
        let text = ''
        const offsets: number[] = []
        for (let i = 0; i < mapped.text.length; i++) {
          // Marked unescapes table-cell pipes before inline tokenization.
          if (mapped.text[i] === '\\' && mapped.text[i + 1] === '|') i++
          text += mapped.text[i]
          offsets.push(mapped.offsets[i]!)
        }
        offsets.push(mapped.offsets.at(-1)!)
        collect(cells.map(cell => ({ type: 'text', raw: cell.text, tokens: cell.tokens })), { text, offsets })
      } else if ('tokens' in token && token.tokens && token.type !== 'code' && token.type !== 'codespan' && token.type !== 'html') collect(token.tokens, mapped)
    }
  }
  collect(tokens, body)

  let pending: { start: number, end: number, headingPath: string[] } | null = null
  function flush() {
    if (!pending) return
    const { start, end, headingPath } = pending
    const text = markdown.slice(start, end)
    if (text.length) chunks.push({ text, startOffset: start, endOffset: end, startLine: lineAt(start),
      endLine: lineAt(Math.max(start, end - 1)), headingPath, searchText: [...headingPath, text].join('\n') })
    pending = null
  }
  function add(start: number, end: number) {
    if (start === end) return
    if (pending && bytes(markdown.slice(pending.start, end)) > maxBytes) flush()
    if (!pending) pending = { start, end, headingPath: headings.map(item => item.text) }
    else pending.end = end
  }
  function splitLeaf(start: number, end: number) {
    let part = start, cursor = start, used = 0, newline = start
    while (cursor < end) {
      const code = markdown.codePointAt(cursor)!
      const width = code > 0xffff || markdown[cursor] === '\r' && markdown[cursor + 1] === '\n' ? 2 : 1
      const size = bytes(markdown.slice(cursor, cursor + width))
      if (used + size > maxBytes) {
        const boundary = newline > part ? newline : cursor
        add(part, boundary); flush()
        part = boundary; cursor = boundary; used = 0; newline = boundary
        continue
      }
      cursor += width; used += size
      if (markdown[cursor - 1] === '\n' || markdown[cursor - 1] === '\r') newline = cursor
    }
    add(part, end)
  }
  let position = 0
  for (const token of tokens) {
    // Top-level raw is an exact partition of Marked's normalized input, including whitespace.
    if (body.text.slice(position, position + token.raw.length) !== token.raw) throw new Error('memory-markdown-source-mismatch')
    const start = body.offsets[position]!, end = body.offsets[position + token.raw.length]!
    const mapped = sliceMapped(body, position, position + token.raw.length)
    position += token.raw.length
    if (token.type === 'heading') {
      flush()
      const heading = token as Tokens.Heading
      while (headings.length && headings.at(-1)!.depth >= heading.depth) headings.pop()
      headings.push({ depth: heading.depth, text: heading.text })
    }
    if (bytes(markdown.slice(start, end)) <= maxBytes) add(start, end)
    else {
      flush()
      if (token.type === 'list') {
        let cursor = 0, previous = start
        for (const item of (token as Tokens.List).items) {
          const child = childMapped(mapped, item.raw, cursor)
          if (!child) continue
          const boundary = child.mapped.offsets.at(-1)!
          splitLeaf(previous, boundary)
          previous = boundary; cursor = child.end
        }
        splitLeaf(previous, end)
      } else splitLeaf(start, end)
    }
  }
  if (position !== body.text.length) throw new Error('memory-markdown-source-mismatch')
  flush()
  return { metadata: document.metadata, chunks, links }
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/gu, (full, hex?: string, dec?: string, named?: string) => {
    if (hex) {
      const cp = Number.parseInt(hex, 16)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full
    }
    if (dec) {
      const cp = Number.parseInt(dec, 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full
    }
    switch (named?.toLowerCase()) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return '\''
      case 'nbsp': return ' '
      default: return full
    }
  })
}

/** Extract visible rendered text from marked inline tokens (matches renderer/view/markdown.ts). */
function extractInlineVisibleText(tokens: readonly Token[] | undefined): string {
  if (!tokens?.length) return ''
  let out = ''
  for (const tok of tokens) {
    if (tok.type === 'html') {
      out += decodeHtmlEntities(tok.raw.replace(/<[^>]*>/gu, ''))
    } else if (tok.type === 'br') {
      out += ' '
    } else if (tok.type === 'memory_wikilink') {
      out += tok.raw
    } else if ('tokens' in tok && Array.isArray(tok.tokens) && tok.tokens.length > 0) {
      out += extractInlineVisibleText(tok.tokens)
    } else if ('text' in tok && typeof tok.text === 'string') {
      out += decodeHtmlEntities(tok.text)
    }
  }
  return out
}

function headingVisibleText(token: Tokens.Heading): string {
  return extractInlineVisibleText(token.tokens) || decodeHtmlEntities(token.text)
}

function collectNestedHeadingTexts(tokens: readonly Token[] | undefined, out: string[]): void {
  if (!tokens?.length) return
  for (const tok of tokens) {
    if (tok.type === 'code' || tok.type === 'codespan') continue
    if (tok.type === 'heading') {
      out.push(headingVisibleText(tok as Tokens.Heading))
    } else if (tok.type === 'list') {
      for (const item of (tok as Tokens.List).items) collectNestedHeadingTexts(item.tokens, out)
    } else if ('tokens' in tok && Array.isArray(tok.tokens)) {
      collectNestedHeadingTexts(tok.tokens, out)
    }
  }
}

export interface MarkdownBlockSummary {
  type: string
  raw: string
  startOffset: number
  endOffset: number
  headingText?: string
  nestedHeadingTexts?: string[]
}

/** Lex normalized LF Markdown body into top-level block summaries with exact offsets and visible heading text. */
export function inspectMarkdownBlocks(body: string): MarkdownBlockSummary[] {
  const tokens = lexMemoryMarkdownBody(body)
  const out: MarkdownBlockSummary[] = []
  let position = 0
  for (const token of tokens) {
    const startOffset = position
    const endOffset = position + token.raw.length
    position = endOffset
    if (token.type === 'heading') {
      out.push({ type: token.type, raw: token.raw, startOffset, endOffset, headingText: headingVisibleText(token as Tokens.Heading) })
    } else if (token.type === 'blockquote' || token.type === 'list') {
      const nested: string[] = []
      collectNestedHeadingTexts([token], nested)
      out.push({ type: token.type, raw: token.raw, startOffset, endOffset, ...(nested.length ? { nestedHeadingTexts: nested } : {}) })
    } else {
      out.push({ type: token.type, raw: token.raw, startOffset, endOffset })
    }
  }
  return out
}

/** Extract raw wikilink targets using the exact same Markdown wikilink AST traversal as parseMemoryMarkdown (case-preserved). */
export function rawMarkdownWikilinkTargets(markdown: string): string[] {
  try {
    return [...new Set(parseMemoryMarkdown(markdown).links.map(link => link.path))]
  } catch {
    const targets: string[] = []
    const collectTokens = (sequence: readonly Token[] | undefined): void => {
      if (!sequence?.length) return
      for (const token of sequence) {
        if (token.type === 'memory_wikilink') {
          const link = memoryWikiLink(token.raw.slice(2, -2))
          if (link.path) targets.push(link.path)
        } else if (token.type === 'list') {
          collectTokens((token as Tokens.List).items)
        } else if (token.type === 'table') {
          const table = token as Tokens.Table
          for (const cell of [table.header, ...table.rows].flat()) collectTokens(cell.tokens)
        } else if ('tokens' in token && token.tokens && token.type !== 'code' && token.type !== 'codespan' && token.type !== 'html') {
          collectTokens(token.tokens)
        }
      }
    }
    collectTokens(lexMemoryMarkdownBody(markdown.replace(/\r\n?/gu, '\n')))
    return [...new Set(targets)]
  }
}
