import { memoryFileIdentity, memoryFileListRequest, memoryFileMutation } from '../contracts/file-management.ts'
import type { MemoryManagedFileIdentity, MemoryFileListRequest, MemoryFileListResult, MemoryFileSummary, MemoryFileDetail,
  MemoryFileForgetRequest, MemoryFileMutation, MemoryManagedFileVersion, MemoryFileEditRequest } from '../contracts/file-management.ts'
import type { createMemoryDocumentReadPolicy, MemoryDocumentManagementView } from './memory-document-read-policy.ts'
import type { DailyAllocation, DailyFileRegistration } from './ports/notes.ts'
import type { MemoryDocuments } from './ports/documents.ts'
import { parseMemoryDocument } from './memory-document.ts'
import { MemoryDomainError } from './presentation.ts'

type ManagedView = MemoryDocumentManagementView & { daily?: { allocation: DailyAllocation } }
type Policy = Pick<ReturnType<typeof createMemoryDocumentReadPolicy>, 'managementList' | 'managementRead'>
type ReadManagedFile = (workspace: string, path: string) => MemoryDocumentManagementView | null
type Allows = (view: MemoryDocumentManagementView) => boolean
type RegistryEntry = { identity: MemoryManagedFileIdentity, path: string, revision: string, usage: number, allocation?: DailyAllocation }
const identityOf = (view: MemoryDocumentManagementView): MemoryManagedFileIdentity => ({ kind: view.kind, workspace: view.workspace, id: view.id })
const versionOf = (view: MemoryDocumentManagementView): MemoryManagedFileVersion => ({ contentRevision: view.revision, usageVersion: view.usageVersion, policyToken: view.policyToken })
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const failure = (code: 'not.found' | 'revision.conflict' | 'invalid.text') => new MemoryDomainError(code, `Memory file management: ${code}`)

/** Trusted host management only. Model tools must use the read policy's ordinary read/list paths.
 * File mutations validate the expected version against the management view. */
export function createMemoryFileManagement({ policy, documents, workspaces, locate, hash, daily, editing = false }: {
  policy: Policy, documents: Pick<MemoryDocuments, 'undoCandidate' | 'fileRegistry'>, workspaces(): readonly string[], hash(text: string): string, daily?: { allocations(): DailyAllocation[] }, editing?: boolean,
  locate?(identity: MemoryManagedFileIdentity): string | null,
}) {
  function undoCandidate(view: MemoryDocumentManagementView) {
    if (view.kind !== 'digest' || !view.backing) return null
    const candidate = documents.undoCandidate(view.workspace, view.id, view.backing)
    return candidate?.revision === view.revision && candidate.usageVersion === view.usageVersion ? candidate : null
  }
  function managementViews(workspace: string, accepted = policy.managementList(workspace)): ManagedView[] {
    const allocations = new Map(daily?.allocations().filter(note => note.workspace === workspace)
      .map(note => [`daily:${hash(note.key)}`, note]))
    return accepted.map(view => {
      const allocation = view.kind === 'daily' ? allocations.get(view.id) : undefined
      return allocation ? { ...view, daily: { allocation } } : view
    })
  }
  const editSupported = (view: ManagedView) => editing && view.kind === 'digest' && view.backing !== null && view.enabled
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
      ...(view.day ? { day: view.day } : {}),
      actions: { setEnabled: true, edit: editSupported(view), forget: forgetSupported(view), undo: candidate ? { changeId: candidate.changeId } : null } }
  }
  function resolve(input: MemoryManagedFileIdentity, allows: Allows, read: ReadManagedFile = policy.managementRead): ManagedView | null {
    const identity = memoryFileIdentity.parse(input)
    if (!workspaces().includes(identity.workspace)) return null
    const path = locate?.(identity)
    const view = path ? read(identity.workspace, path) : null
    const accepted = locate ? [view].filter(item => item !== null) : undefined
    const found = managementViews(identity.workspace, accepted).find(view => view.kind === identity.kind && view.id === identity.id)
    // Identity never falls back to a former path: a replacement at that path is a different file.
    if (!found || !allows(found)) return null
    return found
  }
  function detail(input: MemoryManagedFileIdentity, allows: Allows, read?: ReadManagedFile): MemoryFileDetail | null {
    const view = resolve(input, allows, read)
    if (!view) return null
    const item: MemoryFileDetail = { ...summary(view), markdown: view.markdown, sources: view.sources }
    if (item.actions.edit) {
      const { metadata, body } = parseMemoryDocument(view.markdown)
      item.editor = { title: typeof metadata.name === 'string' ? metadata.name : '', text: body }
    }
    return item
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
        if (doc.state === 'forgotten' || !acceptsState(doc.state === 'active')) continue
        entries.push({ identity: { kind: 'digest', workspace, id: doc.id }, path: doc.path,
          revision: doc.revision, usage: doc.usageVersion })
      }
    }
    if (request.kind !== 'digest' && daily) for (const { fileRevision, ...note } of notes) {
      if (!scopes.has(note.workspace) || !fileRevision || !acceptsState(note.enabled)) continue
      entries.push({ identity: { kind: 'daily', workspace: note.workspace, id: `daily:${hash(note.key)}` }, path: note.path,
        revision: fileRevision ?? '', usage: note.revision, allocation: note })
    }
    entries.sort(({ identity: a }, { identity: b }) => compare(a.kind, b.kind) || compare(a.workspace, b.workspace) || compare(a.id, b.id))
    const revision = options.revision()
    const snapshot = hash(JSON.stringify([revision, request.kind ?? null, state, query, entries.map(({ identity, path, revision, usage }) =>
      [identity.kind, identity.workspace, identity.id, path, revision, usage])]))
    const stale = (): MemoryFileListResult => ({ status: 'stale', snapshot, items: [], nextCursor: null })
    let offset = request.cursor?.offset ?? 0
    if (request.cursor && (request.cursor.snapshot !== snapshot || offset > entries.length)) return stale()
    const retry = [...new Set(request.cursor?.retry ?? [])]
    if (retry.some(index => index >= offset)) return stale()
    const limit = request.limit ?? 25
    const firstNewIndex = offset
    const end = Math.min(entries.length, offset + 100 - retry.length)
    const unread: number[] = []
    const items: MemoryFileSummary[] = []
    let partial = false
    while ((retry.length || offset < end) && items.length < limit) {
      if (options.exhausted?.()) { partial = true; break }
      const indices = offset < end ? [offset++] : []
      indices.push(...retry.splice(0, limit - items.length - indices.length))
      while (offset < end && indices.length < limit - items.length) indices.push(offset++)
      const candidates = indices.map(index => entries[index]!)
      const read = await options.load(candidates.map(({ identity, path }) => ({ workspace: identity.workspace, path })))
      options.signal?.throwIfAborted()
      if (options.revision() !== revision) return stale()
      for (const [n, { identity, path, allocation }] of candidates.entries()) {
        const observed = read(identity.workspace, path)
        if (observed === undefined) {
          partial = true
          // Offer each unknown row once more on this walk. A refresh starts a new walk.
          if (indices[n]! >= firstNewIndex) unread.push(indices[n]!)
          continue
        }
        const view = observed?.kind === identity.kind && observed.id === identity.id ? observed : undefined
        const item = view && allocation ? { ...view, daily: { allocation } } : view
        if (!item || !allows(item) || !acceptsState(item.enabled)) continue
        const title = titleOf(item)
        if (!query || `${title}\n${item.path}`.normalize('NFKC').toLowerCase().includes(query)) items.push(summary(item, title))
      }
    }
    // Preserve unobserved rows without replaying healthy results returned on the same page.
    unread.push(...retry)
    partial ||= unread.length > 0
    const nextCursor = offset < entries.length || unread.length ? { snapshot, offset, ...(unread.length > 0 && { retry: unread }) } : null
    return { status: 'ok', snapshot, items, ...(partial && { partial }), nextCursor }
  }
  function validate(input: MemoryFileMutation, allows: Allows) {
    const command = memoryFileMutation.parse(input), view = resolve(command.identity, allows)
    if (!view) throw failure('not.found')
    if (view.kind === 'daily' && (!view.daily || command.action !== 'setEnabled')) throw failure('invalid.text')
    const version = versionOf(view)
    if (version.contentRevision !== command.version.contentRevision || version.usageVersion !== command.version.usageVersion
      || version.policyToken !== command.version.policyToken) throw failure('revision.conflict')
    const undo = command.action === 'undo' ? undoCandidate(view) : null
    if (command.action === 'undo' && (!undo || undo.changeId !== command.changeId)) throw failure('revision.conflict')
    return { view, undo }
  }
  function deletionTarget(command: MemoryFileForgetRequest, allows: Allows) {
    const view = resolve(command.identity, allows)
    if (!view || !forgetSupported(view)) throw failure('not.found')
    const expected = command.version, current = versionOf(view)
    if (current.contentRevision !== expected.contentRevision || current.usageVersion !== expected.usageVersion
      || current.policyToken !== expected.policyToken) throw failure('revision.conflict')
    return view
  }
  function editTarget(command: MemoryFileEditRequest, allows: Allows) {
    const view = resolve(command.identity, allows)
    if (!view || !view.backing || !editSupported(view)) throw failure('revision.conflict')
    const current = versionOf(view), expected = command.version
    if (current.contentRevision !== expected.contentRevision || current.usageVersion !== expected.usageVersion
      || current.policyToken !== expected.policyToken) throw failure('revision.conflict')
    return view.backing
  }
  return { list, listPage, detail, resolve, validate, deletionTarget, editTarget }
}
