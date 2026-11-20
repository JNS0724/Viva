import type { MemoryFileIndexChanges } from '../core/ports/runtime.ts'
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MemoryDocuments, DocumentSnapshot, DocumentCommit, DocumentReceipt, DocumentSourceCut, DocumentSourceRef, DocumentReadRef, DocumentCorrection, DocumentSupersession, DocumentUndoCandidate, DocumentManagementGuard, DocumentManualWrite, MemoryPhysicalFile } from '../core/ports/documents.ts'
import { digestPath, memoryFilePath } from '../contracts/memory-file-contract.ts'
import { parseMemoryDocument, readMemoryLines, memoryDocumentLines } from '../core/memory-document.ts'
import type { MemorySource } from '../contracts/records.ts'
import { memoryFileRevision } from './memory-file-store.ts'
import { fileErasure, openMemoryFileJournal } from './memory-file-journal.ts'
import type { FileCheckpoint, FilePlan } from './memory-file-journal.ts'
import { documentSourceProofCurrent, documentSourceRestricted, subtractDocumentSourceSpans } from '../core/memory-document-restrictions.ts'
import { MemoryDomainError } from '../core/presentation.ts'
import { transaction, truncateMemoryJournal } from './sqlite.ts'
import { maskMemoryWikiLinks } from '../core/memory-markdown.ts'
import { openMemoryFileRestrictions } from './memory-file-restrictions.ts'

type Row = { id: string, workspace: string, path: string, revision: string, usage_version: number, enabled: number, forgotten: number, sources: string, corrections: string }
type Revision = { operation: string, document: string, before: string | null, after: string | null }
type Mutation = { kind: 'revision', input: string, receipt: DocumentReceipt, before: DocumentSnapshot | null, after: DocumentSnapshot | null, sources: DocumentSourceRef[], reads: DocumentReadRef[], files: Array<{ path: string, revision: string }>, workspace: string, management?: DocumentManagementGuard, manualSource?: MemorySource }
type Purge = { kind: 'purge', fileOnly?: boolean, document: string, workspace: string, path: string, expected_revision: string | null, retire_path: number }
type LocatorFile = { id: string, workspace: string, path: string, revision: string, kind: 'digest' | 'daily' }
type LocatorCleanup = Omit<LocatorFile, 'kind'> & { kind: 'locator-cleanup', target: LocatorFile['kind'], projected: string, fingerprints: string[] }
type Data = Mutation | Purge | LocatorCleanup
type Restore = { operation: string, document: string, workspace: string, path: string, revision: string, written: string, usage: number, markdown: string, sources: string, removed: string }
const encode = (value: unknown) => JSON.stringify(value)
const hash = (value: unknown) => memoryFileRevision(encode(value))
const erasedPath = (id: string) => `digest/wiki/erased-${memoryFileRevision(id)}.md`
const refsOf = (row: Row): DocumentSourceRef[] => JSON.parse(row.sources) as DocumentSourceRef[]
const readVersions = (reads: readonly DocumentReadRef[]): DocumentReadRef[] =>
  reads.map(({ id, revision, usageVersion }) => ({ id, revision, usageVersion }))
const correctionsOf = (row: Row): DocumentSupersession[] => JSON.parse(row.corrections) as DocumentSupersession[]

/** Persistence adapter: current Markdown is authoritative; SQL stores identities, revisions and recovery metadata. */
export function openMemoryDocuments({ db, root, source, now = Date.now, checkpoint, erasures = () => [], onCommitted = () => {}, managementCurrent = () => false, manual, expandRestrictions = () => [], locatorCleaned = () => {}, index, deferRecovery = false }: {
  db: DatabaseSync, root: string,
  source: (id: string) => { token: string, workspace: string, text: string, erasure?: DocumentSourceRef } | undefined,
  now?: () => number,
  erasures?: (workspace: string) => DocumentSourceRef[],
  onCommitted?: (receipt: DocumentReceipt) => void,
  managementCurrent?: (before: DocumentSnapshot, guard: DocumentManagementGuard, after: DocumentSnapshot, staged?: MemorySource) => boolean,
  manual?: { token(source: MemorySource): string, workspace(source: MemorySource): string,
    current(source: MemorySource): boolean, commit(source: MemorySource, parents: readonly DocumentSourceRef[]): void,
    retainsText(matches: (workspace: string, text: string) => boolean): boolean },
  expandRestrictions?: (refs: readonly DocumentSourceRef[]) => DocumentSourceRef[],
  locatorCleaned?: () => void,
  index?: MemoryFileIndexChanges,
  deferRecovery?: boolean,
  checkpoint?: (point: FileCheckpoint, path?: string) => void,
}): MemoryDocuments {
  db.exec(`PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS memory_documents (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL,
      usage_version INTEGER NOT NULL, enabled INTEGER NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0,
      sources TEXT NOT NULL, corrections TEXT NOT NULL, UNIQUE(workspace,path)
    );
    CREATE TABLE IF NOT EXISTS memory_document_revisions (
      operation TEXT PRIMARY KEY, document TEXT NOT NULL, before TEXT, after TEXT, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_document_revision_by_document ON memory_document_revisions(document);
    CREATE TABLE IF NOT EXISTS memory_document_receipts (
      operation TEXT PRIMARY KEY, input TEXT NOT NULL, receipt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_document_restores (
      operation TEXT PRIMARY KEY, document TEXT NOT NULL, workspace TEXT NOT NULL, path TEXT NOT NULL,
      revision TEXT NOT NULL, written TEXT NOT NULL, usage INTEGER NOT NULL, markdown TEXT NOT NULL, sources TEXT NOT NULL, removed TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_document_erasures (source TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS memory_document_erased_locators (
      workspace TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(workspace,fingerprint)
    );
    CREATE TABLE IF NOT EXISTS memory_document_purges (
      document TEXT PRIMARY KEY, workspace TEXT NOT NULL, path TEXT NOT NULL, sources TEXT NOT NULL, expected_revision TEXT, retire_path INTEGER NOT NULL DEFAULT 0
    );
  `)
  const useRestrictions = openMemoryFileRestrictions(db)
  function workspace(value: string) {
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('invalid-memory-workspace')
  }
  function rowById(id: string): Row | undefined {
    return db.prepare('SELECT * FROM memory_documents WHERE id=?').get(id) as Row | undefined
  }
  function rowByPath(scope: string, path: string): Row | undefined {
    return db.prepare('SELECT * FROM memory_documents WHERE workspace=? AND path=?').get(scope, path) as Row | undefined
  }
  function currentSources(scope: string, refs: readonly DocumentSourceRef[], staged?: MemorySource) {
    return refs.length > 0 && new Set(refs.map(ref => ref.id)).size === refs.length && refs.every(ref => {
      const actual = staged && staged.id === ref.id && manual && staged.text
        ? { token: manual.token(staged), workspace: manual.workspace(staged), text: staged.text, erasure: undefined }
        : source(ref.id)
      return actual?.workspace === scope && documentSourceProofCurrent(ref, actual.text, actual.token, actual.erasure)
    })
  }
  function currentReads(scope: string, refs: readonly DocumentReadRef[], changing?: Mutation): boolean {
    return refs.every(ref => {
      const row = rowById(ref.id)
      if (!row || row.workspace !== scope || row.forgotten || !row.enabled || row.revision !== ref.revision || row.usage_version !== ref.usageVersion || !currentSources(scope, refsOf(row)) || restricted(scope, refsOf(row), row.id)) return false
      if (changing?.after?.id !== row.id && !journal.visible(scope, row.path)) return false
      const file = journal.files(scope).read(row.path)
      return file?.revision === row.revision || (changing?.after?.id === row.id && file?.revision === changing.after.revision)
    })
  }
  function restricted(scope: string, refs: readonly DocumentSourceRef[], except?: string): boolean {
    const restrictions = sourceRestrictions(scope, except)
    return refs.some(ref => documentSourceRestricted(ref, restrictions))
  }
  function save(snapshot: DocumentSnapshot) {
    db.prepare(`INSERT INTO memory_documents(id,workspace,path,revision,usage_version,enabled,forgotten,sources,corrections)
      VALUES(?,?,?,?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,revision=excluded.revision,
      usage_version=excluded.usage_version,enabled=excluded.enabled,sources=excluded.sources,corrections=excluded.corrections`)
      .run(snapshot.id, snapshot.workspace, snapshot.path, snapshot.revision, snapshot.usageVersion, snapshot.enabled ? 1 : 0, encode(snapshot.sources), encode(snapshot.corrections))
  }
  const managed = (data: Data) => data.kind === 'revision' && (data.management !== undefined || data.manualSource !== undefined)
  const indexAnchorId = (id: string) => id.startsWith('[') ? `daily:${memoryFileRevision(id)}` : id
  const journal = openMemoryFileJournal<Data>({ db, root, namespace: 'documents', checkpoint,
    afterCommit(data, workspace) {
      if (data.kind === 'revision') index?.publish(workspace, data.receipt.documentId)
      else if (data.kind === 'locator-cleanup') index?.publish(workspace, data.target === 'daily' ? `daily:${memoryFileRevision(data.id)}` : data.id)
    },
    cancelOnConflict: managed,
    projectErasure(data, _path, before) {
      if (data.kind === 'locator-cleanup') return locatorProjection(before, new Set(data.fingerprints))
    },
    valid(data): boolean {
      if (data.kind === 'locator-cleanup') return currentLocatorFile(data)
      if (data.kind === 'purge') return Boolean(rowById(data.document)?.forgotten)
      const actual = rowByPath(data.workspace, data.receipt.path)
      const before = data.before
      const targetCurrent = before ? actual?.id === before.id && actual.revision === before.revision && actual.usage_version === before.usageVersion && !actual.forgotten
        : !actual && !locatorRetired(data.workspace, data.receipt.path)
      if (data.manualSource) {
        // A locator may be retired after this draft was written but before its receipt.
        if (!data.after || !manual?.current(data.manualSource)
          || !manualLocatorsCurrent(data.workspace, data.after.markdown, data.manualSource)) return false
      }
      if (data.after && data.after.markdown !== before?.markdown
        && projectErasedLocators(data.workspace, data.after.markdown) !== data.after.markdown) return false
      if (data.management) {
        if (!targetCurrent || !before || !data.after || !actual) return false
        const physical = journal.files(data.workspace).read(before.path)?.revision
        if (physical !== before.revision && physical !== data.after.revision) return false
        if (memoryFileRevision(before.markdown) !== before.revision || Boolean(actual.enabled) !== before.enabled
          || !isDeepStrictEqual(refsOf(actual), before.sources) || !isDeepStrictEqual(correctionsOf(actual), before.corrections)) return false
        if (data.management.changeId !== undefined && undoHistory(before)?.history.operation !== data.management.changeId) return false
        if (!managementCurrent(before, data.management, data.after, data.manualSource)) return false
      }
      return targetCurrent && currentSources(data.workspace, data.sources, data.manualSource) && (['ENABLE', 'DISABLE', 'UNDO'].includes(data.receipt.action) || !restricted(data.workspace, data.sources, data.receipt.documentId)) && currentReads(data.workspace, data.reads, data) && data.files.every(file => {
        const actual = journal.files(data.workspace).read(file.path)?.revision
        return (data.after?.path === file.path || journal.visible(data.workspace, file.path)) && (actual === file.revision || data.after?.path === file.path && actual === data.after.revision)
      })
    },
    finish(data) {
      if (data.kind === 'locator-cleanup') {
        if (data.target === 'digest') db.prepare('UPDATE memory_documents SET revision=? WHERE id=?').run(data.projected, data.id)
        else db.prepare('UPDATE memory_daily_notes SET file_revision=? WHERE key=?').run(data.projected, data.id)
        cleanLocatorMetadata(data.workspace, new Map([[data.revision, data.projected]]))
        index?.queue({ workspace: data.workspace, id: data.target === 'daily' ? `daily:${memoryFileRevision(data.id)}` : data.id })
        locatorCleaned()
        return
      }
      if (data.kind === 'purge') {
        if (data.retire_path) {
          const base = erasedPath(data.document).slice(0, -3)
          let path = `${base}.md`, suffix = 1
          while (rowByPath(data.workspace, path) && rowByPath(data.workspace, path)?.id !== data.document) path = `${base}-${suffix++}.md`
          db.prepare('UPDATE memory_documents SET path=? WHERE id=?').run(path, data.document)
          for (const row of db.prepare("SELECT operation,receipt FROM memory_document_receipts WHERE json_extract(receipt,'$.documentId')=?").all(data.document)) {
            const receipt = JSON.parse(String(row.receipt)) as DocumentReceipt
            db.prepare('UPDATE memory_document_receipts SET receipt=? WHERE operation=?').run(encode({ ...receipt, path }), row.operation)
          }
        }
        db.prepare('DELETE FROM memory_document_purges WHERE document=?').run(data.document)
        return
      }
      if (data.manualSource) manual!.commit(data.manualSource, data.before?.sources ?? [])
      const unchanged = isDeepStrictEqual(data.before, data.after)
      if (!unchanged && data.after) {
        save(data.after)
        if (data.receipt.action === 'ENABLE') {
          useRestrictions.removeTarget({ kind: 'digest', workspace: data.workspace, key: data.after.id })
        } else if (data.receipt.action === 'DISABLE') {
          useRestrictions.add({ kind: 'digest', workspace: data.workspace, key: data.after.id, id: data.receipt.operationId,
            contentRevision: data.after.revision, usageVersion: data.after.usageVersion, sources: data.after.sources })
        }
        // An undo on a disabled document must keep the original blocked ranges.
      }
      else if (!unchanged && data.before) db.prepare('UPDATE memory_documents SET forgotten=1,enabled=0,usage_version=usage_version+1,sources=?,corrections=? WHERE id=?').run('[]', '[]', data.before.id)
      if (!unchanged) db.prepare('INSERT INTO memory_document_revisions(operation,document,before,after,at) VALUES(?,?,?,?,?)')
        .run(data.receipt.operationId, data.receipt.documentId, data.before ? encode(data.before) : null, data.after ? encode(data.after) : null, now())
      db.prepare('INSERT INTO memory_document_receipts(operation,input,receipt) VALUES(?,?,?)').run(data.receipt.operationId, data.input, encode(data.receipt))
      if (!unchanged) {
        index?.queue({ workspace: data.workspace, id: data.receipt.documentId,
          anchors: [...data.before?.corrections ?? [], ...data.after?.corrections ?? []].map(item => indexAnchorId(item.sourceDocumentId)),
          ...(data.receipt.action === 'ENABLE' || data.receipt.action === 'DISABLE'
            ? { sources: [...data.before?.sources ?? [], ...data.after?.sources ?? []].map(ref => ref.id) } : {}),
        })
        onCommitted(data.receipt)
      }
    },
  })
  function replay(operation: string, input: unknown): DocumentReceipt | undefined {
    const row = db.prepare('SELECT input,receipt FROM memory_document_receipts WHERE operation=?').get(operation) as { input: string, receipt: string } | undefined
    if (!row) return
    if (row.input !== hash(input)) throw new Error('memory-request-input-mismatch')
    return JSON.parse(row.receipt) as DocumentReceipt
  }
  function read(scope: string, path: string, options: { includeDisabled?: boolean, physical?: MemoryPhysicalFile | null } = {}): DocumentSnapshot | null {
    workspace(scope)
    digestPath.parse(path)
    const row = rowByPath(scope, path)
    if (db.prepare('SELECT 1 FROM memory_document_restores WHERE workspace=? AND path=?').get(scope, path)) return null
    if (!row || row.forgotten || (!row.enabled && !options.includeDisabled) || !currentSources(scope, refsOf(row)) || (!options.includeDisabled && restricted(scope, refsOf(row), row.id)) || !journal.visible(scope, path)) return null
    const file = options.physical === undefined ? journal.files(scope).read(path) : options.physical
    // An external edit has no verified provenance. It is quarantined, never silently reinterpreted.
    if (!file || file.path !== path || file.revision !== row.revision) return null
    return { id: row.id, workspace: scope, path, revision: row.revision, usageVersion: row.usage_version, markdown: file.markdown, sources: refsOf(row), enabled: Boolean(row.enabled), corrections: correctionsOf(row) }
  }
  function list(scope: string, options?: { includeDisabled?: boolean }): DocumentSnapshot[] {
    workspace(scope)
    return (db.prepare('SELECT path FROM memory_documents WHERE workspace=? ORDER BY path').all(scope) as Array<{ path: string }>)
      .flatMap(row => read(scope, row.path, options) ?? [])
  }
  function correctionAnchor(scope: string, path: string, physical?: MemoryPhysicalFile | null): { id: string, sources: DocumentSourceRef[] } | undefined {
    const document = rowByPath(scope, path)
    if (document) return { id: document.id, sources: refsOf(document) }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_daily_notes'").get()) {
      const note = db.prepare('SELECT key,file_revision FROM memory_daily_notes WHERE workspace=? AND path=? AND file_revision IS NOT NULL')
        .get(scope, path) as { key: string, file_revision: string } | undefined
      const file = note && (physical === undefined ? journal.files(scope).read(path) : physical)
      if (note && file && file.path === path && file.revision === note.file_revision) {
        const rows = db.prepare('SELECT source AS id,token,spans FROM memory_note_sources WHERE note=? ORDER BY rowid')
          .all(note.key) as Array<{ id: string, token: string, spans: string | null }>
        return { id: note.key, sources: rows.map(({ spans, ...ref }) => ({ ...ref,
          ...(spans ? { spans: JSON.parse(spans) as NonNullable<DocumentSourceRef['spans']> } : {}) })) }
      }
    }
  }
  function validateCorrections(scope: string, corrections: readonly DocumentCorrection[]) {
    for (const correction of corrections) {
      memoryFilePath.parse(correction.path)
      const anchor = correctionAnchor(scope, correction.path)
      if (!anchor) throw new Error('memory-correction-source-identity')
      if (!currentSources(scope, anchor.sources)) throw new Error('memory-correction-source-version')
      const file = journal.files(scope).read(correction.path)
      if (!file || file.revision !== correction.revision || !correction.text || correction.endLine > memoryDocumentLines(file.markdown).length || readMemoryLines(file.markdown, correction.startLine, correction.endLine) !== correction.text) throw new Error('memory-correction-version')
      if (!journal.visible(scope, correction.path)) throw new Error('memory-correction-pending')
    }
  }
  function correctionRecord(scope: string, correction: DocumentCorrection, documentId: string, replacementRevision: string, operationId: string): DocumentSupersession {
    const anchor = correctionAnchor(scope, correction.path)
    if (!anchor) throw new Error('memory-correction-source-identity')
    return { ...correction, sourceDocumentId: anchor.id, anchorSources: anchor.sources, documentId, replacementRevision, operationId }
  }
  function apply(input: unknown, before: DocumentSnapshot | null, after: DocumentSnapshot | null, receipt: DocumentReceipt, sources: DocumentSourceRef[], reads: DocumentReadRef[], files: Array<{ path: string, revision: string }> = [], management?: DocumentManagementGuard, manualSource?: MemorySource) {
    const scope = after?.workspace ?? before!.workspace
    const data: Mutation = { kind: 'revision', input: hash(input), before, after, receipt, sources, reads: readVersions(reads), files, workspace: scope, management, manualSource }
    try {
      if (!journal.commit(receipt.operationId, data.input, () => ({ workspace: scope, changes: isDeepStrictEqual(before, after) ? [] : [{ path: receipt.path, before: before?.markdown ?? null, after: after?.markdown ?? null }], data }))) throw new Error('memory-document-invalidated')
    } catch (error) {
      if ((management || manualSource) && error instanceof Error) {
        if (error.message === 'memory-file-plan-busy') throw new MemoryDomainError('change.pending')
        if (['memory-source-version', 'memory-document-invalidated', 'memory-file-version'].includes(error.message)) throw new MemoryDomainError('revision.conflict')
      }
      throw error
    }
    const committed = db.prepare('SELECT receipt FROM memory_document_receipts WHERE operation=?').get(receipt.operationId) as { receipt: string } | undefined
    if (!committed) throw new Error('memory-document-receipt-missing')
    return JSON.parse(committed.receipt) as DocumentReceipt
  }
  function commit(input: DocumentCommit): DocumentReceipt {
    workspace(input.workspace)
    const prior = replay(input.operationId, input)
    if (prior) return prior
    digestPath.parse(input.path)
    parseMemoryDocument(input.markdown)
    if (locatorRetired(input.workspace, input.path)) throw new Error('memory-document-unavailable')
    if (projectErasedLocators(input.workspace, input.markdown) !== input.markdown) throw new Error('memory-document-erased-locator')
    const before = read(input.workspace, input.path)
    if (rowByPath(input.workspace, input.path) && !before) throw new Error('memory-document-unavailable')
    if ((before?.revision ?? null) !== input.expectedRevision) throw new Error('memory-document-version')
    if ((input.action === 'CREATE') !== !before) throw new Error('memory-document-action')
    if (before && before.sources.some(ref => !input.sources.some(next => next.id === ref.id && next.token === ref.token && (!next.spans || ref.spans && ref.spans.every(part => next.spans!.some(span => span.start <= part.start && span.end >= part.end)))))) throw new Error('memory-document-source-loss')
    if (input.action === 'CORRECT' && !input.corrections?.length) throw new Error('memory-correction-required')
    if (input.action !== 'CORRECT' && input.corrections?.length) throw new Error('memory-correction-action')
    if (!currentSources(input.workspace, input.sources) || restricted(input.workspace, input.sources, before?.id) || !currentReads(input.workspace, input.reads)) throw new Error('memory-document-source-version')
    validateCorrections(input.workspace, input.corrections ?? [])
    const id = before?.id ?? randomUUID(), revision = memoryFileRevision(input.markdown), usageVersion = (before?.usageVersion ?? 0) + 1
    const corrections = [...(before?.corrections ?? []), ...(input.corrections ?? []).map(correction => correctionRecord(input.workspace, correction, id, revision, input.operationId))]
    const after: DocumentSnapshot = { id, workspace: input.workspace, path: input.path, revision, usageVersion, markdown: input.markdown, sources: input.sources, enabled: true, corrections }
    const receipt: DocumentReceipt = { operationId: input.operationId, documentId: id, path: input.path, revision, usageVersion, action: input.action }
    return apply(input, before, after, receipt, input.sources, input.reads, [...new Map([...(input.files ?? []), ...(input.corrections ?? []).map(item => ({ path: item.path, revision: item.revision }))].map(item => [item.path, item])).values()])
  }
  function writeManual(input: DocumentManualWrite): DocumentReceipt {
    workspace(input.workspace)
    const prior = replay(input.operationId, input)
    if (prior) return prior
    if (!manual) throw new MemoryDomainError('not.found')
    digestPath.parse(input.path)
    parseMemoryDocument(input.markdown)
    if (locatorRetired(input.workspace, input.path) || !manualLocatorsCurrent(input.workspace, input.markdown, input.source)) throw new MemoryDomainError('revision.conflict')
    const before = read(input.workspace, input.path)
    const expected = input.expected
    if (expected ? !before || before.id !== expected.id || before.revision !== expected.revision || before.usageVersion !== expected.usageVersion
      : rowByPath(input.workspace, input.path)) throw new MemoryDomainError('revision.conflict')
    const displayed = before && !input.source ? projectErasedLocators(input.workspace, before.markdown) : before?.markdown
    const unchanged = displayed === input.markdown
    if (Boolean(input.source) === unchanged) throw new MemoryDomainError('invalid.text')
    const sources = [...before?.sources ?? [], ...(input.source ? [{ id: input.source.id, token: manual.token(input.source) }] : [])]
    const after: DocumentSnapshot = unchanged ? before! : {
      id: before?.id ?? randomUUID(), workspace: input.workspace, path: input.path, revision: memoryFileRevision(input.markdown),
      usageVersion: (before?.usageVersion ?? 0) + 1, markdown: input.markdown, enabled: true, sources,
      corrections: before?.corrections ?? [],
    }
    const receipt: DocumentReceipt = { operationId: input.operationId, documentId: after.id, path: after.path,
      revision: after.revision, usageVersion: after.usageVersion, action: before ? 'REFINE' : 'CREATE' }
    return apply(input, before, after, receipt, sources, [], [], expected && { policyToken: expected.policyToken }, input.source ?? undefined)
  }

  /** Walk only the contiguous current chain. An UNDO ends it: this is undo, not redo or a history browser. */
  function undoHistory(current: DocumentSnapshot): { history: Revision, original: DocumentSnapshot } | null {
    const revisions = db.prepare('SELECT * FROM memory_document_revisions WHERE document=? ORDER BY rowid DESC').all(current.id) as Revision[]
    let cursor = current
    for (const item of revisions) {
      if (!item.after) return null
      const after = JSON.parse(item.after) as DocumentSnapshot
      if (after.revision !== cursor.revision || after.usageVersion !== cursor.usageVersion) return null
      const operation = readReceipt(current.workspace, item.operation)
      if (!operation || !item.before) return null
      const original = JSON.parse(item.before) as DocumentSnapshot
      if (['ENABLE', 'DISABLE'].includes(operation.action)) { cursor = original; continue }
      if (!['REFINE', 'CORRECT'].includes(operation.action) || !currentSources(current.workspace, original.sources)
        || after.corrections.some(item => item.operationId === operation.operationId && !item.text)) return null
      return { history: item, original }
    }
    return null
  }
  function undoCandidate(scope: string, documentId: string, accepted?: DocumentSnapshot): DocumentUndoCandidate | null {
    workspace(scope)
    const row = rowById(documentId)
    if (!row || row.workspace !== scope) return null
    const current = accepted ?? read(scope, row.path, { includeDisabled: true })
    if (!current || current.workspace !== scope || current.id !== documentId || current.path !== row.path
      || current.revision !== row.revision || current.usageVersion !== row.usage_version || row.forgotten) return null
    const candidate = undoHistory(current)
    return candidate ? { changeId: candidate.history.operation, revision: current.revision, usageVersion: current.usageVersion } : null
  }
  function undo(input: { operationId: string, workspace: string, documentId: string, revision: string, usageVersion: number, expectedChangeId?: string, expectedPolicyToken?: string }): DocumentReceipt {
    workspace(input.workspace)
    const prior = replay(input.operationId, input)
    if (prior) return prior
    const row = rowById(input.documentId)
    if (!row || row.workspace !== input.workspace) throw new Error('memory-document-unavailable')
    const current = read(input.workspace, row.path, { includeDisabled: true })
    if (!current || current.revision !== input.revision || current.usageVersion !== input.usageVersion) throw new Error('memory-document-version')
    const candidate = undoHistory(current)
    if (!candidate) throw new Error('memory-document-undo-unavailable')
    if (input.expectedChangeId !== undefined && input.expectedChangeId !== candidate.history.operation) throw new Error('memory-document-change-version')
    const { original } = candidate
    const markdown = projectErasedLocators(input.workspace, original.markdown)
    const after = { ...original, markdown, revision: memoryFileRevision(markdown),
      path: current.path, enabled: current.enabled, usageVersion: current.usageVersion + 1 }
    const receipt: DocumentReceipt = { operationId: input.operationId, documentId: row.id, path: row.path, revision: after.revision, usageVersion: after.usageVersion, action: 'UNDO' }
    const management = input.expectedPolicyToken === undefined ? undefined : { policyToken: input.expectedPolicyToken, changeId: candidate.history.operation }
    return apply(input, current, after, receipt, [...new Map([...current.sources, ...original.sources].map(ref => [ref.id, ref])).values()], [], [], management)
  }
  function setEnabled(input: { operationId: string, workspace: string, documentId: string, expectedRevision: string, expectedUsageVersion: number, enabled: boolean, expectedPolicyToken?: string }): DocumentReceipt {
    workspace(input.workspace)
    const prior = replay(input.operationId, input)
    if (prior) return prior
    const row = rowById(input.documentId)
    if (!row || row.workspace !== input.workspace) throw new Error('memory-document-unavailable')
    const current = read(input.workspace, row.path, { includeDisabled: true })
    if (!current || current.revision !== input.expectedRevision || current.usageVersion !== input.expectedUsageVersion) throw new Error('memory-document-version')
    const after = { ...current, enabled: input.enabled, usageVersion: current.usageVersion + Number(current.enabled !== input.enabled) }
    const receipt: DocumentReceipt = { operationId: input.operationId, documentId: row.id, path: row.path, revision: after.revision, usageVersion: after.usageVersion, action: input.enabled ? 'ENABLE' : 'DISABLE' }
    const management = input.expectedPolicyToken === undefined ? undefined : { policyToken: input.expectedPolicyToken }
    return apply(input, current, after, receipt, current.sources, [], [], management)
  }
  function restorableFile(item: Restore) {
    const row = rowById(item.document)
    if (!row || row.forgotten || row.revision !== item.revision || row.usage_version !== item.usage
      || !currentSources(item.workspace, JSON.parse(item.sources) as DocumentSourceRef[])) return
    const file = journal.files(item.workspace).read(item.path)
    return file && [item.revision, item.written].includes(file.revision) ? file : undefined
  }
  const restores = () => db.prepare('SELECT * FROM memory_document_restores').all() as unknown as Restore[]
  const purges = () => db.prepare('SELECT document,workspace,path,sources,expected_revision,retire_path FROM memory_document_purges').all() as Array<Omit<Purge, 'kind' | 'fileOnly'> & { sources: string }>
  const purgeable = (purge: Omit<Purge, 'kind'>, revision?: string) =>
    !revision || purge.expected_revision === null || revision === purge.expected_revision
  function recover() {
    // Only the previously committed, independently sourced body survives an abandoned draft.
    // Its replacement contains no forgotten text; hashes describe the discarded draft without retaining it.
    for (const item of restores()) {
      const actual = restorableFile(item)
      if (!actual) continue
      if (actual.revision !== item.revision) journal.files(item.workspace).write(item.path, item.markdown, actual.revision)
      transaction(db, () => {
        db.prepare('DELETE FROM memory_document_restores WHERE operation=?').run(item.operation)
        db.prepare('DELETE FROM memory_file_reservations WHERE owner=?').run(item.operation)
      })
    }
    // Owner management intents must wait for the persisted host withdrawal watermarks.
    // Only an authenticated command replay may apply them under its send fence.
    for (const row of db.prepare("SELECT id,plan FROM memory_file_intents WHERE namespace='documents' AND plan IS NOT NULL").all()) {
      const { data } = JSON.parse(String(row.plan)) as FilePlan<Data>
      // Source erasure can retire a target while a locator rewrite is awaiting recovery.
      if (data.kind === 'locator-cleanup' && !currentLocatorFile(data)) {
        db.prepare("UPDATE memory_file_intents SET state='cancelled',plan=NULL WHERE id=?").run(row.id)
      }
    }
    journal.recover(undefined, data => !managed(data))
    applyPurges(purges())
    cleanLocatorFiles()
    checkpointCleanup()
  }
  function applyPurges(rows: ReturnType<typeof purges>) {
    for (const purge of rows) {
      try {
        for (const ref of JSON.parse(purge.sources) as DocumentSourceRef[]) db.prepare('INSERT OR IGNORE INTO memory_document_erasures(source) VALUES(?)').run(ref.id)
        const before = journal.files(purge.workspace).read(purge.path)
        // A prepared CREATE has no accepted ownership of unrelated on-disk bytes.
        // Keep cleanup pending if its physical state cannot be verified.
        if (!purgeable(purge, before?.revision)) continue
        journal.commit(`purge:${purge.document}`, hash(purge), () => ({ workspace: purge.workspace, changes: before ? [fileErasure({ path: purge.path, before: before.markdown, after: null })] : [], data: { ...purge, kind: 'purge', fileOnly: purge.sources === '[]' } }))
      } catch (error) {
        if (!(error instanceof Error && ['memory-file-plan-conflict', 'memory-file-plan-busy'].includes(error.message))) throw error
      }
    }
  }
  function checkpointCleanup() {
    if (db.prepare('SELECT 1 FROM memory_document_erasures LIMIT 1').get() && truncateMemoryJournal(db)) {
      db.prepare('DELETE FROM memory_document_erasures').run()
    }
  }
  function locatorFingerprints(scope: string) {
    return new Set(db.prepare('SELECT fingerprint FROM memory_document_erased_locators WHERE workspace=? ORDER BY fingerprint')
      .all(scope).map(row => String(row.fingerprint)))
  }
  function locatorRetired(scope: string, path: string) {
    return Boolean(db.prepare('SELECT 1 FROM memory_document_erased_locators WHERE workspace=? AND fingerprint=?').get(scope, memoryFileRevision(path)))
  }
  function preserveAuthoredLocatorSources(cuts: readonly DocumentSourceCut[], sources: readonly MemorySource[]) {
    if (!db.isTransaction) throw new Error('memory-locator-projection-outside-transaction')
    const history = db.prepare('SELECT * FROM memory_document_revisions').all() as unknown as Revision[]
    const manualOwners = new Map(history.flatMap(row => {
      const original = sources.find(source => source.id === row.operation && source.author === 'manual')
      const after = row.after ? JSON.parse(row.after) as DocumentSnapshot : null
      return original && after?.sources.some(ref => ref.id === original.id) ? [[original.id, after.id] as const] : []
    }))
    function authored(snapshot: DocumentSnapshot) {
      const document = parseMemoryDocument(snapshot.markdown)
      const body = projectErasedLocators(snapshot.workspace, document.body)
      const title = projectErasedLocators(snapshot.workspace, String(document.metadata.name ?? ''))
      return snapshot.sources.some(ref => {
        const original = sources.find(source => source.id === ref.id)
        const text = original?.text ? projectErasedLocators(snapshot.workspace, original.text) : null
        return manualOwners.get(ref.id) === snapshot.id && original?.text && original.hash
          && documentSourceProofCurrent(ref, original.text, source(ref.id)?.token ?? '', original.erasure ? { id: ref.id, ...original.erasure } : undefined)
          && (text === body || text === `${title}\n${body}`)
      })
    }
    function remaining(refs: readonly DocumentSourceRef[]) {
      return refs.flatMap(ref => {
        const relevant = cuts.filter(cut => documentSourceRestricted(ref, [cut]))
        if (!relevant.length) return [ref]
        const spans = subtractDocumentSourceSpans(relevant[0]!.length, ref, relevant)
        return spans.length ? [{ ...ref, spans }] : []
      })
    }
    function preserve(snapshot: DocumentSnapshot | null) {
      if (!snapshot || !authored(snapshot)) return snapshot
      const refs = remaining(snapshot.sources)
      return refs.length ? { ...snapshot, sources: refs } : snapshot
    }
    for (const row of db.prepare('SELECT * FROM memory_documents WHERE forgotten=0').all() as Row[]) {
      const retained = history.filter(item => item.document === row.id).flatMap(item => [item.after, item.before])
        .flatMap(encoded => encoded ? [JSON.parse(encoded) as DocumentSnapshot] : [])
        .find(snapshot => snapshot.revision === row.revision && snapshot.usageVersion === row.usage_version
          && memoryFileRevision(snapshot.markdown) === row.revision)
      const current = read(row.workspace, row.path, { includeDisabled: true })
        ?? (retained && currentSources(row.workspace, refsOf(row)) ? { ...retained, sources: refsOf(row), corrections: correctionsOf(row) } : null)
      if (!current || !authored(current)) continue
      const refs = remaining(current.sources)
      if (refs.length) db.prepare('UPDATE memory_documents SET sources=? WHERE id=?').run(encode(refs), row.id)
    }
    for (const row of history) {
      const project = (encoded: string | null) => {
        const snapshot = encoded ? JSON.parse(encoded) as DocumentSnapshot : null
        const updated = preserve(snapshot)
        return updated !== snapshot ? encode(updated) : encoded
      }
      const before = project(row.before), after = project(row.after)
      if (before !== row.before || after !== row.after) db.prepare('UPDATE memory_document_revisions SET before=?,after=? WHERE operation=?')
        .run(before, after, row.operation)
    }
    for (const row of db.prepare("SELECT id,plan FROM memory_file_intents WHERE namespace='documents' AND plan IS NOT NULL").all()) {
      const plan = JSON.parse(String(row.plan)) as FilePlan<Data>, data = plan.data
      if (data.kind !== 'revision' || data.manualSource) continue
      const before = preserve(data.before), after = preserve(data.after)
      if (before === data.before && after === data.after) continue
      const sources = after !== data.after ? remaining(data.sources) : data.sources
      db.prepare('UPDATE memory_file_intents SET plan=? WHERE id=?').run(encode({ ...plan, data: { ...data, before, after, sources } }), row.id)
    }
    for (const row of db.prepare('SELECT * FROM memory_document_restores').all() as unknown as Restore[]) {
      const snapshot = { id: row.document, workspace: row.workspace, path: row.path, revision: row.revision, usageVersion: row.usage,
        markdown: row.markdown, sources: JSON.parse(row.sources) as DocumentSourceRef[], enabled: true, corrections: [] }
      const updated = preserve(snapshot)
      if (updated !== snapshot) db.prepare('UPDATE memory_document_restores SET sources=? WHERE operation=?').run(encode(updated!.sources), row.operation)
    }
  }
  function locatorProjection(markdown: string, fingerprints: ReadonlySet<string>) {
    return fingerprints.size ? maskMemoryWikiLinks(markdown, path => fingerprints.has(memoryFileRevision(path))) : markdown
  }
  function projectErasedLocators(scope: string, markdown: string) { return locatorProjection(markdown, locatorFingerprints(scope)) }
  function locatorFiles(scope: string): LocatorFile[] {
    const digests = db.prepare("SELECT id,workspace,path,revision,'digest' AS kind FROM memory_documents WHERE workspace=? AND forgotten=0").all(scope)
    const notes = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_daily_notes'").get()
      ? db.prepare("SELECT key AS id,workspace,path,file_revision AS revision,'daily' AS kind FROM memory_daily_notes WHERE workspace=? AND file_revision IS NOT NULL").all(scope) : []
    return [...digests, ...notes] as LocatorFile[]
  }
  function currentLocatorFile(data: Extract<Data, { kind: 'locator-cleanup' }>) {
    if (data.target === 'digest') {
      const row = rowById(data.id)
      return Boolean(row && !row.forgotten && row.workspace === data.workspace && row.path === data.path && row.revision === data.revision)
    }
    return Boolean(db.prepare('SELECT 1 FROM memory_daily_notes WHERE key=? AND workspace=? AND path=? AND file_revision=?')
      .get(data.id, data.workspace, data.path, data.revision))
  }
  function cleanLocatorFiles() {
    for (const { workspace: scope } of db.prepare('SELECT DISTINCT workspace FROM memory_document_erased_locators').all() as Array<{ workspace: string }>) {
      const fingerprints = locatorFingerprints(scope)
      for (const { kind: target, ...file } of locatorFiles(scope)) {
        if (!journal.visible(scope, file.path)) continue
        try {
          const current = journal.files(scope).read(file.path)
          if (current?.revision !== file.revision) continue
          const markdown = locatorProjection(current.markdown, fingerprints)
          if (markdown === current.markdown) continue
          const data = { ...file, kind: 'locator-cleanup' as const, target, projected: memoryFileRevision(markdown), fingerprints: [...fingerprints] }
          const key = `locators:${hash(data)}`
          journal.commit(key, hash(data), () => ({ workspace: scope, data, changes: [fileErasure({ path: file.path, before: current.markdown, after: markdown })] }))
        } catch (error) {
          if (!(error instanceof Error && ['memory-file-plan-conflict', 'memory-file-plan-busy', 'memory-file-version'].includes(error.message))) throw error
        }
      }
      transaction(db, () => { if (cleanLocatorMetadata(scope)) locatorCleaned() })
    }
  }
  function cleanLocatorMetadata(scope: string, revisions = new Map<string, string>()) {
    const fingerprints = locatorFingerprints(scope)
    const project = (text: string) => locatorProjection(text, fingerprints)
    function safePath(path: string, id: string) {
      if (!fingerprints.has(memoryFileRevision(path))) return path
      const current = currentIdentityPath(scope, id)
      return current && !fingerprints.has(memoryFileRevision(current)) ? current : erasedPath(id)
    }
    const history = (db.prepare(`SELECT h.* FROM memory_document_revisions h
      JOIN memory_documents d ON d.id=h.document WHERE d.workspace=?`).all(scope) as unknown as Revision[])
      .map(row => ({ row, before: row.before ? JSON.parse(row.before) as DocumentSnapshot : null, after: row.after ? JSON.parse(row.after) as DocumentSnapshot : null }))
    function collectRevision(snapshot: DocumentSnapshot | null) {
      if (!snapshot) return
      const markdown = project(snapshot.markdown)
      if (markdown !== snapshot.markdown) revisions.set(snapshot.revision, memoryFileRevision(markdown))
    }
    for (const { before, after } of history) { collectRevision(before); collectRevision(after) }
    const corrections = (items: DocumentSupersession[]) => items.map(item => ({ ...item,
      path: safePath(item.path, item.sourceDocumentId),
      revision: revisions.get(item.revision) ?? item.revision,
      replacementRevision: revisions.get(item.replacementRevision) ?? item.replacementRevision,
      text: project(item.text), condition: project(item.condition), time: project(item.time),
    }))
    function cleanSnapshot(snapshot: DocumentSnapshot | null) {
      if (!snapshot) return null
      const updated = { ...snapshot, path: safePath(snapshot.path, snapshot.id), markdown: project(snapshot.markdown), revision: revisions.get(snapshot.revision) ?? snapshot.revision,
        corrections: corrections(snapshot.corrections) }
      return encode(updated)
    }
    let changed = revisions.size > 0
    for (const { row, before, after } of history) {
      const previous = cleanSnapshot(before), next = cleanSnapshot(after)
      if (previous === row.before && next === row.after) continue
      db.prepare('UPDATE memory_document_revisions SET before=?,after=? WHERE operation=?').run(previous, next, row.operation)
      changed = true
    }
    for (const row of db.prepare('SELECT id,corrections FROM memory_documents WHERE workspace=?').all(scope) as Array<Pick<Row, 'id' | 'corrections'>>) {
      const updated = encode(corrections(JSON.parse(row.corrections) as DocumentSupersession[]))
      if (updated === row.corrections) continue
      db.prepare('UPDATE memory_documents SET corrections=? WHERE id=?').run(updated, row.id)
      changed = true
    }
    for (const row of db.prepare('SELECT id,snapshot FROM memory_file_use_restrictions WHERE workspace=? AND snapshot IS NOT NULL').all(scope)) {
      const snapshot = String(row.snapshot), updated = project(snapshot)
      if (updated === snapshot) continue
      db.prepare('UPDATE memory_file_use_restrictions SET snapshot=?,content_revision=? WHERE id=?')
        .run(updated, memoryFileRevision(updated), row.id)
      changed = true
    }
    if (changed) db.prepare('INSERT OR IGNORE INTO memory_document_erasures VALUES(?)').run(`locators:${scope}`)
    return changed
  }
  function manualLocatorsCurrent(scope: string, markdown: string, source: MemorySource | null) {
    // YAML can escape characters in the title that the locator parser trims from the original source.
    return projectErasedLocators(scope, markdown) === markdown
      && (!source?.text || projectErasedLocators(scope, source.text) === source.text)
  }
  function locatorCopiesPending(includeCanonical = true) {
    const affected = new Set(db.prepare('SELECT DISTINCT workspace FROM memory_document_erased_locators').all().map(row => String(row.workspace)))
    if (!affected.size) return false
    const contains = (workspace: string, markdown: string) => affected.has(workspace) && projectErasedLocators(workspace, markdown) !== markdown
    const containsCorrection = (workspace: string, corrections: DocumentSupersession[]) =>
      corrections.some(item => locatorRetired(workspace, item.path) || [item.text, item.condition, item.time].some(text => contains(workspace, text)))
    const docs = db.prepare('SELECT workspace,path,corrections FROM memory_documents WHERE forgotten=0').all()
    const notes = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_daily_notes'").get()
      ? db.prepare('SELECT workspace,path FROM memory_daily_notes WHERE file_revision IS NOT NULL').all() : []
    for (const row of [...docs, ...notes]) {
      if (!affected.has(String(row.workspace))) continue
      try {
        const workspace = String(row.workspace), file = journal.files(workspace).read(String(row.path))
        if (typeof row.corrections === 'string' && containsCorrection(workspace, JSON.parse(row.corrections) as DocumentSupersession[])) return true
        if (file && contains(workspace, file.markdown)) return true
      } catch { return true }
    }
    const containsSnapshot = (snapshot: DocumentSnapshot | null) => Boolean(snapshot
      && (locatorRetired(snapshot.workspace, snapshot.path) || contains(snapshot.workspace, snapshot.markdown) || containsCorrection(snapshot.workspace, snapshot.corrections)))
    if ((db.prepare('SELECT before,after FROM memory_document_revisions').all() as unknown as Revision[]).some(row => [row.before, row.after].some(value => {
      if (!value) return false
      return containsSnapshot(JSON.parse(value) as DocumentSnapshot)
    }))) return true
    const plans = db.prepare('SELECT namespace,plan FROM memory_file_intents WHERE plan IS NOT NULL').iterate()
    for (const row of plans) {
      const { workspace, changes, data } = JSON.parse(String(row.plan)) as FilePlan<Data>
      if (changes.some(change => ('before' in change && [change.before, change.after].some(text => text !== null && contains(workspace, text)))
        || ('append' in change && contains(workspace, change.append)))) return true
      if (row.namespace !== 'documents') continue
      if (data.kind === 'locator-cleanup') return true
      if (data.kind === 'revision' && (containsSnapshot(data.before) || containsSnapshot(data.after)
        || data.manualSource?.text && contains(data.workspace, data.manualSource.text))) return true
    }
    const restores = db.prepare('SELECT workspace,markdown FROM memory_document_restores').iterate()
    for (const row of restores) if (contains(String(row.workspace), String(row.markdown))) return true
    for (const row of db.prepare('SELECT workspace,snapshot FROM memory_file_use_restrictions WHERE snapshot IS NOT NULL').iterate()) {
      if (contains(String(row.workspace), String(row.snapshot))) return true
    }
    return includeCanonical && Boolean(manual?.retainsText(contains))
  }
  function removeEvidence(sourceId: string, cut?: DocumentSourceCut): string[] {
    const affected: string[] = []
    const matches = (ref: DocumentSourceRef) => ref.id === sourceId && (!cut || documentSourceRestricted(ref, [cut]))
    const contains = (refs: readonly DocumentSourceRef[]) => refs.some(matches)
    const anchorRefs = (snapshot: DocumentSnapshot | null) => snapshot?.corrections.flatMap(item => item.anchorSources ?? []) ?? []
    const eraseOldQuotation = (item: DocumentSupersession): DocumentSupersession => {
      const erased = item.anchorSources?.filter(matches) ?? []
      if (!erased.length) return item
      return { ...item, ...(cut ? { path: erasedPath(item.sourceDocumentId) } : {}), text: '', condition: '', time: '', anchorSources: item.anchorSources?.filter(ref => !matches(ref)),
        erasedAnchorSources: [...(item.erasedAnchorSources ?? []), ...(cut ? [{ id: cut.id, token: cut.token, spans: cut.spans }] : erased)] }
    }
    const scrub = (snapshot: DocumentSnapshot | null) => snapshot && { ...snapshot, corrections: snapshot.corrections.map(eraseOldQuotation) }
    transaction(db, () => {
      db.prepare('INSERT OR IGNORE INTO memory_document_erasures(source) VALUES(?)').run(sourceId)
      // A prepared plan is itself a plaintext replica. Discard only this journal's affected plans;
      // stage their target for erasure rather than letting invalid recovery restore forgotten text.
      const unpublished = new Map<string, string>()
      const intents = db.prepare("SELECT id,plan FROM memory_file_intents WHERE namespace='documents' AND plan IS NOT NULL").all() as Array<{ id: string, plan: string }>
      for (const intent of intents) {
        const plan = JSON.parse(intent.plan) as FilePlan<Data>
        if (plan.data.kind !== 'revision') continue
        const data = plan.data
        const refs = [...data.sources, ...(data.before?.sources ?? []), ...(data.after?.sources ?? []), ...anchorRefs(data.before), ...anchorRefs(data.after), ...data.reads.flatMap(ref => {
          const row = rowById(ref.id)
          return row ? [...refsOf(row), ...correctionsOf(row).flatMap(item => item.anchorSources ?? [])] : []
        })]
        if (!contains(refs)) continue
        const before = data.before, committed = before ? rowById(before.id) : undefined
        const independent = before && committed && !committed.forgotten && committed.revision === before.revision && committed.usage_version === before.usageVersion && !contains(before.sources) && currentSources(data.workspace, before.sources)
        if (independent && data.after) {
          db.prepare('INSERT OR IGNORE INTO memory_document_restores(operation,document,workspace,path,revision,written,usage,markdown,sources,removed) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(intent.id, before.id, before.workspace, before.path, before.revision, data.after.revision, before.usageVersion, before.markdown, encode(before.sources), encode([sourceId]))
          db.prepare('INSERT OR IGNORE INTO memory_file_reservations(workspace,path,owner) VALUES(?,?,?)').run(before.workspace, before.path, intent.id)
        } else {
          const snapshot = data.after ?? data.before
          if (snapshot && !rowById(snapshot.id)) {
            save(snapshot)
            unpublished.set(snapshot.id, snapshot.revision)
          }
          if (snapshot) {
            const row = rowById(snapshot.id)!
            if (!contains(refsOf(row))) db.prepare('UPDATE memory_documents SET sources=? WHERE id=?').run(encode(refs), row.id)
          }
        }
        db.prepare("UPDATE memory_file_intents SET state='cancelled',plan=NULL WHERE id=?").run(intent.id)
      }
      for (const item of db.prepare('SELECT * FROM memory_document_restores').all() as unknown as Restore[]) {
        if (contains(JSON.parse(item.sources) as DocumentSourceRef[])) {
          db.prepare('DELETE FROM memory_document_restores WHERE operation=?').run(item.operation)
          db.prepare('DELETE FROM memory_file_reservations WHERE owner=?').run(item.operation)
        }
      }
      for (const row of db.prepare('SELECT * FROM memory_documents').all() as unknown as Row[]) {
        const corrections = correctionsOf(row), sanitized = corrections.map(eraseOldQuotation)
        if (corrections.some((item, index) => item !== sanitized[index])) {
          db.prepare('UPDATE memory_documents SET corrections=? WHERE id=?').run(encode(sanitized), row.id)
        }
        if (row.forgotten || !contains(refsOf(row))) continue
        affected.push(row.id)
        if (!cut) useRestrictions.removeTarget({ kind: 'digest', workspace: row.workspace, key: row.id })
        else {
          const record = db.prepare('INSERT OR IGNORE INTO memory_document_erased_locators VALUES (?,?)')
          record.run(row.workspace, memoryFileRevision(row.path))
        }
        db.prepare('UPDATE memory_documents SET forgotten=1,enabled=0,usage_version=usage_version+1,sources=?,corrections=? WHERE id=?').run('[]', encode(sanitized.map(item => ({ ...item, text: '', condition: '', time: '' }))), row.id)
        db.prepare('INSERT OR IGNORE INTO memory_document_purges(document,workspace,path,sources,expected_revision,retire_path) VALUES(?,?,?,?,?,?)')
          .run(row.id, row.workspace, row.path, row.sources, unpublished.get(row.id) ?? null, cut ? 1 : 0)
      }
      if (cut) useRestrictions.eraseSource(cut)
      else useRestrictions.withdrawSource(sourceId)
      for (const rev of db.prepare('SELECT * FROM memory_document_revisions').all() as unknown as Revision[]) {
        const before = rev.before ? JSON.parse(rev.before) as DocumentSnapshot : null
        const after = rev.after ? JSON.parse(rev.after) as DocumentSnapshot : null
        if (contains(before?.sources ?? []) || contains(after?.sources ?? [])) {
          db.prepare('UPDATE memory_document_revisions SET before=NULL,after=NULL WHERE operation=?').run(rev.operation)
        } else if (contains([...anchorRefs(before), ...anchorRefs(after)])) {
          db.prepare('UPDATE memory_document_revisions SET before=?,after=? WHERE operation=?')
            .run(before ? encode(scrub(before)) : null, after ? encode(scrub(after)) : null, rev.operation)
        }
      }
    })
    return affected
  }
  function acceptedSnapshot(scope: string, id: string): DocumentSnapshot | null {
    workspace(scope)
    const row=rowById(id)
    if (!row || row.workspace!==scope || row.forgotten || !row.enabled || !currentSources(scope,refsOf(row)) || restricted(scope,refsOf(row),id) || !journal.visible(scope,row.path)) return null
    const history = db.prepare('SELECT after FROM memory_document_revisions WHERE document=? AND after IS NOT NULL ORDER BY rowid DESC')
    for (const revision of history.iterate(id)) {
      const snapshot = JSON.parse(String(revision.after)) as DocumentSnapshot
      if (snapshot.revision === row.revision && snapshot.usageVersion === row.usage_version && memoryFileRevision(snapshot.markdown) === row.revision) {
        return { ...snapshot, path: row.path, enabled: Boolean(row.enabled), sources: refsOf(row), corrections: correctionsOf(row) }
      }
    }
    return null
  }
  function currentIdentityPath(scope: string, id: string): string | undefined {
    const document = rowById(id)
    if (document?.workspace === scope) return document.path
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_daily_notes'").get()) {
      const note = db.prepare('SELECT path FROM memory_daily_notes WHERE key=? AND workspace=?').get(id,scope)
      if (note) return String(note.path)
    }
    return undefined
  }
  function supersessions(scope: string, path: string, { includeEvidence = false, physical }: { includeEvidence?: boolean, physical?: MemoryPhysicalFile | null } = {}): DocumentSupersession[] {
    workspace(scope)
    // Keep tombstones when the correction disappears: losing the replacement never revives old facts.
    return (db.prepare('SELECT * FROM memory_documents WHERE workspace=?').all(scope) as unknown as Row[])
      .flatMap(correctionsOf).flatMap(({ anchorSources, erasedAnchorSources, ...item }) => {
        const actualPath = currentIdentityPath(scope, item.sourceDocumentId) ?? item.path
        if (actualPath !== path) return []
        if (erasedAnchorSources?.length) {
          const anchor = correctionAnchor(scope, actualPath, physical)
          if (anchor?.id === item.sourceDocumentId && currentSources(scope, anchor.sources)
            && anchor.sources.every(ref => !documentSourceRestricted(ref, erasedAnchorSources))) return []
        }
        return [{ ...item, ...(includeEvidence && anchorSources?.length ? { anchorSources } : {}), path: actualPath, text: projectErasedLocators(scope, item.text),
          condition: projectErasedLocators(scope, item.condition), time: projectErasedLocators(scope, item.time) }]
      })
  }
  function readReceipt(scope: string, operation: string): DocumentReceipt | null {
    workspace(scope)
    const row = db.prepare('SELECT receipt FROM memory_document_receipts WHERE operation=?').get(operation) as { receipt: string } | undefined
    if (!row) return null
    const value = JSON.parse(row.receipt) as DocumentReceipt
    return rowById(value.documentId)?.workspace === scope ? value : null
  }
  function hasPendingCleanup(sourceId: string): boolean {
    return Boolean(db.prepare("SELECT 1 FROM memory_document_erasures WHERE source IN (?,?) OR source LIKE 'locators:%'").get(sourceId, `file:${sourceId}`)
      || db.prepare("SELECT 1 FROM memory_document_purges WHERE document=? AND sources='[]'").get(sourceId))
      || locatorCopiesPending(false) || (db.prepare('SELECT removed FROM memory_document_restores').all() as Array<{removed:string}>).some(row => (JSON.parse(row.removed) as string[]).includes(sourceId)) || (db.prepare('SELECT sources FROM memory_document_purges').all() as Array<{sources: string}>).some(row => (JSON.parse(row.sources) as DocumentSourceRef[]).some(ref => ref.id === sourceId))
  }
  function deleteFile(scope: string, id: string, expectedUsageVersion: number) {
    return transaction(db, () => {
      const row = rowById(id)
      if (!row || row.workspace !== scope || row.usage_version !== expectedUsageVersion || !journal.visible(scope, row.path)) throw new Error('memory-document-version')
      if (!row.forgotten) {
        // A local deletion owns only this revision. Sibling documents may share all its evidence.
        db.prepare("INSERT INTO memory_document_purges(document,workspace,path,sources,expected_revision) VALUES(?,?,?,'[]',?)")
          .run(id, scope, row.path, row.revision)
      }
      // Other files still need to know their old assertions were superseded.
      const supersessions = correctionsOf(row).filter(item => item.sourceDocumentId !== id)
        .map(item => ({ ...item, text: '', condition: '', time: '' }))
      db.prepare("UPDATE memory_documents SET forgotten=1,enabled=0,usage_version=usage_version+1,sources='[]',corrections=? WHERE id=?")
        .run(encode(supersessions), id)
      db.prepare('UPDATE memory_document_revisions SET before=NULL,after=NULL WHERE document=?').run(id)
      db.prepare('INSERT OR IGNORE INTO memory_document_erasures VALUES(?)').run(`file:${id}`)
      useRestrictions.removeTarget({ kind: 'digest', workspace: scope, key: id })
      return row.usage_version + 1
    })
  }
  function sourceRestrictions(scope: string, except?: string): DocumentSourceRef[] {
    workspace(scope)
    const refs = [...erasures(scope), ...useRestrictions.sources(scope, except ? { kind: 'digest', workspace: scope, key: except } : undefined)]
    return [...refs, ...expandRestrictions(refs)]
  }
  const pendingCleanup = () => Number((db.prepare('SELECT (SELECT COUNT(*) FROM memory_document_purges)+(SELECT COUNT(*) FROM memory_document_restores)+(SELECT COUNT(*) FROM memory_document_erasures) count').get() as { count: number }).count) + Number(locatorCopiesPending())
  function needsRecovery() {
    return journal.needsRecovery(data => !managed(data) && !(data.kind === 'purge' && data.fileOnly)) || restores().some(item => restorableFile(item))
      || purges().some(item => {
        if (item.sources === '[]' || journal.state(`purge:${item.document}`)) return false
        const file = journal.files(item.workspace).read(item.path)
        return purgeable(item, file?.revision) && (!file || journal.visible(item.workspace, item.path))
      })
      || locatorCopiesPending()
  }
  if (!deferRecovery) recover()
  return {
    acceptedSnapshot,
    registered: scope => (db.prepare('SELECT * FROM memory_documents WHERE workspace=? ORDER BY id').all(scope) as Row[])
      .map(row => ({ id: row.id, workspace: row.workspace, path: row.path, revision: row.revision,
        usageVersion: row.usage_version, sources: refsOf(row), state: row.forgotten ? 'forgotten' : row.enabled ? 'active' : 'disabled' })),
    fileRegistry: scope => (db.prepare(`SELECT d.id,d.workspace,d.path,d.revision,d.usage_version,d.enabled,d.forgotten
      FROM memory_documents d WHERE d.workspace=? AND (d.forgotten=0 OR EXISTS (
        SELECT 1 FROM memory_file_use_restrictions r WHERE r.workspace=d.workspace AND r.kind='digest' AND r.target=d.id
      ))`).all(scope) as Array<Pick<Row, 'id' | 'workspace' | 'path' | 'revision' | 'usage_version' | 'enabled' | 'forgotten'>>)
      .map(row => ({ id: row.id, workspace: row.workspace, path: row.path, revision: row.revision,
        usageVersion: row.usage_version, state: row.forgotten ? 'forgotten' : row.enabled ? 'active' : 'disabled' })),
    workspaces: () => db.prepare('SELECT DISTINCT workspace FROM memory_documents').all().map(row => String(row.workspace)),
    indexFile(scope, id) {
      const row = rowById(id)
      return row?.workspace === scope ? { path: row.path, revision: row.revision,
        state: row.forgotten ? 'forgotten' : row.enabled ? 'active' : 'disabled' } : null
    },
    indexDependencies: scope => (db.prepare("SELECT corrections FROM memory_documents WHERE workspace=? AND corrections<>'[]'").all(scope) as Pick<Row, 'corrections'>[])
      .flatMap(row => (JSON.parse(row.corrections) as DocumentSupersession[]).map(item => ({
        replacementId: item.documentId, anchorId: indexAnchorId(item.sourceDocumentId), anchorSourceIds: [...item.anchorSources ?? [], ...item.erasedAnchorSources ?? []].map(ref => ref.id),
      }))),
    needsRecovery, recover, checkpointCleanup,
    recoverDeletedFiles: () => applyPurges(purges().filter(row => row.sources === '[]')),
    deletedFileCleanupPending: (scope: string, id: string) => Boolean(rowById(id)?.workspace === scope
      && (db.prepare("SELECT 1 FROM memory_document_purges WHERE document=? AND sources='[]'").get(id)
        || db.prepare('SELECT 1 FROM memory_document_erasures WHERE source=?').get(`file:${id}`))),
    recoverManagement(operationId) {
      journal.recover(operationId, managed)
      return journal.state(operationId) === 'cancelled' ? 'cancelled' : undefined
    },
    sourceRestrictions, receipt: readReceipt, hasPendingCleanup, pendingCleanup, projectErasedLocators, locatorRetired, preserveAuthoredLocatorSources,
    read, list, commit, deleteFile, writeManual, undoCandidate, undo, setEnabled, withdraw: sourceId => removeEvidence(sourceId), eraseSource: cut => removeEvidence(cut.id, cut), supersessions,
  }
}
