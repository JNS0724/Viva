import { dailyPath, digestPath } from '../contracts/memory-file-contract.ts'
import type { MemoryFileDependency } from '../contracts/records.ts'
import type { MemorySourceReference } from '../contracts/service.ts'
import type { MemoryNotes } from './ports/notes.ts'
import type { MemorySource } from './ports/store.ts'
import { inspectMemoryDocumentText } from './memory-dream-material.ts'
import type { DocumentSnapshot, DocumentSourceRef, MemoryDocuments, MemoryPhysicalFile, ReadMemoryPhysicalFile } from './ports/documents.ts'
import { documentSourceProofCurrent } from './memory-source-proof.ts'
import { traceLineHistory, type MemoryLineChange, type MemoryLineRevision } from './memory-line-history.ts'

type ReadNotes = Pick<MemoryNotes, 'read' | 'registered' | 'registeredAt' | 'references' | 'snapshot' | 'sources'>
type ReadDocuments = Pick<MemoryDocuments, 'read' | 'registered'> & Partial<Pick<MemoryDocuments, 'revisionHistory'>>
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

/** Single authorized view shared by Dream and all file retrieval paths. */
export interface MemoryDocumentView {
  id: string
  workspace: string
  kind: 'daily' | 'digest'
  path: string
  revision: string
  usageVersion: number
  policyToken: string
  day?: string
  session?: string
  updatedAt: number
  markdown: string
  sources: MemorySourceReference[]
  sourceTokens: DocumentSourceRef[]
  backing: DocumentSnapshot | null
}
export function fileDependency(view: MemoryDocumentView): MemoryFileDependency {
  const { workspace, id, path, revision, usageVersion, policyToken } = view
  const sourceRanges = mergeDocumentSources(view.sourceTokens)
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
      return Boolean(original?.text && token && documentSourceProofCurrent(ref, original.text, token))
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

export function createMemoryDocumentReadPolicy({ notes, documents, hash, refsCurrent, materialAllowed, reference, readPhysicalFile }: {
  notes: ReadNotes
  documents: ReadDocuments
  hash(text: string): string
  /** Includes source version, authorization and any caller-specific project binding. */
  refsCurrent(refs: readonly DocumentSourceRef[]): boolean
  materialAllowed(text: string, refs: readonly DocumentSourceRef[]): boolean
  reference(id: string): MemorySourceReference | null
  readPhysicalFile?: ReadMemoryPhysicalFile
}) {
  function read(workspace: string, path: string, snapshot?: PhysicalSnapshot): MemoryDocumentView | null {
    try { return readAccepted(workspace, path, false, undefined, snapshot) ?? null } catch { return null }
  }
  function readAccepted(workspace: string, path: string, includeDisabled = false, acceptedDigest?: DocumentSnapshot, snapshot?: PhysicalSnapshot): MemoryDocumentManagementView | null {
    const registered = path.startsWith('daily/') ? notes.registeredAt(workspace, path) : undefined
    const physical = snapshot?.(workspace, path)
    const note = registered ? notes.read(registered.key, physical) : undefined
    if (note && note.fileRevision !== registered?.file_revision) return null
    const digest = path.startsWith('digest/') ? acceptedDigest ?? documents.read(workspace, path, { includeDisabled, physical }) : null
    if (!note && !digest) return null
    const refs = note ? notes.references(note.key) : digest!.sources
    const enabled = note?.enabled ?? digest!.enabled
    if (!enabled && !includeDisabled) return null
    const markdown = note ? note.document : digest!.markdown
    if (!refsCurrent(refs) || !materialAllowed(markdown, refs)) return null
    const combined = mergeDocumentSources(refs)
    const sources: MemorySourceReference[] = []
    for (const ref of combined) {
      const value = reference(ref.id)
      if (!value) return null
      sources.push(value)
    }
    const revision = note ? note.fileRevision : digest!.revision
    const usageVersion = note ? note.revision : digest!.usageVersion
    const policyToken = hash(JSON.stringify([revision, usageVersion, combined]))
    return {
      id: note ? `daily:${hash(note.key)}` : digest!.id, workspace, kind: note ? 'daily' : 'digest', path,
      revision, usageVersion, policyToken, enabled, ...(note ? { day: note.day, session: note.session } : {}), updatedAt: note?.updatedAt ?? 0,
      markdown, sources, sourceTokens: combined, backing: digest,
    }
  }
  function readBatch(signal?: AbortSignal, maxFiles = MAX_READ_BATCH_FILES): MemoryDocumentReadBatch | undefined {
    const readPhysical = readPhysicalFile
    if (!readPhysical) return
    const loaded = new Map<string, MemoryPhysicalFile | null>()
    let incomplete = false
    const snapshot: PhysicalSnapshot = (workspace, path) => loaded.get(locationKey(workspace, path)) ?? null

    const load = async (files: readonly FileLocation[], phaseSignal?: AbortSignal) => {
      const active = signal && phaseSignal ? AbortSignal.any([signal, phaseSignal]) : signal ?? phaseSignal
      const queue = new Map<string, FileLocation>()
      for (const file of files) {
        if (active?.aborted) break
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
      incomplete ||= Boolean(active?.aborted || files.some(file => !loaded.has(locationKey(file.workspace, file.path))))
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
      observe(workspace, path, verified => read(workspace, path, verified))
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
      return readAccepted(workspace, path, true, undefined, snapshot)
    } catch { return null }
  }
  function managementList(workspace: string): MemoryDocumentManagementView[] {
    return paths(workspace).flatMap(path => managementRead(workspace, path) ?? [])
  }
  function managementCurrent(before: DocumentSnapshot, policyToken: string, after: DocumentSnapshot, staged?: MemorySource): boolean {
    try {
      // The journal has verified the accepted row and physical hashes. Its own pending
      // replacement is hidden from ordinary reads until the receipt has been committed.
      const accepted = readAccepted(before.workspace, before.path, true, before)
      const existing = staged ? after.sources.filter(ref => ref.id !== staged.id) : after.sources
      return accepted?.policyToken === policyToken && refsCurrent(existing) && materialAllowed(after.markdown, existing)
    } catch { return false }
  }
  function lineHistory(workspace: string, view: MemoryDocumentView, startLine: number, endLine: number): MemoryLineChange | null {
    if (view.kind !== 'digest' || !documents.revisionHistory) return null
    try {
      const liveTokens = new Map(view.sourceTokens.map(ref => [ref.id, ref]))
      const entries = documents.revisionHistory(workspace, view.id, 20)
      const verified: MemoryLineRevision[] = []
      let expectedRevision = view.revision
      for (const entry of entries) {
        if (!entry.before || !entry.after || entry.after.revision !== expectedRevision) break
        const beforeRefs = entry.before.sources
        const covered = beforeRefs.length > 0 && beforeRefs.every(ref => {
          const live = liveTokens.get(ref.id)
          if (!live || live.token !== ref.token) return false
          if (live.spans && (!ref.spans || !ref.spans.every(span => live.spans!.some(parent => parent.start <= span.start && span.end <= parent.end)))) return false
          return true
        })
        if (!covered || !refsCurrent(beforeRefs)) break
        const beforeMarkdown = entry.before.markdown
        const afterMarkdown = entry.after.markdown
        if (verified.length === 0 && afterMarkdown !== view.markdown) break
        if (!materialAllowed(beforeMarkdown, beforeRefs)) break
        verified.push({ at: entry.at, before: beforeMarkdown, after: afterMarkdown })
        expectedRevision = entry.before.revision
      }
      return verified.length ? traceLineHistory(verified, startLine, endLine) : null
    } catch { return null }
  }
  return { read, readBatch, paths, list, managementRead, managementList, managementCurrent, lineHistory }
}
