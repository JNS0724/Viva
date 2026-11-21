import { z } from 'zod'
import { dailyPath, digestPath } from '../contracts/memory-file-contract.ts'
import type { MemoryModelJob, MemorySourceReference, MemoryToolExecutor } from '../contracts/service.ts'
import { parseMemoryDocument, memoryDocumentLines, readMemoryLines } from './memory-document.ts'
import { parseMemoryMarkdown } from './memory-markdown.ts'
import { memorySearchTokens } from './search-tokens.ts'

/** Caller-supplied authorized workspace snapshot; extra identity/version fields are retained for commit CAS. */
export interface DreamDocumentSnapshot {
  path: string
  revision: string
  markdown: string
  sources: readonly MemorySourceReference[]
  usageVersion?: number
  policyToken?: string
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
} as const
type ToolName = keyof typeof inputSchemas

const descriptions: Record<ToolName, string> = {
  node_search: 'Search all authorized digest node names and descriptions without returning document bodies. Search before choosing CREATE or REFINE; read matching digests to inspect full content.',
  read: 'Read authorized daily or digest Markdown with optional 1-based line bounds. You must read a matching digest before using REFINE on it. Reads bind document and source versions to this job.',
}

export const memoryDreamToolDefinitions: MemoryModelJob['tools'] = Object.freeze(
  (Object.keys(inputSchemas) as ToolName[]).map(name => Object.freeze({
    name, description: descriptions[name], schema: z.json().parse(z.toJSONSchema(inputSchemas[name])),
  })),
)

/** Only real Markdown wikilinks count; code examples and escaped syntax are ignored. */
export function memoryDocumentLinks(markdown: string): string[] {
  return [...new Set(parseMemoryMarkdown(markdown).links
    .filter(link => readablePath.safeParse(link.path).success)
    .map(link => link.path + (link.anchor === undefined ? '' : `#${link.anchor}`)))]
}

export function dreamNodeMetadata(snapshot: Pick<DreamDocumentSnapshot, 'markdown' | 'path'>) {
  const { metadata } = parseMemoryDocument(snapshot.markdown)
  const name = typeof metadata.name === 'string' && metadata.name.trim()
    ? metadata.name
    : snapshot.path.split('/').at(-1)!.replace(/\.md$/u, '')
  const description = typeof metadata.description === 'string' ? metadata.description : ''
  return { name, description }
}

/** Complete-workspace lexical node search over digest names and descriptions; bodies never participate. */
export function searchMemoryNodes<S extends DreamDocumentSnapshot>(snapshots: readonly S[], query: string, limit = 10) {
  const input = inputSchemas.node_search.parse({ query, limit })
  const terms = [...new Set(memorySearchTokens(input.query, false))]
  if (!terms.length) return []
  const nodes = snapshots
    .filter(snapshot => digestPath.safeParse(snapshot.path).success)
    .map(snapshot => {
      const summary = dreamNodeMetadata(snapshot)
      const tokens = memorySearchTokens(`${summary.name} ${summary.description}`, true)
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
    .slice(0, input.limit ?? 10).map(({ snapshot, summary, score }) => ({ snapshot, summary, score }))
}

/** Opaque to the model; repeating a partial query continues through the same candidate set. */
export type DreamSearchPage = { fingerprint: string, offset: number }
type DreamFiles<S> = { partial?: boolean, next?: DreamSearchPage, read(path: string): S | null, list(): readonly S[] }

/** Read-only Dream exploration sandbox: node_search + read with readset version locking. */
export function createMemoryDreamTools<S extends DreamDocumentSnapshot>({ documents, onRead = () => {} }: {
  documents: DreamFiles<S> & {
    load?(paths: string[], search: { query: string, limit?: number, page?: DreamSearchPage } | null, signal?: AbortSignal): Promise<DreamFiles<S>>
  },
  onRead?: (snapshot: S) => void,
}) {
  const observed = new Map<string, S>()
  const bodyReads = new Set<string>()
  let didSearch = false
  const incompleteSearches = new Map<string, DreamSearchPage | undefined>()
  const current = (read = documents.read, ignorePaths?: ReadonlySet<string>) => [...observed.values()].every(snapshot => {
    if (ignorePaths?.has(snapshot.path)) return true
    const latest = read(snapshot.path)
    return latest?.revision === snapshot.revision && latest?.usageVersion === snapshot.usageVersion
      && latest?.policyToken === snapshot.policyToken
      && JSON.stringify(latest?.sources) === JSON.stringify(snapshot.sources)
  })
  const checkedPaths = () => [...observed.keys()]
  const assertCurrent = (lookup = documents.read) => { if (!current(lookup)) throw new MemoryDreamStaleError() }
  function observe(snapshot: S) {
    const previous = observed.get(snapshot.path)
    if (previous && (previous.revision !== snapshot.revision || previous.usageVersion !== snapshot.usageVersion
      || previous.policyToken !== snapshot.policyToken)) throw new MemoryDreamStaleError()
    if (!previous) {
      const captured = structuredClone(snapshot)
      onRead(captured)
      observed.set(snapshot.path, captured)
    }
    return observed.get(snapshot.path)!
  }
  function read(path: string, lookup = documents.read) {
    const snapshot = lookup(path)
    if (!snapshot) return reject('memory-dream-document-unavailable')
    return observe(snapshot)
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
      const files = documents.load
        ? await documents.load(paths, search && { ...search, page: incompleteSearches.get(search.query) }, signal)
        : documents
      assertCurrent(files.read)
      let result: unknown
      switch (invocation.name) {
        case 'node_search': {
          const input = inputSchemas.node_search.parse(invocation.input)
          result = searchMemoryNodes(files.list(), input.query, input.limit).map(({ snapshot, summary, score }) => {
            observe(snapshot)
            return { path: snapshot.path, revision: snapshot.revision, ...summary, score }
          })
          if (files.partial) {
            incompleteSearches.set(input.query, files.next)
            result = { partial: true, nodes: result }
          } else incompleteSearches.delete(input.query)
          didSearch = true
          break
        }
        case 'read': {
          const { path, start_line = 1, end_line } = inputSchemas.read.parse(invocation.input)
          const snapshot = read(path, files.read)
          const total = memoryDocumentLines(snapshot.markdown).length
          if (start_line > total || end_line !== undefined && end_line < start_line) return reject('memory-dream-line-range')
          const end = Math.min(end_line ?? total, total)
          bodyReads.add(path)
          result = { path, start_line, end_line: end, markdown: readMemoryLines(snapshot.markdown, start_line, end) }
          break
        }
      }
      assertCurrent(files.read)
      return { callId: invocation.callId, state: 'completed', content: JSON.stringify(result), sources: sources() }
    } catch (error) {
      if (!(error instanceof DreamToolError)) throw error
      return { callId: invocation.callId, state: 'rejected', content: error.message, sources: sources() }
    }
  }
  return {
    tools: memoryDreamToolDefinitions,
    executeTool,
    observed: (path: string) => observed.get(path) ?? null,
    bodyRead: (path: string) => bodyReads.has(path),
    searched: () => didSearch,
    searchIncomplete: () => incompleteSearches.size > 0,
    reads: () => [...observed.values()],
    checkedPaths,
    current,
  }
}
