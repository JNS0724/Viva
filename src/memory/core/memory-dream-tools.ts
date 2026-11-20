import { z } from 'zod'
import { dailyPath, digestPath, parseIntegrateReceipt } from '../contracts/memory-file-contract.ts'
import type { DreamUnit, IntegrateReceipt } from '../contracts/memory-file-contract.ts'
import type { MemoryModelJob, MemorySourceReference, MemoryToolExecutor } from '../contracts/service.ts'
import { parseMemoryDocument, memoryDocumentLines, readMemoryLines, updateMemoryFrontmatter } from './memory-document.ts'
import { lexMemoryMarkdownBody, parseMemoryMarkdown } from './memory-markdown.ts'
import { memorySearchTokens } from './search-tokens.ts'
import type { DocumentSupersession } from './ports/documents.ts'

/** The caller supplies an already-authorized workspace view, including applicability filtering.
 * Extra identity/usage-version fields are preserved for the final store readset. */
export interface DreamDocumentSnapshot {
  path: string
  revision: string
  markdown: string
  sources: readonly MemorySourceReference[]
  usageVersion?: number
  policyToken?: string
  /** Trusted applicability view from the document service, never model-supplied frontmatter. */
  applicability?: { state: 'current' | 'superseded' | 'unavailable', supersessions: readonly DocumentSupersession[] }
}

export class MemoryDreamStaleError extends Error {
  constructor() { super('memory-dream-readset-stale'); this.name = 'MemoryDreamStaleError' }
}
class DreamToolError extends Error {}
const reject = (code: string): never => { throw new DreamToolError(code) }
const readablePath = z.union([dailyPath, digestPath])
const inputSchemas = {
  node_search: z.strictObject({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(50).optional() }),
  read: z.strictObject({ path: readablePath, start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() }),
  frontmatter_read: z.strictObject({ path: readablePath }),
  write: z.strictObject({ path: digestPath, markdown: z.string().min(1) }),
  edit: z.strictObject({ path: digestPath, old_text: z.string().min(1), new_text: z.string() }),
  frontmatter_update: z.strictObject({ path: digestPath, patch: z.record(z.string(), z.json()) }),
} as const
type ToolName = keyof typeof inputSchemas

const descriptions: Record<ToolName, string> = {
  node_search: 'Search all authorized digest node names, descriptions and tags, without returning document bodies. Search before choosing an integration target; read matching nodes to distinguish same_abstraction, related or unrelated.',
  read: 'Read authorized daily/digest Markdown with independent 1-based line bounds. Read a matching digest before changing it. Reads add document/source versions to this job dependency set.',
  frontmatter_read: 'Read frontmatter of an authorized daily/digest file. Does not read another workspace or grant permission to change sources.',
  write: 'Write a complete isolated digest draft. Exactly one target is allowed per unit; CREATE must use the unit bucket. Preserve existing metadata, supporting Sources and related links. Cite every supplied daily path with a real [[daily/...md]] wikilink; plain paths and links inside code do not count. Repair rejected drafts before reporting success. Nothing is committed by this tool.',
  edit: 'Replace one unique exact text occurrence in the isolated digest draft. Read the existing digest first. Ambiguous or missing text is rejected; there is no global replacement.',
  frontmatter_update: 'Merge JSON fields into the isolated digest draft frontmatter while preserving its body and unrelated fields. Exactly one target is allowed.',
}

export const memoryDreamToolDefinitions: MemoryModelJob['tools'] = Object.freeze(
  (Object.keys(inputSchemas) as ToolName[]).map(name => Object.freeze({
    name, description: descriptions[name], schema: z.json().parse(z.toJSONSchema(inputSchemas[name])),
  })),
)

/** Only real Markdown wikilinks count. Code examples and escaped syntax are not evidence. */
export function memoryDocumentLinks(markdown: string): string[] {
  return [...new Set(parseMemoryMarkdown(markdown).links
    .filter(link => readablePath.safeParse(link.path).success)
    .map(link => link.path + (link.anchor === undefined ? '' : `#${link.anchor}`)))]
}

// Compare parsed frontmatter so reordering YAML keys or changing quoting never changes the decision.
function metadataValue(metadata: Record<string, unknown>) {
  return JSON.stringify(metadata, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)
}

// Limit unreviewed citations to plain read paths and fixed support wording. An arbitrary
// sentence copied from the Sources section could apply an old exception to a new case.
function isSourceCitation(line: string, allowed: ReadonlySet<string>, bare = false): boolean {
  const wikilink = /\[\[([^\]\r\n]+)\]\]/gu
  const paths = [...line.matchAll(wikilink)]
  if (!paths.length || paths.some(match => !allowed.has(match[1]!))) return false
  const template = line.replace(wikilink, '[[source]]').trim()
  return /^(?:[-*+]\s+)?(?:\[\[source\]\][ ,，、。.]*)+$/u.test(template)
    || !bare && /^(?:Sources?\s*:\s*|来源[：:]\s*)(?:\[\[source\]\][ ,，、。.]*)+$/iu.test(template)
}

// Keep the block context from the same lexer as the index. An edit to a fence or
// a setext underline can change the meaning of identical text on a later line.
function conclusionLines(body: string) {
  return lexMemoryMarkdownBody(body.replace(/\r\n?/gu, '\n')).flatMap(block => block.raw.split('\n')
    .filter(line => line.trim()).map(line => ({ text: line.trimEnd(), block: block.type })))
}

/** Compare the actual conclusion and metadata with the retained document, independently of the receipt label. */
export function dreamChangesConclusion(before: string, after: string, dailyPaths: readonly string[]): boolean {
  const original = parseMemoryDocument(before), proposed = parseMemoryDocument(after)
  if (metadataValue(original.metadata) !== metadataValue(proposed.metadata)) return true
  const prior = conclusionLines(original.body)
  const sources = /^#{1,6}\s+(?:Sources|来源|来源依据)\s*$/iu
  const allowed = new Set(dailyPaths)
  let index = 0, inSources = false
  for (const line of conclusionLines(proposed.body)) {
    const previous = prior[index]
    if (line.text === previous?.text && line.block === previous.block) {
      if (line.block === 'heading') inSources = sources.test(line.text)
      index++
    } else if (index === prior.length && !inSources && line.block === 'heading' && sources.test(line.text)) {
      inSources = true
    } else if (previous?.block === 'paragraph' && line.block === 'paragraph' && line.text.startsWith(previous.text + ' ')
      && isSourceCitation(line.text.slice(previous.text.length), allowed, true)) {
      index++
    } else if (!inSources || !['paragraph', 'list'].includes(line.block) || !isSourceCitation(line.text, allowed)) {
      return true
    }
  }
  return index !== prior.length
}

export function dreamNodeMetadata(snapshot: Pick<DreamDocumentSnapshot, 'markdown' | 'path'>) {
  const { metadata } = parseMemoryDocument(snapshot.markdown)
  const name = typeof metadata.name === 'string' ? metadata.name : snapshot.path.split('/').at(-1)!.replace(/\.md$/u, '')
  const description = typeof metadata.description === 'string' ? metadata.description : ''
  const tags = Array.isArray(metadata.memory_tags) ? metadata.memory_tags.filter((tag): tag is string => typeof tag === 'string') : []
  return { name, description, tags }
}

/** R3's complete-workspace lexical node search; R4 may replace its index under this contract.
 * Body text never participates in ranking or output. No recent-file or prefix cutoff. */
export function searchMemoryNodes<S extends DreamDocumentSnapshot>(snapshots: readonly S[], query: string, limit = 5) {
  const input = inputSchemas.node_search.parse({ query, limit })
  const terms = [...new Set(memorySearchTokens(input.query, false))]
  if (!terms.length) return []
  const nodes = snapshots.filter(snapshot => digestPath.safeParse(snapshot.path).success && (!snapshot.applicability || snapshot.applicability.state === 'current')).map(snapshot => {
    const summary = dreamNodeMetadata(snapshot)
    const tokens = memorySearchTokens([summary.name, summary.description, ...summary.tags].join(' '), true)
    return { snapshot, summary, tokens }
  })
  const average = nodes.reduce((sum, node) => sum + node.tokens.length, 0) / (nodes.length || 1) || 1
  const frequency = new Map(terms.map(term => [term, nodes.filter(node => node.tokens.includes(term)).length]))
  return nodes.map(node => {
    const score = terms.reduce((sum, term) => {
      const tf = node.tokens.filter(token => token === term).length
      if (!tf) return sum
      const df = frequency.get(term)!
      const idf = Math.log(1 + (nodes.length - df + 0.5) / (df + 0.5))
      return sum + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * node.tokens.length / average))
    }, 0)
    return { ...node, score }
  }).filter(node => node.score > 0).sort((a, b) => b.score - a.score || a.snapshot.path.localeCompare(b.snapshot.path))
    .slice(0, input.limit ?? 5).map(({ snapshot, summary, score }) => ({ snapshot, summary, score }))
}

export type DreamDraftResult<S extends DreamDocumentSnapshot> = {
  receipt: IntegrateReceipt, path: string, before: S | null, markdown: string, reads: S[],
}

/** Isolated per-unit draft and readset. This module never opens files or invokes the model.
 * The caller independently reviews changes to existing conclusions against canonical user
 * sources and revalidates the authorized dependency set for every commit. */
/** Opaque to the model; a repeated query continues only the same candidate set. */
export type DreamSearchPage = { fingerprint: string, offset: number }
type DreamFiles<S> = { partial?: boolean, next?: DreamSearchPage, read(path: string): S | null, list(): readonly S[] }

export function createMemoryDreamTools<S extends DreamDocumentSnapshot>({ unit, documents, onRead = () => {}, allowsDraftMaterial }: {
  unit: DreamUnit,
  documents: DreamFiles<S> & { locatorRetired?: (path: string) => boolean, load?(paths: string[], search: { query: string, limit?: number, page?: DreamSearchPage } | null, signal?: AbortSignal): Promise<DreamFiles<S>> },
  onRead?: (snapshot: S) => void,
  /** Early repair feedback only. The caller must still revalidate material and evidence before commit. */
  allowsDraftMaterial?: (markdown: string) => boolean,
}) {
  const observed = new Map<string, S>()
  const bodyReads = new Set<string>()
  let target: { path: string, before: S | null, markdown: string } | null = null
  let searched = false
  const incompleteSearches = new Map<string, DreamSearchPage | undefined>()
  const current = (read = documents.read) => [...observed.values()].every(snapshot => {
    const latest = read(snapshot.path)
    return latest?.revision === snapshot.revision && latest?.usageVersion === snapshot.usageVersion && latest?.policyToken === snapshot.policyToken
      && JSON.stringify(latest?.sources) === JSON.stringify(snapshot.sources)
      && JSON.stringify(latest?.applicability) === JSON.stringify(snapshot.applicability)
  }) && (!target || target.before !== null || read(target.path) === null)
  const checkedPaths = () => [...observed.keys(), ...(target ? [target.path] : [])]
  const assertCurrent = (lookup = documents.read) => { if (!current(lookup)) throw new MemoryDreamStaleError() }
  function observe(snapshot: S) {
    const previous = observed.get(snapshot.path)
    if (previous && (previous.revision !== snapshot.revision || previous.usageVersion !== snapshot.usageVersion || previous.policyToken !== snapshot.policyToken)) throw new MemoryDreamStaleError()
    if (!previous) {
      const captured = structuredClone(snapshot)
      // Bind dependencies before any part of the snapshot can reach model tool results.
      onRead(captured)
      observed.set(snapshot.path, captured)
    }
    return observed.get(snapshot.path)!
  }
  function read(path: string, lookup = documents.read) {
    const snapshot = lookup(path)
    if (!snapshot || snapshot.applicability?.state === 'unavailable') return reject('memory-dream-document-unavailable')
    return observe(snapshot)
  }
  function unitSourceLinks(markdown: string) {
    const links = new Set(memoryDocumentLinks(markdown))
    for (const source of unit.paths) {
      if (![...links].some(link => link.split('#')[0] === source)) return reject('memory-dream-unit-source-missing')
    }
    return links
  }
  function draft(path: string, markdown: string, lookup = documents.read) {
    if (!searched) return reject('memory-dream-search-required')
    if (target && target.path !== path) return reject('memory-dream-single-target-required')
    const before = target?.before ?? lookup(path)
    if (!before && incompleteSearches.size) return reject('memory-dream-search-incomplete')
    if (!before && documents.locatorRetired?.(path)) return reject('memory-dream-target-unavailable')
    if (before && !bodyReads.has(path)) return reject('memory-dream-read-target-first')
    // Parse before mutating draft state; an invalid attempt does not poison later corrections.
    try { parseMemoryDocument(markdown) } catch { return reject('memory-dream-invalid-document') }
    unitSourceLinks(markdown)
    if (allowsDraftMaterial && !allowsDraftMaterial(markdown)) return reject('memory-dream-draft-material-unavailable')
    target = { path, before: before ? observed.get(path)! : null, markdown }
    return { path, staged: true }
  }
  const sources = () => {
    const refs = [...observed.values()].flatMap(snapshot => snapshot.sources)
    return [...new Map(refs.map(ref => [JSON.stringify([ref.namespace, ref.sourceId, ref.occurrenceId, ref.revision]), ref])).values()]
  }
  const executeTool: MemoryToolExecutor = async (invocation, signal) => {
    signal?.throwIfAborted()
    try {
      const schema = inputSchemas[invocation.name as ToolName]
      if (!schema || !Object.hasOwn(inputSchemas, invocation.name)) return reject('memory-dream-tool-not-allowed')
      const parsed = schema.safeParse(invocation.input)
      if (!parsed.success) return reject('memory-dream-invalid-tool-input')
      const paths = checkedPaths()
      if ('path' in parsed.data) paths.push(parsed.data.path)
      const search = invocation.name === 'node_search' ? inputSchemas.node_search.parse(invocation.input) : null
      const files = documents.load ? await documents.load(paths, search && { ...search, page: incompleteSearches.get(search.query) }, signal) : documents
      assertCurrent(files.read)
      let result: unknown
      switch (invocation.name) {
        case 'node_search': {
          const input = inputSchemas.node_search.parse(invocation.input)
          result = searchMemoryNodes(files.list(), input.query, input.limit).map(({ snapshot, summary, score }) => {
            observe(snapshot)
            return { path: snapshot.path, revision: snapshot.revision, ...summary, score, ...(snapshot.applicability ? { applicability: snapshot.applicability } : {}) }
          })
          if (files.partial) {
            incompleteSearches.set(input.query, files.next)
            result = { partial: true, nodes: result }
          } else incompleteSearches.delete(input.query)
          searched = true
          break
        }
        case 'read': {
          const { path, start_line = 1, end_line } = inputSchemas.read.parse(invocation.input)
          const snapshot = target?.path === path ? { ...target.before, path, markdown: target.markdown } : read(path, files.read)
          const total = memoryDocumentLines(snapshot.markdown).length
          if (start_line > total || end_line !== undefined && end_line < start_line) return reject('memory-dream-line-range')
          const end = Math.min(end_line ?? total, total)
          bodyReads.add(path)
          result = { path, start_line, end_line: end, markdown: readMemoryLines(snapshot.markdown, start_line, end), ...(snapshot.applicability ? { applicability: snapshot.applicability } : {}) }
          break
        }
        case 'frontmatter_read': {
          const { path } = inputSchemas.frontmatter_read.parse(invocation.input)
          const snapshot = target?.path === path ? target.before : read(path, files.read)
          result = { path, metadata: parseMemoryDocument(target?.path === path ? target.markdown : snapshot!.markdown).metadata,
            ...(snapshot?.applicability ? { applicability: snapshot.applicability } : {}) }
          break
        }
        case 'write': {
          const { path, markdown } = inputSchemas.write.parse(invocation.input)
          result = draft(path, markdown, files.read)
          break
        }
        case 'edit': {
          const { path, old_text, new_text } = inputSchemas.edit.parse(invocation.input)
          const markdown = target?.path === path ? target.markdown : read(path, files.read).markdown
          const index = markdown.indexOf(old_text)
          if (index === -1 || markdown.indexOf(old_text, index + 1) !== -1) return reject('memory-dream-edit-not-unique')
          result = draft(path, markdown.slice(0, index) + new_text + markdown.slice(index + old_text.length), files.read)
          break
        }
        case 'frontmatter_update': {
          const { path, patch } = inputSchemas.frontmatter_update.parse(invocation.input)
          const markdown = target?.path === path ? target.markdown : read(path, files.read).markdown
          result = draft(path, updateMemoryFrontmatter(markdown, patch), files.read)
          break
        }
      }
      assertCurrent(files.read)
      return { callId: invocation.callId, state: 'completed', content: JSON.stringify(result), sources: sources() }
    } catch (error) {
      if (!(error instanceof DreamToolError)) throw error
      const content = error.message === 'memory-dream-unit-source-missing' ? JSON.stringify({ code: error.message,
        message: 'Cite every required daily path with a real [[workspace-relative/path.md]] wikilink outside code. Then retry the draft tool.',
        requiredPaths: unit.paths }) : error.message === 'memory-dream-draft-material-unavailable' ? JSON.stringify({ code: error.message,
          message: 'The draft contains unavailable material or an invalid source reference. Do not copy or invent daily session_id/source_conversation metadata into a new digest. Keep backend-issued paths exact, remove unsupported material, and retry the draft tool.' }) : error.message
      return { callId: invocation.callId, state: 'rejected', content, sources: sources() }
    }
  }
  function finish(value: unknown, lookup = documents.read): DreamDraftResult<S> {
    assertCurrent(lookup)
    if (!target) return reject('memory-dream-missing-draft')
    if (!target.before && incompleteSearches.size) return reject('memory-dream-search-incomplete')
    const receipt = parseIntegrateReceipt(value, [target.path])
    if ((receipt.action === 'CREATE') !== (target.before === null)) return reject('memory-dream-action-target-mismatch')
    if (receipt.action === 'CREATE' && !target.path.startsWith(`digest/${unit.bucket}/`)) return reject('memory-dream-create-bucket')
    const final = parseMemoryDocument(target.markdown)
    if (typeof final.metadata.name !== 'string' || !final.metadata.name.trim()
      || typeof final.metadata.description !== 'string' || !final.metadata.description.trim()) return reject('memory-dream-summary-required')
    const links = unitSourceLinks(target.markdown)
    for (const source of unit.paths) {
      read(source, lookup)
    }
    if (target.before) {
      for (const link of memoryDocumentLinks(target.before.markdown)) if (!links.has(link)) return reject('memory-dream-existing-link-removed')
      for (const key of Object.keys(parseMemoryDocument(target.before.markdown).metadata)) {
        if (!Object.hasOwn(final.metadata, key)) return reject('memory-dream-existing-metadata-removed')
      }
    }
    assertCurrent(lookup)
    return { receipt, path: target.path, before: target.before, markdown: target.markdown, reads: [...observed.values()] }
  }
  return { tools: memoryDreamToolDefinitions, executeTool, finish, searchIncomplete: () => incompleteSearches.size > 0, reads: () => [...observed.values()], checkedPaths, current }
}
