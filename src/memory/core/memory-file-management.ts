import { memoryFileIdentity, memoryFileListRequest, memoryFileMutation } from '../contracts/file-management.ts'
import type { MemoryManagedFileIdentity, MemoryFileListRequest, MemoryFileListResult, MemoryFileSummary, MemoryFileDetail,
  MemoryFileForgetRequest, MemoryFileMutation, MemoryManagedFileVersion, MemoryFileEditRequest } from '../contracts/file-management.ts'
import type { createMemoryDocumentReadPolicy, MemoryDocumentManagementView } from './memory-document-read-policy.ts'
import type { MemorySourceReference } from '../contracts/service.ts'
import type { FileUseRestriction, MemoryFileRestrictions } from './ports/file-restrictions.ts'
import type { DailyAllocation } from './ports/notes.ts'
import type { DocumentSourceRef, MemoryDocuments } from './ports/documents.ts'
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
type Allows = (view: MemoryDocumentManagementView) => boolean
const identityOf = (view: MemoryDocumentManagementView): MemoryManagedFileIdentity => ({ kind: view.kind, workspace: view.workspace, id: view.id })
const versionOf = (view: MemoryDocumentManagementView): MemoryManagedFileVersion => ({ contentRevision: view.revision, usageVersion: view.usageVersion, policyToken: view.policyToken })
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const failure = (code: 'not.found' | 'revision.conflict' | 'invalid.text') => new MemoryDomainError(code, `Memory file management: ${code}`)

/** Trusted host management only. Model tools must use the read policy's ordinary read/list paths.
 * This service owns no mutation or request fence; validate must run inside the runtime's sole fence. */
export function createMemoryFileManagement({ policy, documents, workspaces, hash, daily, editing = false }: {
  policy: Policy, documents: Pick<MemoryDocuments, 'undoCandidate' | 'registered'> & Partial<Pick<MemoryDocuments, 'projectErasedLocators'>>, workspaces(): readonly string[], hash(text: string): string, daily?: DailyReads, editing?: boolean,
}) {
  function undoCandidate(view: MemoryDocumentManagementView) {
    if (view.kind !== 'digest') return null
    const candidate = documents.undoCandidate(view.workspace, view.id)
    return candidate?.revision === view.revision && candidate.usageVersion === view.usageVersion ? candidate : null
  }
  // The management-only fallback has no body and cannot feed retrieval. An
  // independent restriction remains manageable even with no accepted projection.
  function managementViews(workspace: string): ManagedView[] {
    const views: ManagedView[] = policy.managementList(workspace)
    if (!daily) return views
    const dailyViews = new Map(views.filter(view => view.kind === 'daily').map(view => [view.id, view]))
    const result = views.filter(view => view.kind !== 'daily')
    for (const allocation of daily.allocations()) {
      if (allocation.workspace !== workspace) continue
      const id = `daily:${hash(allocation.key)}`, current = dailyViews.get(id)
      const authorized = daily.ledger.forTarget({ workspace, key: allocation.key, kind: 'daily' }).flatMap(record => {
        const sources = daily.sources(record.sources)
        if (!sources) return []
        return [{ record, sources, version: { contentRevision: record.contentRevision, usageVersion: record.usageVersion,
          policyToken: hash(JSON.stringify(record)) } }]
      })
      if (!current && !authorized.length) continue
      const ownRanges = authorized.flatMap(item => item.record.sources)
      const canStop = Boolean(current && !daily.references(allocation.key).some(ref => documentSourceRestricted(ref, ownRanges)))
      const dailyState = { allocation, hasProjection: Boolean(current), canStop, restrictions: authorized.map(({ record, version }) => ({ record, version })) }
      const sources = [...new Map([...(current?.sources ?? []), ...authorized.flatMap(item => item.sources)].map(ref => [ref.sourceId, ref])).values()]
      if (current) {
        result.push({ ...current, sources, enabled: current.currentMarkdown !== null && current.applicability.state !== 'unavailable', daily: dailyState })
        continue
      }
      const latest = authorized.at(-1)!
      result.push({ id, kind: 'daily', workspace, path: allocation.path, day: allocation.day, updatedAt: allocation.updatedAt,
        revision: latest.version.contentRevision, usageVersion: allocation.revision, policyToken: hash(JSON.stringify([allocation, authorized.map(item => item.version)])),
        enabled: false, markdown: '', currentMarkdown: null, sources, sourceTokens: [], backing: null, supporting: [],
        applicability: { state: 'unavailable', supersessions: [] }, daily: dailyState })
    }
    for (const entry of documents.registered(workspace)) {
      if (entry.state !== 'forgotten') continue
      const restrictions = daily.ledger.forTarget({ kind: 'digest', workspace, key: entry.id }).flatMap(record => {
        const sources = daily.sources(record.sources)
        return sources?.length ? [{ record, sources, version: { contentRevision: record.contentRevision, usageVersion: record.usageVersion,
          policyToken: hash(JSON.stringify(record)) } }] : []
      })
      if (!restrictions.length) continue
      result.push({ id: entry.id, kind: 'digest', workspace, path: `digest/wiki/erased-${hash(entry.id)}.md`, updatedAt: 0,
        revision: entry.revision, usageVersion: entry.usageVersion, policyToken: hash(JSON.stringify(restrictions.map(item => item.version))),
        enabled: false, markdown: '', currentMarkdown: null, sources: restrictions.flatMap(item => item.sources),
        sourceTokens: [], backing: null, supporting: [], applicability: { state: 'unavailable', supersessions: [] },
        detachedRestrictions: restrictions.map(({ record, version }) => ({ record, version })) })
    }
    return result
  }
  const editSupported = (view: ManagedView) => editing && view.kind === 'digest' && view.backing !== null
    && view.enabled && view.currentMarkdown !== null && view.applicability.state === 'current'
  function summary(view: ManagedView): MemoryFileSummary {
    const metadata = parseMemoryDocument(view.markdown).metadata
    const candidate = undoCandidate(view)
    return { identity: identityOf(view), version: versionOf(view), path: view.path,
      title: typeof metadata.name === 'string' ? metadata.name.slice(0, 200) : '', enabled: view.enabled,
      ...(view.day ? { day: view.day } : {}), applicability: view.applicability.state,
      ...(view.daily || view.detachedRestrictions ? { hasProjection: view.daily?.hasProjection ?? false,
        restrictions: (view.daily?.restrictions ?? view.detachedRestrictions ?? []).map(({ record, version }) => ({ id: record.id, version })) } : {}),
      actions: { setEnabled: view.kind === 'digest' || Boolean(view.daily && (view.daily.canStop || view.daily.restrictions.length)),
        ...(view.daily ? { stop: view.daily.canStop } : {}), edit: editSupported(view), forget: false, undo: candidate ? { changeId: candidate.changeId } : null } }
  }
  function resolve(input: MemoryManagedFileIdentity, allows: Allows): ManagedView | null {
    const identity = memoryFileIdentity.parse(input)
    if (!workspaces().includes(identity.workspace)) return null
    const found = managementViews(identity.workspace).find(view => view.kind === identity.kind && view.id === identity.id)
    // Identity never falls back to a former path: a replacement at that path is a different file.
    if (!found || !allows(found)) return null
    return found
  }
  function detail(input: MemoryManagedFileIdentity, allows: Allows, restrictionId?: string): MemoryFileDetail | null {
    const view = resolve(input, allows)
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
    const projected = snapshot ? documents.projectErasedLocators?.(record.workspace, snapshot) ?? snapshot : null
    const markdown = projected && daily.sources(record.sources, projected) ? projected : null
    return { ...item, stoppedSnapshot: { restrictionId, markdown, sources } }
  }
  function list(input: MemoryFileListRequest, allows: Allows): MemoryFileListResult {
    const request = memoryFileListRequest.parse(input), query = (request.query ?? '').trim().normalize('NFKC').toLowerCase()
    const views = [...new Set(workspaces())].flatMap(workspace => managementViews(workspace)).filter(allows)
    const items = views.filter(view => !request.kind || view.kind === request.kind)
      .filter(view => !request.state || request.state === 'all' || view.enabled === (request.state === 'enabled'))
      .map(summary).filter(item => !query || `${item.title}\n${item.path}`.normalize('NFKC').toLowerCase().includes(query))
      .sort((a, b) => compare(JSON.stringify(a.identity), JSON.stringify(b.identity)))
    const snapshot = hash(JSON.stringify({ kind: request.kind ?? null, state: request.state ?? 'all', query, items }))
    const offset = request.cursor?.offset ?? 0, limit = request.limit ?? 25
    if (request.cursor && (request.cursor.snapshot !== snapshot || offset > items.length)) {
      return { status: 'stale', snapshot, items: [], nextCursor: null }
    }
    const page = items.slice(offset, offset + limit), next = offset + page.length
    return { status: 'ok', snapshot, items: page, nextCursor: next < items.length ? { snapshot, offset: next } : null }
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
  function forgetEvidence(command: MemoryFileForgetRequest, allows: Allows): { refs: DocumentSourceRef[], dailyKey?: string } {
    const view = resolve(command.identity, allows)
    if (!view) throw failure('not.found')
    const selected = command.restrictionId === undefined ? undefined
      : view.daily?.restrictions.find(item => item.record.id === command.restrictionId)
    const version = selected?.version ?? versionOf(view)
    if (version.contentRevision !== command.version.contentRevision || version.usageVersion !== command.version.usageVersion
      || version.policyToken !== command.version.policyToken) throw failure('revision.conflict')
    if (command.restrictionId !== undefined) {
      if (!selected || !daily) throw failure('revision.conflict')
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
  return { list, detail, resolve, validate, forgetEvidence, editTarget }
}
