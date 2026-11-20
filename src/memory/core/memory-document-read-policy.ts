import { dailyPath, digestPath } from '../contracts/memory-file-contract.ts'
import type { MemoryFileDependency } from '../contracts/records.ts'
import type { MemorySourceReference } from '../contracts/service.ts'
import type { MemoryNotes } from './ports/notes.ts'
import type { MemorySource } from './ports/store.ts'
import { inspectMemoryDocumentText } from './memory-dream-material.ts'
import type { DocumentSnapshot, DocumentSourceRef, DocumentSupersession, MemoryDocuments, MemoryPhysicalFile, ReadMemoryPhysicalFile } from './ports/documents.ts'
import { documentSourceProofCurrent, documentSourceRestricted, erasedDocumentSource } from './memory-document-restrictions.ts'
import { readMemoryLines, memoryDocumentLines } from './memory-document.ts'

type ReadNotes = Pick<MemoryNotes, 'read' | 'registered' | 'registeredAt' | 'references' | 'snapshot' | 'sources'>
type ReadDocuments = Pick<MemoryDocuments, 'read' | 'registered' | 'sourceRestrictions' | 'supersessions'> & Partial<Pick<MemoryDocuments, 'projectErasedLocators'>>
type FileLocation = { workspace: string, path: string }
type PhysicalSnapshot = (workspace: string, path: string) => MemoryPhysicalFile | null
const locationKey = (workspace: string, path: string) => JSON.stringify([workspace, path])
const MAX_READ_BATCH_FILES = 512
export const MEMORY_DOCUMENT_READ_CONCURRENCY = 3

export interface MemoryDocumentReadBatch {
  load(files: readonly FileLocation[], phaseSignal?: AbortSignal): Promise<void>
  read(workspace: string, path: string): MemoryDocumentView | null
  physical(workspace: string, path: string): MemoryPhysicalFile | null
  readObservation(workspace: string, path: string): MemoryDocumentView | null | undefined
  managementRead(workspace: string, path: string): MemoryDocumentManagementView | null
  managementObservation(workspace: string, path: string): MemoryDocumentManagementView | null | undefined
  /** A confirmed missing file returns null; an unread or unavailable file returns undefined. */
  observedRevision(workspace: string, path: string): string | null | undefined
  incomplete(): boolean
}

/** A single authorized view used by dream and all file retrieval paths. The original is
 * retained for evidence validation; currentMarkdown masks replaced spans without changing
 * offsets. Callers must not use markdown as unqualified current content. */
export interface MemoryDocumentView {
  id: string
  workspace: string
  kind: 'daily' | 'digest'
  path: string
  revision: string
  usageVersion: number
  policyToken: string
  day?: string
  updatedAt: number
  markdown: string
  currentMarkdown: string | null
  sources: MemorySourceReference[]
  sourceTokens: DocumentSourceRef[]
  /** Provenance of applicability wording consumed by the model, separate from public projections. */
  correctionSources?: DocumentSourceRef[]
  backing: DocumentSnapshot | null
  supporting: DocumentSnapshot[]
  applicability: { state: 'current' | 'superseded' | 'unavailable', supersessions: DocumentSupersession[] }
}
export function fileDependency(view: MemoryDocumentView): MemoryFileDependency {
  const { workspace, id, path, revision, usageVersion, policyToken } = view
  const sourceRanges = mergeDocumentSources([...view.sourceTokens, ...view.correctionSources ?? []])
    .map(({ id: sourceId, spans }) => ({ sourceId, ...(spans ? { spans } : {}) }))
  return { workspace, id, path, revision, usageVersion, policyToken, sourceRanges }
}

/** Trusted management projection only; never an input to model retrieval/injection. */
export interface MemoryDocumentManagementView extends MemoryDocumentView { enabled: boolean }

export function mergeDocumentSources(refs: readonly DocumentSourceRef[]): DocumentSourceRef[] {
  const merged = new Map<string, DocumentSourceRef>()
  for (const ref of refs) {
    const previous = merged.get(ref.id)
    if (previous && previous.token !== ref.token) throw new Error('memory-document-source-version')
    const spans = previous ? previous.spans && ref.spans ? [...previous.spans, ...ref.spans] : undefined : ref.spans
    const ranges: Array<{ start: number, end: number }> = []
    for (const span of [...spans ?? []].sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = ranges.at(-1)
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
      else ranges.push({ ...span })
    }
    merged.set(ref.id, { ...ref, ...(spans ? { spans: ranges } : { spans: undefined }) })
  }
  return [...merged.values()]
}

/** Source and prose validation is shared with write jobs; backend-issued hashes are
 * removed only from their exact trusted path/metadata positions for credential checks. */
export function createMemoryDocumentEvidence({ notes, documents, hash, source, readable, allowsText }: {
  notes: Pick<MemoryNotes, 'snapshot' | 'registeredForSources'>, documents: ReadDocuments, hash(text: string): string,
  source(id: string): MemorySource | undefined, readable(id: string): boolean,
  allowsText(text: string, source: MemorySource): boolean,
}) {
  const refsCurrent = (refs: readonly DocumentSourceRef[]) => {
    if (!refs.length || refs.some(ref => !readable(ref.id))) return false
    const latest = notes.snapshot(refs.map(ref => ref.id))
    return refs.every(ref => {
      const original = source(ref.id), token = latest.find(item => item.id === ref.id)?.token
      return Boolean(original?.text && token && documentSourceProofCurrent(ref, original.text, token, erasedDocumentSource(original)))
    })
  }
  const materialAllowed = (text: string, refs: readonly DocumentSourceRef[]) => {
    const scoped = notes.registeredForSources(refs.map(ref => ref.id))
    const workspaces = [...new Set([...scoped.map(note => note.workspace), ...refs.flatMap(ref => {
      const original = source(ref.id)
      return original ? [hash(JSON.stringify([original.scope, original.context, original.project ?? null]))] : []
    })])]
    const paths = [...scoped.map(note => note.path), ...workspaces.flatMap(workspace => documents.registered(workspace).map(doc => doc.path)),
      ...refs.flatMap(ref => { const original = source(ref.id); return original?.session ? [`session/dialog/${hash(original.session)}.jsonl`] : [] })]
    const prose = inspectMemoryDocumentText(text, paths, refs.flatMap(ref => { const original = source(ref.id)
      return original?.session ? [{ key: 'session_id', value: original.session }] : [] }))
    return refs.every(ref => {
      const original = source(ref.id)
      return original?.text && allowsText(original.text, original) && allowsText(prose, original)
    })
  }
  return { refsCurrent, materialAllowed }
}

/** A supersession is anchored to exact original lines. When external edits make that
 * anchor ambiguous, quarantine the view instead of dropping the persisted relation. */
function currentProjection(markdown: string, supersessions: readonly DocumentSupersession[]): string | null {
  const lines = memoryDocumentLines(markdown)
  for (const item of supersessions) {
    if (!item.text || !Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine)
      || item.startLine < 1 || item.endLine < item.startLine || item.endLine > lines.length
      || readMemoryLines(markdown, item.startLine, item.endLine) !== item.text) return null
  }
  const hidden = new Set(supersessions.flatMap(item => Array.from({ length: item.endLine - item.startLine + 1 }, (_, index) => item.startLine + index)))
  return lines.map((line, index) => (hidden.has(index + 1)
    ? markdown.slice(line.startOffset, line.contentEndOffset).replace(/./g, ' ')
    : markdown.slice(line.startOffset, line.contentEndOffset)) + markdown.slice(line.contentEndOffset, line.endOffset)).join('')
}

export function createMemoryDocumentReadPolicy({ notes, documents, hash, refsCurrent, materialAllowed, reference, inheritedUseRestricted = () => false, readPhysicalFile }: {
  notes: ReadNotes
  documents: ReadDocuments
  hash(text: string): string
  /** Includes source version, authorization and any caller-specific project binding. */
  refsCurrent(refs: readonly DocumentSourceRef[]): boolean
  materialAllowed(text: string, refs: readonly DocumentSourceRef[]): boolean
  reference(id: string): MemorySourceReference | null
  inheritedUseRestricted?(ref: DocumentSourceRef): boolean
  readPhysicalFile?: ReadMemoryPhysicalFile
}) {
  function read(workspace: string, path: string, ancestors: ReadonlySet<string> = new Set(), snapshot?: PhysicalSnapshot): MemoryDocumentView | null {
    try { return readAccepted(workspace, path, ancestors, false, undefined, snapshot) } catch { return null }
  }
  function readAccepted(workspace: string, path: string, ancestors: ReadonlySet<string>, includeDisabled = false, acceptedDigest?: DocumentSnapshot, snapshot?: PhysicalSnapshot): MemoryDocumentView | null {
    const key = locationKey(workspace, path)
    if (ancestors.has(key)) return null
    const chain = new Set([...ancestors, key])
    const registered = path.startsWith('daily/') ? notes.registeredAt(workspace, path) : undefined
    const physical = snapshot?.(workspace, path)
    const note = registered ? notes.read(registered.key, physical) : undefined
    if (note && note.fileRevision !== registered?.file_revision) return null
    const digest = path.startsWith('digest/') ? acceptedDigest ?? documents.read(workspace, path, { includeDisabled, physical }) : null
    if (!note && !digest) return null
    const refs = note ? notes.references(note.key) : digest!.sources
    const restrictions = documents.sourceRestrictions(workspace)
    const applicableRestrictions = restrictions.filter(restriction => refs.some(ref => documentSourceRestricted(ref, [restriction])))
    const inheritedRestrictions = refs.filter(inheritedUseRestricted)
    const useRestricted = applicableRestrictions.length > 0 || inheritedRestrictions.length > 0
    // These are use-disable restrictions, not source authorization or erasure. Trusted
    // management may inspect accepted content in order to re-enable it; model reads may not.
    if (useRestricted && !includeDisabled) return null
    const rawMarkdown = note ? note.document : digest!.markdown
    const markdown = documents.projectErasedLocators?.(workspace, rawMarkdown) ?? rawMarkdown
    if (!refsCurrent(refs) || !materialAllowed(markdown, refs)) return null
    // A correction of this same logical document describes the previous revision, not
    // a reason to hide its newly corrected body. Other revisions remain anchored.
    const relations = documents.supersessions(workspace, path, { includeEvidence: true, physical }).filter(item => !(digest?.id === item.documentId
      && digest.corrections.some(active => active.operationId === item.operationId)))
    const correctionSources: DocumentSourceRef[] = []
    const supersessions = relations.map(({ anchorSources, ...item }) => {
      if (!anchorSources?.length) return item
      if (!refsCurrent(anchorSources) || anchorSources.some(ref => documentSourceRestricted(ref, restrictions) || inheritedUseRestricted(ref))) {
        // The private quotation can still verify which current lines to hide. A stopped
        // anchor cannot supply wording to a model reading a separately sourced file.
        return { ...item, text: '', condition: '', time: '' }
      }
      correctionSources.push(...anchorSources)
      return item
    })
    const candidates = supersessions.length ? documents.registered(workspace) : []
    const replacements = supersessions.map(item => {
      const entry = candidates.find(candidate => candidate.id === item.documentId && candidate.state === 'active')
      const candidate = entry ? documents.read(workspace, entry.path, { physical: snapshot?.(workspace, entry.path) }) : null
      return candidate?.corrections.some(active => active.operationId === item.operationId) ? read(workspace, candidate.path, chain, snapshot) : null
    })
    // A replacement may itself have been corrected. Bind its whole applicability chain
    // and expose only its current projection, never its unqualified original body.
    const usable = replacements.filter((item): item is MemoryDocumentView => Boolean(item && item.currentMarkdown !== null && item.applicability.state !== 'unavailable'))
    const supporting = [...new Map(usable.flatMap(item => [
      ...(item.backing ? [{ ...item.backing, markdown: item.currentMarkdown! }] : []), ...item.supporting,
    ]).map(item => [item.id, item])).values()]
    const combined = mergeDocumentSources([...refs, ...usable.flatMap(item => item.sourceTokens)])
    const sources: MemorySourceReference[] = []
    for (const ref of combined) {
      const value = reference(ref.id)
      if (!value) return null
      sources.push(value)
    }
    const projected = currentProjection(markdown, relations)
    const state = useRestricted || projected === null || replacements.some(item => !item || item.currentMarkdown === null || item.applicability.state === 'unavailable') ? 'unavailable' : supersessions.length ? 'superseded' : 'current'
    const revision = note ? note.fileRevision : digest!.revision
    const usageVersion = note ? note.revision : digest!.usageVersion
    const policyToken = hash(JSON.stringify({ revision, usageVersion, sources: combined, supersessions,
      ...(correctionSources.length ? { correctionSources } : {}),
      ...(markdown === rawMarkdown ? {} : { locatorProjection: hash(markdown) }),
      supporting: supporting.map(item => ({ id: item.id, revision: item.revision, usageVersion: item.usageVersion })),
      replacementPolicies: replacements.map(item => item?.policyToken ?? null), ...(useRestricted ? { useRestrictions: applicableRestrictions, inheritedRestrictions } : {}), state }))
    return { id: note ? `daily:${hash(note.key)}` : digest!.id, workspace, kind: note ? 'daily' : 'digest', path,
      revision, usageVersion, policyToken, ...(note ? { day: note.day } : {}), updatedAt: note?.updatedAt ?? 0,
      markdown, currentMarkdown: useRestricted ? null : projected, sources, sourceTokens: combined,
      ...(correctionSources.length ? { correctionSources } : {}), backing: digest && { ...digest, markdown }, supporting,
      applicability: { state, supersessions } }
  }
  function readBatch(signal?: AbortSignal, maxFiles = MAX_READ_BATCH_FILES): MemoryDocumentReadBatch | undefined {
    const readPhysical = readPhysicalFile
    if (!readPhysical) return
    const loaded = new Map<string, MemoryPhysicalFile | null>()
    let incomplete = false
    const snapshot: PhysicalSnapshot = (workspace, path) => loaded.get(locationKey(workspace, path)) ?? null

    const load = async (files: readonly FileLocation[], phaseSignal?: AbortSignal) => {
      const active = signal && phaseSignal ? AbortSignal.any([signal, phaseSignal]) : signal ?? phaseSignal
      let pending = [...files]
      while (pending.length && !active?.aborted && loaded.size < maxFiles) {
        const queue = new Map<string, FileLocation>()
        for (const file of pending) {
          const key = locationKey(file.workspace, file.path)
          if (loaded.has(key) || queue.has(key)) continue
          if (queue.size + loaded.size >= maxFiles) { incomplete = true; break }
          // Legacy or invalid locators are conclusively unusable without physical I/O.
          if (!/^[a-f0-9]{64}$/u.test(file.workspace)
            || !(dailyPath.safeParse(file.path).success || digestPath.safeParse(file.path).success)) {
            loaded.set(key, null)
          } else queue.set(key, file)
        }
        const tasks = queue.entries()
        await Promise.all(Array.from({ length: Math.min(queue.size, MEMORY_DOCUMENT_READ_CONCURRENCY) }, async () => {
          for (const [key, file] of tasks) {
            if (active?.aborted) break
            try {
              loaded.set(key, await readPhysical(file.workspace, file.path, active))
            } catch {
              incomplete = true
            }
          }
        }))
        pending = []
        if (active?.aborted) break
        for (const [key, { workspace, path }] of queue) {
          const physical = loaded.get(key)
          if (!physical) continue
          try {
            const corrections = documents.supersessions(workspace, path, { physical })
            if (!corrections.length) continue
            const ids = new Set(corrections.map(item => item.documentId))
            for (const replacement of documents.registered(workspace)) {
              if (replacement.state === 'active' && ids.has(replacement.id)) pending.push(replacement)
            }
          } catch { /* The final policy read will omit an unavailable correction. */ }
        }
      }
      incomplete ||= Boolean(active?.aborted || pending.some(file => !loaded.has(locationKey(file.workspace, file.path))))
    }
    function observe<T>(workspace: string, path: string, build: (snapshot: PhysicalSnapshot) => T) {
      if (signal?.aborted || !loaded.has(locationKey(workspace, path))) return undefined
      if (!snapshot(workspace, path)) return null
      let verified = true
      const view = build((area, file) => {
        if (!loaded.has(locationKey(area, file))) verified = false
        return snapshot(area, file)
      })
      return verified ? view : undefined
    }
    const readObservation = (workspace: string, path: string) =>
      observe(workspace, path, verified => read(workspace, path, new Set(), verified))
    const managementObservation = (workspace: string, path: string) =>
      observe(workspace, path, verified => managementRead(workspace, path, verified))
    return {
      load, managementObservation, readObservation, physical: snapshot,
      read: (workspace, path) => readObservation(workspace, path) ?? null,
      managementRead: (workspace, path) => managementObservation(workspace, path) ?? null,
      observedRevision: (workspace, path) => {
        const physical = loaded.get(locationKey(workspace, path))
        return physical === null ? null : physical?.revision
      },
      incomplete: () => incomplete,
    }
  }
  function paths(workspace: string, kind?: 'daily' | 'digest') {
    const paths = [
      ...(kind === 'digest' ? [] : notes.registered().filter(item => item.workspace === workspace).map(item => item.path)),
      ...(kind === 'daily' ? [] : documents.registered(workspace).filter(item => item.state !== 'forgotten').map(item => item.path)),
    ]
    return [...new Set(paths)]
  }
  function list(workspace: string, kind?: 'daily' | 'digest') {
    return paths(workspace, kind).flatMap(path => read(workspace, path) ?? [])
  }
  function managementRead(workspace: string, path: string, snapshot?: PhysicalSnapshot): MemoryDocumentManagementView | null {
    try {
      const view = readAccepted(workspace, path, new Set(), true, undefined, snapshot)
      if (!view) return null
      const enabled = view.backing?.enabled ?? true
      return { ...view, enabled, currentMarkdown: enabled ? view.currentMarkdown : null }
    } catch { return null }
  }
  function managementList(workspace: string): MemoryDocumentManagementView[] {
    return paths(workspace).flatMap(path => managementRead(workspace, path) ?? [])
  }
  function managementCurrent(before: DocumentSnapshot, policyToken: string, after: DocumentSnapshot, staged?: MemorySource): boolean {
    try {
      // The journal has verified the accepted row and physical hashes. Its own pending
      // replacement is hidden from ordinary reads until the receipt has been committed.
      const view = readAccepted(before.workspace, before.path, new Set(), true, before)
      const existing = staged ? after.sources.filter(ref => ref.id !== staged.id) : after.sources
      const markdown = documents.projectErasedLocators?.(after.workspace, after.markdown) ?? after.markdown
      return view?.policyToken === policyToken && refsCurrent(existing) && materialAllowed(markdown, existing)
    } catch { return false }
  }
  return { read, readBatch, paths, list, managementRead, managementList, managementCurrent }
}
