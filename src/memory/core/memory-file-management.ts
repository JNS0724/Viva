import { memoryFileIdentity, memoryFileListRequest, memoryFileMutation } from '../contracts/file-management.ts'
import type { MemoryManagedFileIdentity, MemoryFileListRequest, MemoryFileListResult, MemoryFileSummary, MemoryFileDetail,
  MemoryFileForgetRequest, MemoryFileMutation, MemoryManagedFileVersion, MemoryFileEditRequest } from '../contracts/file-management.ts'
import type { createMemoryDocumentReadPolicy, MemoryDocumentManagementView } from './memory-document-read-policy.ts'
import type { MemorySourceReference } from '../contracts/service.ts'
import type { FileUseRestriction, MemoryFileRestrictions } from './ports/file-restrictions.ts'
import type { DailyAllocation, DailyFileRegistration } from './ports/notes.ts'
import type { DocumentFileRegistration, DocumentSourceRef, MemoryDocuments } from './ports/documents.ts'
import { parseMemoryDocument } from './memory-document.ts'
import { documentSourceRestricted } from './memory-document-restrictions.ts'
import { MemoryDomainError } from './presentation.ts'

type DailyReads = {
  allocations(): DailyAllocation[]
  ledger: Pick<MemoryFileRestrictions, 'forTarget' | 'snapshot'>
  references(key: string): DocumentSourceRef[]
  sources(refs: readonly DocumentSourceRef[], markdown?: string): MemorySourceReference[] | null
}
type DailyRestriction = { record: FileUseRestriction, version: MemoryManagedFileVersion }
type ManagedView = MemoryDocumentManagementView & {
  detachedRestrictions?: DailyRestriction[]
  daily?: { allocation: DailyAllocation, hasProjection: boolean, canStop: boolean, restrictions: DailyRestriction[] }
}
type Policy = Pick<ReturnType<typeof createMemoryDocumentReadPolicy>, 'managementList' | 'managementRead'>
type ReadManagedFile = (workspace: string, path: string) => MemoryDocumentManagementView | null
type Allows = (view: MemoryDocumentManagementView) => boolean
type RegistryEntry = { identity: MemoryManagedFileIdentity, path: string, physical: boolean, revision: string, usage: number,
  allocation?: DailyAllocation, detached?: DocumentFileRegistration }
const identityOf = (view: MemoryDocumentManagementView): MemoryManagedFileIdentity => ({ kind: view.kind, workspace: view.workspace, id: view.id })
const versionOf = (view: MemoryDocumentManagementView): MemoryManagedFileVersion => ({ contentRevision: view.revision, usageVersion: view.usageVersion, policyToken: view.policyToken })
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const failure = (code: 'not.found' | 'revision.conflict' | 'invalid.text') => new MemoryDomainError(code, `Memory file management: ${code}`)

/** Trusted host management only. Model tools must use the read policy's ordinary read/list paths.
 * This service owns no mutation or request fence; validate must run inside the runtime's sole fence. */
export function createMemoryFileManagement({ policy, documents, workspaces, locate, hash, daily, editing = false }: {
  policy: Policy, documents: Pick<MemoryDocuments, 'undoCandidate' | 'registered' | 'fileRegistry'> & Partial<Pick<MemoryDocuments, 'projectErasedLocators'>>, workspaces(): readonly string[], hash(text: string): string, daily?: DailyReads, editing?: boolean,
  locate?(identity: MemoryManagedFileIdentity): string | null,
}) {
  function undoCandidate(view: MemoryDocumentManagementView) {
    if (view.kind !== 'digest' || !view.backing) return null
    const candidate = documents.undoCandidate(view.workspace, view.id, view.backing)
    return candidate?.revision === view.revision && candidate.usageVersion === view.usageVersion ? candidate : null
  }
  function authorizedRestrictions({ kind, workspace, key }: Pick<FileUseRestriction, 'kind' | 'workspace' | 'key'>) {
    const ledger = daily
    return ledger?.ledger.forTarget({ kind, workspace, key }).flatMap(record => {
      const sources = ledger.sources(record.sources)
      return sources && (kind === 'daily' || sources.length) ? [{ record, sources,
        version: { contentRevision: record.contentRevision, usageVersion: record.usageVersion, policyToken: hash(JSON.stringify(record)) } }] : []
    }) ?? []
  }
  // An independent restriction remains manageable even with no accepted projection.
  function dailyView(allocation: DailyAllocation, id: string, current?: MemoryDocumentManagementView): ManagedView | null {
    const { workspace, key } = allocation
    const authorized = authorizedRestrictions({ workspace, key, kind: 'daily' })
    if (!current && !authorized.length) return null
    const ownRanges = authorized.flatMap(item => item.record.sources)
    const canStop = Boolean(current && daily && !daily.references(key).some(ref => documentSourceRestricted(ref, ownRanges)))
    const dailyState = { allocation, hasProjection: Boolean(current), canStop, restrictions: authorized.map(({ record, version }) => ({ record, version })) }
    const sources = [...new Map([...(current?.sources ?? []), ...authorized.flatMap(item => item.sources)].map(ref => [ref.sourceId, ref])).values()]
    if (current) return { ...current, sources, enabled: current.currentMarkdown !== null && current.applicability.state !== 'unavailable', daily: dailyState }
    const latest = authorized.at(-1)!
    return { id, kind: 'daily', workspace, path: allocation.path, day: allocation.day, updatedAt: allocation.updatedAt,
      revision: latest.version.contentRevision, usageVersion: allocation.revision, policyToken: hash(JSON.stringify([allocation, authorized.map(item => item.version)])),
      enabled: false, markdown: '', currentMarkdown: null, sources, sourceTokens: [], backing: null, supporting: [],
      applicability: { state: 'unavailable', supersessions: [] }, daily: dailyState }
  }
  function detachedDigestView(entry: DocumentFileRegistration): ManagedView | null {
    const { workspace, id, revision, usageVersion } = entry
    const restrictions = authorizedRestrictions({ kind: 'digest', workspace, key: id })
    if (!restrictions.length) return null
    return { id, kind: 'digest', workspace, path: `digest/wiki/erased-${hash(id)}.md`, updatedAt: 0,
      revision, usageVersion, policyToken: hash(JSON.stringify(restrictions.map(item => item.version))),
      enabled: false, markdown: '', currentMarkdown: null, sources: restrictions.flatMap(item => item.sources),
      sourceTokens: [], backing: null, supporting: [], applicability: { state: 'unavailable', supersessions: [] },
      detachedRestrictions: restrictions.map(({ record, version }) => ({ record, version })) }
  }
  function managementViews(workspace: string, accepted?: MemoryDocumentManagementView[], target?: MemoryManagedFileIdentity): ManagedView[] {
    const views: ManagedView[] = accepted ?? policy.managementList(workspace)
    if (!daily) return views
    const dailyViews = new Map(views.filter(view => view.kind === 'daily').map(view => [view.id, view]))
    const result = views.filter(view => view.kind !== 'daily')
    if (!target || target.kind === 'daily') for (const allocation of daily.allocations()) {
      if (allocation.workspace !== workspace) continue
      const id = `daily:${hash(allocation.key)}`
      if (target && id !== target.id) continue
      const view = dailyView(allocation, id, dailyViews.get(id))
      if (view) result.push(view)
    }
    if (!target || target.kind === 'digest' && !result.some(view => view.id === target.id)) for (const entry of documents.registered(workspace)) {
      if (entry.state !== 'forgotten' || target && entry.id !== target.id) continue
      const view = detachedDigestView(entry)
      if (view) result.push(view)
    }
    return result
  }
  const editSupported = (view: ManagedView) => editing && view.kind === 'digest' && view.backing !== null
    && view.enabled && view.currentMarkdown !== null && view.applicability.state === 'current'
  function forgetSupported(view: ManagedView): boolean {
    return view.kind === 'digest' ? view.backing !== null : Boolean(view.daily)
  }
  function titleOf(view: ManagedView) {
    const { name } = parseMemoryDocument(view.markdown).metadata
    return typeof name === 'string' ? name.slice(0, 200) : ''
  }
  function summary(view: ManagedView, title = titleOf(view)): MemoryFileSummary {
    const candidate = undoCandidate(view)
    return { identity: identityOf(view), version: versionOf(view), path: view.path,
      title, enabled: view.enabled,
      ...(view.day ? { day: view.day } : {}), applicability: view.applicability.state,
      ...(view.daily || view.detachedRestrictions ? { hasProjection: view.daily?.hasProjection ?? false,
        restrictions: (view.daily?.restrictions ?? view.detachedRestrictions ?? []).map(({ record, version }) => ({ id: record.id, version })) } : {}),
      actions: { setEnabled: view.kind === 'digest' || Boolean(view.daily && (view.daily.canStop || view.daily.restrictions.length)),
        ...(view.daily ? { stop: view.daily.canStop } : {}), edit: editSupported(view), forget: forgetSupported(view), undo: candidate ? { changeId: candidate.changeId } : null } }
  }
  function resolve(input: MemoryManagedFileIdentity, allows: Allows, read: ReadManagedFile = policy.managementRead): ManagedView | null {
    const identity = memoryFileIdentity.parse(input)
    if (!workspaces().includes(identity.workspace)) return null
    const path = locate?.(identity)
    const view = path ? read(identity.workspace, path) : null
    const accepted = locate ? [view].filter(item => item !== null) : undefined
    const found = managementViews(identity.workspace, accepted, identity).find(view => view.kind === identity.kind && view.id === identity.id)
    // Identity never falls back to a former path: a replacement at that path is a different file.
    if (!found || !allows(found)) return null
    return found
  }
  function detail(input: MemoryManagedFileIdentity, allows: Allows, restrictionId?: string, read?: ReadManagedFile): MemoryFileDetail | null {
    const view = resolve(input, allows, read)
    if (!view) return null
    const item: MemoryFileDetail = { ...summary(view), markdown: view.markdown, sources: view.sources }
    if (item.actions.edit && restrictionId === undefined) {
      const { metadata, body } = parseMemoryDocument(view.markdown)
      item.editor = { title: typeof metadata.name === 'string' ? metadata.name : '', text: body }
    }
    if (restrictionId === undefined) return item
    const record = (view.daily?.restrictions ?? view.detachedRestrictions)?.find(item => item.record.id === restrictionId)?.record
    if (!record || !daily) return null
    const sources = daily.sources(record.sources)
    if (!sources) return null
    const snapshot = daily.ledger.snapshot(record, restrictionId)
    const verified = snapshot !== null && record.sources.length > 0 && hash(snapshot) === record.contentRevision
      && daily.sources(record.sources, snapshot) !== null
    const projected = verified ? documents.projectErasedLocators?.(record.workspace, snapshot) ?? snapshot : null
    const markdown = projected !== null && daily.sources(record.sources, projected) ? projected : null
    return { ...item, actions: { ...item.actions, forget: false }, stoppedSnapshot: { restrictionId, markdown, sources } }
  }
  function list(input: MemoryFileListRequest, allows: Allows): MemoryFileListResult {
    const request = memoryFileListRequest.parse(input), query = (request.query ?? '').trim().normalize('NFKC').toLowerCase()
    const views = [...new Set(workspaces())].flatMap(workspace => managementViews(workspace)).filter(allows)
    const items = views.filter(view => !request.kind || view.kind === request.kind)
      .filter(view => !request.state || request.state === 'all' || view.enabled === (request.state === 'enabled'))
      .map(view => summary(view)).filter(item => !query || `${item.title}\n${item.path}`.normalize('NFKC').toLowerCase().includes(query))
      .sort((a, b) => compare(JSON.stringify(a.identity), JSON.stringify(b.identity)))
    const snapshot = hash(JSON.stringify({ kind: request.kind ?? null, state: request.state ?? 'all', query, items }))
    const offset = request.cursor?.offset ?? 0, limit = request.limit ?? 25
    if (request.cursor && (request.cursor.snapshot !== snapshot || offset > items.length)) {
      return { status: 'stale', snapshot, items: [], nextCursor: null }
    }
    const page = items.slice(offset, offset + limit), next = offset + page.length
    return { status: 'ok', snapshot, items: page, nextCursor: next < items.length ? { snapshot, offset: next } : null }
  }

  /** Cursor offsets address the committed registry. Only page candidates and
   * their correction dependencies need physical verification. */
  async function listPage(input: MemoryFileListRequest, allows: Allows, notes: readonly DailyFileRegistration[], options: {
    revision(): number, exhausted?(): boolean, load(files: readonly { workspace: string, path: string }[]): Promise<(workspace: string, path: string) => MemoryDocumentManagementView | null | undefined>, signal?: AbortSignal,
  }): Promise<MemoryFileListResult> {
    const request = memoryFileListRequest.parse(input)
    const query = (request.query ?? '').trim().normalize('NFKC').toLowerCase()
    const entries: RegistryEntry[] = []
    const scopes = new Set(workspaces())
    const state = request.state ?? 'all'
    const acceptsState = (enabled: boolean) => state === 'all' || enabled === (state === 'enabled')
    if (request.kind !== 'daily') for (const workspace of scopes) {
      for (const doc of documents.fileRegistry(workspace)) {
        if (!acceptsState(doc.state === 'active')) continue
        entries.push({ identity: { kind: 'digest', workspace, id: doc.id }, path: doc.path, physical: doc.state !== 'forgotten',
          revision: doc.revision, usage: doc.usageVersion, ...(doc.state === 'forgotten' ? { detached: doc } : {}) })
      }
    }
    if (request.kind !== 'digest' && daily) for (const { fileRevision, ...note } of notes) {
      if (!scopes.has(note.workspace) || !fileRevision && !acceptsState(false)) continue
      entries.push({ identity: { kind: 'daily', workspace: note.workspace, id: `daily:${hash(note.key)}` }, path: note.path, physical: Boolean(fileRevision),
        revision: fileRevision ?? '', usage: note.revision, allocation: note })
    }
    entries.sort(({ identity: a }, { identity: b }) => compare(a.kind, b.kind) || compare(a.workspace, b.workspace) || compare(a.id, b.id))
    const revision = options.revision()
    const snapshot = hash(JSON.stringify([revision, request.kind ?? null, state, query, entries.map(({ identity, path, physical, revision, usage }) =>
      [identity.kind, identity.workspace, identity.id, path, physical, revision, usage])]))
    const stale = (): MemoryFileListResult => ({ status: 'stale', snapshot, items: [], nextCursor: null })
    let offset = request.cursor?.offset ?? 0
    if (request.cursor && (request.cursor.snapshot !== snapshot || offset > entries.length)) return stale()
    const retry = [...new Set(request.cursor?.retry ?? [])]
    if (retry.some(index => index >= offset)) return stale()
    const limit = request.limit ?? 25
    const end = Math.min(entries.length, offset + 100 - retry.length)
    const unread: number[] = []
    const items: MemoryFileSummary[] = []
    let partial = false
    while ((retry.length || offset < end) && items.length < limit) {
      if (options.exhausted?.()) { partial = true; break }
      const indices = retry.splice(0, limit - items.length)
      while (offset < end && indices.length < limit - items.length) indices.push(offset++)
      const candidates = indices.map(index => entries[index]!)
      const read = await options.load(candidates.flatMap(({ identity, path, physical }) => physical ? [{ workspace: identity.workspace, path }] : []))
      options.signal?.throwIfAborted()
      if (options.revision() !== revision) return stale()
      for (const [n, { identity, path, physical, allocation, detached }] of candidates.entries()) {
        const observed = physical ? read(identity.workspace, path) : null
        if (observed === undefined) { unread.push(indices[n]!); continue }
        const view = observed?.kind === identity.kind && observed.id === identity.id ? observed : undefined
        const item = allocation ? dailyView(allocation, identity.id, view) : detached ? detachedDigestView(detached) : view
        if (!item || !allows(item) || !acceptsState(item.enabled)) continue
        const title = titleOf(item)
        if (!query || `${title}\n${item.path}`.normalize('NFKC').toLowerCase().includes(query)) items.push(summary(item, title))
      }
    }
    // Preserve unobserved rows without replaying healthy results returned on the same page.
    unread.push(...retry)
    partial ||= unread.length > 0
    const nextCursor = offset < entries.length || unread.length ? { snapshot, offset, ...(partial && { retry: unread }) } : null
    return { status: 'ok', snapshot, items, ...(partial && { partial }), nextCursor }
  }
  function validate(input: MemoryFileMutation, allows: Allows) {
    const command = memoryFileMutation.parse(input), view = resolve(command.identity, allows)
    if (!view) throw failure('not.found')
    const selected = command.action === 'setEnabled' && command.enabled
      ? (view.daily?.restrictions ?? view.detachedRestrictions)?.find(item => item.record.id === command.restrictionId) : undefined
    if (view.kind === 'daily') {
      if (!view.daily || command.action !== 'setEnabled') throw failure('invalid.text')
      if (command.enabled ? !selected : command.restrictionId !== undefined || !view.daily.canStop) throw failure('revision.conflict')
    } else if (view.detachedRestrictions) {
      if (!selected) throw failure('revision.conflict')
    } else if (command.action === 'setEnabled' && command.restrictionId !== undefined) throw failure('invalid.text')
    const version = selected?.version ?? versionOf(view)
    if (version.contentRevision !== command.version.contentRevision || version.usageVersion !== command.version.usageVersion
      || version.policyToken !== command.version.policyToken) throw failure('revision.conflict')
    const undo = command.action === 'undo' ? undoCandidate(view) : null
    if (command.action === 'undo' && (!undo || undo.changeId !== command.changeId)) throw failure('revision.conflict')
    return { view, undo, restriction: selected?.record }
  }
  function deletionTarget(command: MemoryFileForgetRequest, allows: Allows) {
    if (command.restrictionId !== undefined) throw failure('invalid.text')
    const view = resolve(command.identity, allows)
    if (!view || !forgetSupported(view)) throw failure('not.found')
    const expected = command.version, current = versionOf(view)
    if (current.contentRevision !== expected.contentRevision || current.usageVersion !== expected.usageVersion
      || current.policyToken !== expected.policyToken) throw failure('revision.conflict')
    return view
  }
  // Persisted range erasures accepted by earlier releases retain their original scope.
  function forgetEvidence(command: MemoryFileForgetRequest, allows: Allows): { refs: DocumentSourceRef[], dailyKey?: string } {
    const view = resolve(command.identity, allows)
    if (!view) throw failure('not.found')
    const selected = command.restrictionId === undefined ? undefined
      : view.daily?.restrictions.find(item => item.record.id === command.restrictionId)
    const version = selected?.version ?? versionOf(view)
    if (version.contentRevision !== command.version.contentRevision || version.usageVersion !== command.version.usageVersion
      || version.policyToken !== command.version.policyToken) throw failure('revision.conflict')
    if (command.restrictionId !== undefined) {
      if (!selected || !daily || !selected.record.sources.length) throw failure('revision.conflict')
      const snapshot = daily.ledger.snapshot(selected.record, selected.record.id)
      if (!snapshot || hash(snapshot) !== version.contentRevision || !daily.sources(selected.record.sources, snapshot)) throw failure('revision.conflict')
      return { refs: selected.record.sources, dailyKey: view.daily!.allocation.key }
    }
    const refs = view.kind === 'digest' ? view.backing?.sources
      : view.daily?.hasProjection && daily ? daily.references(view.daily.allocation.key) : undefined
    if (!refs?.length) throw failure('revision.conflict')
    return { refs, dailyKey: view.daily?.allocation.key }
  }
  function editTarget(command: MemoryFileEditRequest, allows: Allows) {
    const view = resolve(command.identity, allows)
    if (!view || !view.backing || !editSupported(view)) throw failure('revision.conflict')
    const current = versionOf(view), expected = command.version
    if (current.contentRevision !== expected.contentRevision || current.usageVersion !== expected.usageVersion
      || current.policyToken !== expected.policyToken) throw failure('revision.conflict')
    return view.backing
  }
  return { list, listPage, detail, resolve, validate, deletionTarget, forgetEvidence, editTarget }
}
