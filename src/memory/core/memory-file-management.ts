import { memoryFileIdentity, memoryFileListRequest, memoryFileMutation } from '../contracts/file-management.ts'
import type { MemoryManagedFileIdentity, MemoryFileListRequest, MemoryFileListResult, MemoryFileSummary, MemoryFileDetail,
  MemoryFileMutation, MemoryManagedFileVersion } from '../contracts/file-management.ts'
import type { createMemoryDocumentReadPolicy, MemoryDocumentManagementView } from './memory-document-read-policy.ts'
import type { MemoryDocuments } from './ports/documents.ts'
import { parseMemoryDocument } from './memory-document.ts'
import { MemoryDomainError } from './presentation.ts'

type Policy = Pick<ReturnType<typeof createMemoryDocumentReadPolicy>, 'managementList' | 'managementRead'>
type Allows = (view: MemoryDocumentManagementView) => boolean
const identityOf = (view: MemoryDocumentManagementView): MemoryManagedFileIdentity => ({ kind: view.kind, workspace: view.workspace, id: view.id })
const versionOf = (view: MemoryDocumentManagementView): MemoryManagedFileVersion => ({ contentRevision: view.revision, usageVersion: view.usageVersion, policyToken: view.policyToken })
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const failure = (code: 'not.found' | 'revision.conflict' | 'invalid.text') => new MemoryDomainError(code, `Memory file management: ${code}`)

/** Trusted host management only. Model tools must use the read policy's ordinary read/list paths.
 * This service owns no mutation or request fence; validate must run inside the runtime's sole fence. */
export function createMemoryFileManagement({ policy, documents, workspaces, hash }: {
  policy: Policy, documents: Pick<MemoryDocuments, 'undoCandidate'>, workspaces(): readonly string[], hash(text: string): string,
}) {
  function undoCandidate(view: MemoryDocumentManagementView) {
    if (view.kind !== 'digest') return null
    const candidate = documents.undoCandidate(view.workspace, view.id)
    return candidate?.revision === view.revision && candidate.usageVersion === view.usageVersion ? candidate : null
  }
  function summary(view: MemoryDocumentManagementView): MemoryFileSummary {
    const metadata = parseMemoryDocument(view.markdown).metadata
    const candidate = undoCandidate(view)
    return { identity: identityOf(view), version: versionOf(view), path: view.path,
      title: typeof metadata.name === 'string' ? metadata.name.slice(0, 200) : '', enabled: view.enabled,
      ...(view.day ? { day: view.day } : {}), applicability: view.applicability.state,
      actions: { setEnabled: view.kind === 'digest', edit: false, forget: false, undo: candidate ? { changeId: candidate.changeId } : null } }
  }
  function resolve(input: MemoryManagedFileIdentity, allows: Allows): MemoryDocumentManagementView | null {
    const identity = memoryFileIdentity.parse(input)
    if (!workspaces().includes(identity.workspace)) return null
    const found = policy.managementList(identity.workspace).find(view => view.kind === identity.kind && view.id === identity.id)
    // Identity never falls back to a former path: a replacement at that path is a different file.
    if (!found || !allows(found)) return null
    return found
  }
  function detail(input: MemoryManagedFileIdentity, allows: Allows): MemoryFileDetail | null {
    const view = resolve(input, allows)
    return view ? { ...summary(view), markdown: view.markdown, sources: view.sources.map(ref => ({ namespace: ref.namespace,
      sourceId: ref.sourceId, revision: ref.revision, ...(ref.occurrenceId ? { occurrenceId: ref.occurrenceId } : {}) })) } : null
  }
  function list(input: MemoryFileListRequest, allows: Allows): MemoryFileListResult {
    const request = memoryFileListRequest.parse(input), query = (request.query ?? '').trim().normalize('NFKC').toLowerCase()
    const views = [...new Set(workspaces())].flatMap(workspace => policy.managementList(workspace)).filter(allows)
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
    const version = versionOf(view)
    if (version.contentRevision !== command.version.contentRevision || version.usageVersion !== command.version.usageVersion
      || version.policyToken !== command.version.policyToken) throw failure('revision.conflict')
    if (view.kind !== 'digest') throw failure('invalid.text')
    const undo = command.action === 'undo' ? undoCandidate(view) : null
    if (command.action === 'undo' && (!undo || undo.changeId !== command.changeId)) throw failure('revision.conflict')
    return { view, undo }
  }
  return { list, detail, resolve, validate }
}
