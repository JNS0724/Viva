import type { MemoryFileIndexChanges } from '../core/ports/runtime.ts'
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MemoryDocuments, DocumentSnapshot, DocumentCommit, DocumentReceipt, DocumentRevisionEntry, DocumentSourceRef, DocumentReadRef, DocumentUndoCandidate, DocumentManagementGuard, DocumentManualWrite, MemoryPhysicalFile } from '../core/ports/documents.ts'
import { MEMORY_CONTRACT } from '../contracts/memory-contract.ts'
import { digestPath } from '../contracts/memory-file-contract.ts'
import { parseMemoryDocument } from '../core/memory-document.ts'
import type { MemorySource } from '../contracts/records.ts'
import { memoryFileRevision } from './memory-file-store.ts'
import { fileErasure, openMemoryFileJournal } from './memory-file-journal.ts'
import type { FileCheckpoint } from './memory-file-journal.ts'
import { documentSourceProofCurrent } from '../core/memory-source-proof.ts'
import { isReservedProfilePath, RESIDENT_PROFILE_PATH, userWorkspaceId } from '../core/resident-profile.ts'
import { MemoryDomainError } from '../core/presentation.ts'
import { transaction, truncateMemoryJournal } from './sqlite.ts'

type Row = { id: string, workspace: string, path: string, revision: string, usage_version: number, enabled: number, forgotten: number, sources: string }
type Revision = { operation: string, document: string, before: string | null, after: string | null }
type Mutation = { kind: 'revision', input: string, receipt: DocumentReceipt, before: DocumentSnapshot | null, after: DocumentSnapshot | null, sources: DocumentSourceRef[], reads: DocumentReadRef[], files: Array<{ path: string, revision: string }>, workspace: string, management?: DocumentManagementGuard, manualSource?: MemorySource }
type Purge = { kind: 'purge', document: string, workspace: string, path: string, expected_revision: string | null }
type Data = Mutation | Purge
const encode = (value: unknown) => JSON.stringify(value)
const hash = (value: unknown) => memoryFileRevision(encode(value))
const refsOf = (row: Row): DocumentSourceRef[] => JSON.parse(row.sources) as DocumentSourceRef[]
const readVersions = (reads: readonly DocumentReadRef[]): DocumentReadRef[] =>
  reads.map(({ id, revision, usageVersion }) => ({ id, revision, usageVersion }))

/** Persistence adapter: current Markdown is authoritative; SQL stores identities, revisions and recovery metadata. */
export function openMemoryDocuments({ db, root, source, now = Date.now, checkpoint, onCommitted = () => {}, managementCurrent = () => false, manual, index, deferRecovery = false }: {
  db: DatabaseSync, root: string,
  source: (id: string) => { token: string, workspace: string, text: string } | undefined,
  now?: () => number,
  onCommitted?: (receipt: DocumentReceipt) => void,
  managementCurrent?: (before: DocumentSnapshot, guard: DocumentManagementGuard, after: DocumentSnapshot, staged?: MemorySource) => boolean,
  manual?: { token(source: MemorySource): string, workspace(source: MemorySource): string,
    current(source: MemorySource, beforeMarkdown?: string): boolean, commit(source: MemorySource, parents: readonly DocumentSourceRef[]): void, },
  index?: MemoryFileIndexChanges,
  deferRecovery?: boolean,
  checkpoint?: (point: FileCheckpoint, path?: string) => void,
}): MemoryDocuments {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const existingColumns = (db.prepare('PRAGMA table_info(memory_documents)').all() as Array<{ name: string }>).map(column => column.name)
  const expectedColumns = ['id', 'workspace', 'path', 'revision', 'usage_version', 'enabled', 'forgotten', 'sources']
  if ((version !== 0 && version !== MEMORY_CONTRACT)
    || (existingColumns.length > 0 && !isDeepStrictEqual(existingColumns, expectedColumns))) {
    throw Object.assign(new Error('memory.db has an incompatible contract version'), { code: 'unknown_version' })
  }
  db.exec(`PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS memory_documents (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL,
      usage_version INTEGER NOT NULL, enabled INTEGER NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0,
      sources TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_documents_active_path ON memory_documents(workspace,path) WHERE forgotten=0;
    CREATE TABLE IF NOT EXISTS memory_document_revisions (
      operation TEXT PRIMARY KEY, document TEXT NOT NULL, before TEXT, after TEXT, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_document_revision_by_document ON memory_document_revisions(document);
    CREATE TABLE IF NOT EXISTS memory_document_receipts (
      operation TEXT PRIMARY KEY, input TEXT NOT NULL, receipt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_document_erasures (source TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS memory_document_purges (
      document TEXT PRIMARY KEY, workspace TEXT NOT NULL, path TEXT NOT NULL, expected_revision TEXT NOT NULL
    );
  `)
  function workspace(value: string) {
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('invalid-memory-workspace')
  }
  function rowById(id: string): Row | undefined {
    return db.prepare('SELECT * FROM memory_documents WHERE id=?').get(id) as Row | undefined
  }
  function rowByPath(scope: string, path: string): Row | undefined {
    return db.prepare('SELECT * FROM memory_documents WHERE workspace=? AND path=? AND forgotten=0').get(scope, path) as Row | undefined
  }
  function currentSources(scope: string, refs: readonly DocumentSourceRef[], staged?: MemorySource) {
    return refs.length > 0 && new Set(refs.map(ref => ref.id)).size === refs.length && refs.every(ref => {
      const actual = staged && staged.id === ref.id && manual && staged.text
        ? { token: manual.token(staged), workspace: manual.workspace(staged), text: staged.text }
        : source(ref.id)
      return actual?.workspace === scope && documentSourceProofCurrent(ref, actual.text, actual.token)
    })
  }
  function currentReads(scope: string, refs: readonly DocumentReadRef[], changing?: Mutation): boolean {
    return refs.every(ref => {
      const row = rowById(ref.id)
      if (!row || row.workspace !== scope || row.forgotten || !row.enabled || row.revision !== ref.revision || row.usage_version !== ref.usageVersion || !currentSources(scope, refsOf(row))) return false
      if (changing?.after?.id !== row.id && !journal.visible(scope, row.path)) return false
      const file = journal.files(scope).read(row.path)
      return file?.revision === row.revision || (changing?.after?.id === row.id && file?.revision === changing.after.revision)
    })
  }
  function save(snapshot: DocumentSnapshot) {
    db.prepare(`INSERT INTO memory_documents(id,workspace,path,revision,usage_version,enabled,forgotten,sources)
      VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,revision=excluded.revision,
      usage_version=excluded.usage_version,enabled=excluded.enabled,sources=excluded.sources`)
      .run(snapshot.id, snapshot.workspace, snapshot.path, snapshot.revision, snapshot.usageVersion, snapshot.enabled ? 1 : 0, encode(snapshot.sources))
  }
  const managed = (data: Data) => data.kind === 'revision' && (data.management !== undefined || data.manualSource !== undefined)
  const journal = openMemoryFileJournal<Data>({ db, root, namespace: 'documents', checkpoint,
    afterCommit(data, workspace) {
      if (data.kind === 'revision') index?.publish(workspace, data.receipt.documentId)
    },
    cancelOnConflict: managed,
    valid(data): boolean {
      if (data.kind === 'purge') return Boolean(rowById(data.document)?.forgotten)
      const actual = rowByPath(data.workspace, data.receipt.path)
      const before = data.before
      const targetCurrent = before ? actual?.id === before.id && actual.revision === before.revision && actual.usage_version === before.usageVersion && !actual.forgotten
        : !actual
      if (data.manualSource && (!data.after || !manual?.current(data.manualSource, before?.markdown))) return false
      if (data.management) {
        if (!targetCurrent || !before || !data.after || !actual) return false
        const physical = journal.files(data.workspace).read(before.path)?.revision
        if (physical !== before.revision && physical !== data.after.revision) return false
        if (memoryFileRevision(before.markdown) !== before.revision || Boolean(actual.enabled) !== before.enabled
          || !isDeepStrictEqual(refsOf(actual), before.sources)) return false
        if (data.management.changeId !== undefined && undoHistory(before)?.history.operation !== data.management.changeId) return false
        if (!managementCurrent(before, data.management, data.after, data.manualSource)) return false
      }
      return targetCurrent && currentSources(data.workspace, data.sources, data.manualSource) && currentReads(data.workspace, data.reads, data) && data.files.every(file => {
        const actual = journal.files(data.workspace).read(file.path)?.revision
        return (data.after?.path === file.path || journal.visible(data.workspace, file.path)) && (actual === file.revision || data.after?.path === file.path && actual === data.after.revision)
      })
    },
    finish(data) {
      if (data.kind === 'purge') {
        db.prepare('DELETE FROM memory_document_purges WHERE document=?').run(data.document)
        return
      }
      if (data.manualSource) manual!.commit(data.manualSource, data.before?.sources ?? [])
      const unchanged = isDeepStrictEqual(data.before, data.after)
      if (!unchanged && data.after) save(data.after)
      else if (!unchanged && data.before) db.prepare('UPDATE memory_documents SET forgotten=1,enabled=0,usage_version=usage_version+1,sources=? WHERE id=?').run('[]', data.before.id)
      if (!unchanged) db.prepare('INSERT INTO memory_document_revisions(operation,document,before,after,at) VALUES(?,?,?,?,?)')
        .run(data.receipt.operationId, data.receipt.documentId, data.before ? encode(data.before) : null, data.after ? encode(data.after) : null, now())
      db.prepare('INSERT INTO memory_document_receipts(operation,input,receipt) VALUES(?,?,?)').run(data.receipt.operationId, data.input, encode(data.receipt))
      if (!unchanged) {
        index?.queue({ workspace: data.workspace, id: data.receipt.documentId,
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
    if (!row || row.forgotten || (!row.enabled && !options.includeDisabled) || !currentSources(scope, refsOf(row)) || !journal.visible(scope, path)) return null
    const file = options.physical === undefined ? journal.files(scope).read(path) : options.physical
    // An external edit has no verified provenance. It is quarantined, never silently reinterpreted.
    if (!file || file.path !== path || file.revision !== row.revision) return null
    return { id: row.id, workspace: scope, path, revision: row.revision, usageVersion: row.usage_version, markdown: file.markdown, sources: refsOf(row), enabled: Boolean(row.enabled) }
  }
  const userWorkspace = userWorkspaceId(memoryFileRevision)
  function checkReservedProfilePath(scope: string, filePath: string) {
    if (!isReservedProfilePath(filePath)) return
    if (scope !== userWorkspace || filePath !== RESIDENT_PROFILE_PATH) {
      throw new Error('memory-reserved-profile-path')
    }
  }
  function list(scope: string, options?: { includeDisabled?: boolean }): DocumentSnapshot[] {
    workspace(scope)
    return (db.prepare('SELECT path FROM memory_documents WHERE workspace=? AND forgotten=0 ORDER BY path').all(scope) as Array<{ path: string }>)
      .flatMap(row => read(scope, row.path, options) ?? [])
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
    checkReservedProfilePath(input.workspace, input.path)
    parseMemoryDocument(input.markdown)
    const before = read(input.workspace, input.path)
    if (rowByPath(input.workspace, input.path) && !before) throw new Error('memory-document-unavailable')
    if ((before?.revision ?? null) !== input.expectedRevision) throw new Error('memory-document-version')
    if ((input.action === 'CREATE') !== !before) throw new Error('memory-document-action')
    if (input.action === 'CREATE') {
      const pendingPathPurges = purges().filter(p => p.workspace === input.workspace && p.path === input.path)
      if (pendingPathPurges.length) applyPurges(pendingPathPurges)
    }
    if (before && before.sources.some(ref => !input.sources.some(next => next.id === ref.id && next.token === ref.token && (!next.spans || ref.spans && ref.spans.every(part => next.spans!.some(span => span.start <= part.start && span.end >= part.end)))))) throw new Error('memory-document-source-loss')
    if (!currentSources(input.workspace, input.sources) || !currentReads(input.workspace, input.reads)) throw new Error('memory-document-source-version')
    const id = before?.id ?? randomUUID(), revision = memoryFileRevision(input.markdown), usageVersion = (before?.usageVersion ?? 0) + 1
    const after: DocumentSnapshot = { id, workspace: input.workspace, path: input.path, revision, usageVersion, markdown: input.markdown, sources: input.sources, enabled: true }
    const receipt: DocumentReceipt = { operationId: input.operationId, documentId: id, path: input.path, revision, usageVersion, action: input.action }
    return apply(input, before, after, receipt, input.sources, input.reads, [...new Map((input.files ?? []).map(item => [item.path, item])).values()])
  }
  function writeManual(input: DocumentManualWrite): DocumentReceipt {
    workspace(input.workspace)
    const prior = replay(input.operationId, input)
    if (prior) return prior
    if (!manual) throw new MemoryDomainError('not.found')
    digestPath.parse(input.path)
    checkReservedProfilePath(input.workspace, input.path)
    parseMemoryDocument(input.markdown)
    const before = read(input.workspace, input.path)
    const expected = input.expected
    if (expected ? !before || before.id !== expected.id || before.revision !== expected.revision || before.usageVersion !== expected.usageVersion
      : rowByPath(input.workspace, input.path)) throw new MemoryDomainError('revision.conflict')
    const displayed = before?.markdown
    const unchanged = displayed === input.markdown
    if (Boolean(input.source) === unchanged) throw new MemoryDomainError('invalid.text')
    const sources = [...before?.sources ?? [], ...(input.source ? [{ id: input.source.id, token: manual.token(input.source) }] : [])]
    const after: DocumentSnapshot = unchanged ? before! : {
      id: before?.id ?? randomUUID(), workspace: input.workspace, path: input.path, revision: memoryFileRevision(input.markdown),
      usageVersion: (before?.usageVersion ?? 0) + 1, markdown: input.markdown, enabled: true, sources,
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
      if (operation.action !== 'REFINE' || !currentSources(current.workspace, original.sources)) return null
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
    if (!row || row.workspace !== input.workspace || row.forgotten) throw new Error('memory-document-unavailable')
    const current = read(input.workspace, row.path, { includeDisabled: true })
    if (!current || current.id !== input.documentId || current.revision !== input.revision || current.usageVersion !== input.usageVersion) throw new Error('memory-document-version')
    const candidate = undoHistory(current)
    if (!candidate) throw new Error('memory-document-undo-unavailable')
    if (input.expectedChangeId !== undefined && input.expectedChangeId !== candidate.history.operation) throw new Error('memory-document-change-version')
    const { original } = candidate
    const markdown = original.markdown
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
    if (!row || row.workspace !== input.workspace || row.forgotten) throw new Error('memory-document-unavailable')
    const current = read(input.workspace, row.path, { includeDisabled: true })
    if (!current || current.id !== input.documentId || current.revision !== input.expectedRevision || current.usageVersion !== input.expectedUsageVersion) throw new Error('memory-document-version')
    const after = { ...current, enabled: input.enabled, usageVersion: current.usageVersion + Number(current.enabled !== input.enabled) }
    const receipt: DocumentReceipt = { operationId: input.operationId, documentId: row.id, path: row.path, revision: after.revision, usageVersion: after.usageVersion, action: input.enabled ? 'ENABLE' : 'DISABLE' }
    const management = input.expectedPolicyToken === undefined ? undefined : { policyToken: input.expectedPolicyToken }
    return apply(input, current, after, receipt, current.sources, [], [], management)
  }
  const purges = () => db.prepare('SELECT document,workspace,path,expected_revision FROM memory_document_purges').all() as Array<Omit<Purge, 'kind'>>
  const purgeable = (purge: Omit<Purge, 'kind'>, revision?: string) => !revision || revision === purge.expected_revision
  function recover() {
    journal.recover(undefined, data => !managed(data))
    applyPurges(purges())
    checkpointCleanup()
  }
  function applyPurges(rows: ReturnType<typeof purges>) {
    for (const purge of rows) {
      try {
        const active = rowByPath(purge.workspace, purge.path)
        if (active && active.id !== purge.document) {
          // A newer active document now owns this path; retire the old tombstone's purge entry without touching disk.
          journal.commit(`purge:${purge.document}`, hash(purge), () => ({ workspace: purge.workspace, changes: [], data: { ...purge, kind: 'purge' } }))
          continue
        }
        const before = journal.files(purge.workspace).read(purge.path)
        // A prepared CREATE has no accepted ownership of unrelated on-disk bytes.
        // Keep cleanup pending if its physical state cannot be verified.
        if (!purgeable(purge, before?.revision)) continue
        journal.commit(`purge:${purge.document}`, hash(purge), () => ({ workspace: purge.workspace, changes: before ? [fileErasure({ path: purge.path, before: before.markdown, after: null })] : [], data: { ...purge, kind: 'purge' } }))
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
  function acceptedSnapshot(scope: string, id: string): DocumentSnapshot | null {
    workspace(scope)
    const row=rowById(id)
    if (!row || row.workspace!==scope || row.forgotten || !row.enabled || !currentSources(scope,refsOf(row)) || !journal.visible(scope,row.path)) return null
    const history = db.prepare('SELECT after FROM memory_document_revisions WHERE document=? AND after IS NOT NULL ORDER BY rowid DESC')
    for (const revision of history.iterate(id)) {
      const snapshot = JSON.parse(String(revision.after)) as DocumentSnapshot
      if (snapshot.revision === row.revision && snapshot.usageVersion === row.usage_version && memoryFileRevision(snapshot.markdown) === row.revision) {
        return { ...snapshot, path: row.path, enabled: Boolean(row.enabled), sources: refsOf(row) }
      }
    }
    return null
  }
  function revisionHistory(scope: string, id: string, limit = 20): DocumentRevisionEntry[] {
    workspace(scope)
    const row = rowById(id)
    if (!row || row.workspace !== scope || row.forgotten || !row.enabled || !journal.visible(scope, row.path)) return []
    const capped = Math.max(1, Math.min(limit, 50))
    const rows = db.prepare('SELECT operation, before, after, at FROM memory_document_revisions WHERE document=? ORDER BY rowid DESC LIMIT ?')
      .all(id, capped) as Array<{ operation: string, before: string | null, after: string | null, at: number }>
    const entries: DocumentRevisionEntry[] = []
    let expectedRevision = row.revision
    let expectedUsageVersion = row.usage_version
    for (const item of rows) {
      if (!item.before || !item.after) break
      const receipt = readReceipt(scope, item.operation)
      if (!receipt || receipt.action === 'UNDO' || receipt.action === 'FORGET') break
      const before = JSON.parse(item.before) as DocumentSnapshot
      const after = JSON.parse(item.after) as DocumentSnapshot
      if (before.workspace !== scope || after.workspace !== scope) break
      if (after.revision !== expectedRevision || after.usageVersion !== expectedUsageVersion) break
      expectedRevision = before.revision
      expectedUsageVersion = before.usageVersion
      if (receipt.action === 'ENABLE' || receipt.action === 'DISABLE') continue
      entries.push({ operationId: item.operation, at: item.at, before, after })
    }
    return entries
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
  function readReceipt(scope: string, operation: string): DocumentReceipt | null {
    workspace(scope)
    const row = db.prepare('SELECT receipt FROM memory_document_receipts WHERE operation=?').get(operation) as { receipt: string } | undefined
    if (!row) return null
    const value = JSON.parse(row.receipt) as DocumentReceipt
    return rowById(value.documentId)?.workspace === scope ? value : null
  }
  const hasPendingCleanup = (id: string) => Boolean(db.prepare('SELECT 1 FROM memory_document_erasures WHERE source=?').get(`file:${id}`)
    || db.prepare('SELECT 1 FROM memory_document_purges WHERE document=?').get(id))
  function deleteFile(scope: string, id: string, expectedUsageVersion: number) {
    return transaction(db, () => {
      const row = rowById(id)
      if (!row || row.workspace !== scope || row.usage_version !== expectedUsageVersion || !journal.visible(scope, row.path)) throw new Error('memory-document-version')
      if (!row.forgotten) {
        // A local deletion owns only this revision. Sibling documents may share all its evidence.
        db.prepare("INSERT INTO memory_document_purges(document,workspace,path,expected_revision) VALUES(?,?,?,?)")
          .run(id, scope, row.path, row.revision)
      }
      db.prepare("UPDATE memory_documents SET forgotten=1,enabled=0,usage_version=usage_version+1,sources='[]' WHERE id=?")
        .run(id)
      db.prepare('UPDATE memory_document_revisions SET before=NULL,after=NULL WHERE document=?').run(id)
      db.prepare('INSERT OR IGNORE INTO memory_document_erasures VALUES(?)').run(`file:${id}`)
      return row.usage_version + 1
    })
  }
  const pendingCleanup = () => Number(db.prepare('SELECT (SELECT COUNT(*) FROM memory_document_purges)+(SELECT COUNT(*) FROM memory_document_erasures) AS count').get()?.count ?? 0)
  const needsRecovery = () => journal.needsRecovery(data => !managed(data) && data.kind !== 'purge')

  if (!deferRecovery) recover()
  return {
    acceptedSnapshot, revisionHistory,
    registered: scope => (db.prepare('SELECT * FROM memory_documents WHERE workspace=? ORDER BY id').all(scope) as Row[])
      .map(row => ({ id: row.id, workspace: row.workspace, path: row.path, revision: row.revision,
        usageVersion: row.usage_version, sources: refsOf(row), state: row.forgotten ? 'forgotten' : row.enabled ? 'active' : 'disabled' })),
    fileRegistry: scope => (db.prepare(`SELECT d.id,d.workspace,d.path,d.revision,d.usage_version,d.enabled,d.forgotten
      FROM memory_documents d WHERE d.workspace=? AND d.forgotten=0`).all(scope) as Array<Pick<Row, 'id' | 'workspace' | 'path' | 'revision' | 'usage_version' | 'enabled' | 'forgotten'>>)
      .map(row => ({ id: row.id, workspace: row.workspace, path: row.path, revision: row.revision,
        usageVersion: row.usage_version, state: row.forgotten ? 'forgotten' : row.enabled ? 'active' : 'disabled' })),
    fileRegistration(scope, path) {
      const row = db.prepare(`SELECT id,workspace,path,revision,usage_version,enabled,forgotten
        FROM memory_documents WHERE workspace=? AND path=? AND forgotten=0`).get(scope, path) as Pick<Row, 'id' | 'workspace' | 'path' | 'revision' | 'usage_version' | 'enabled' | 'forgotten'> | undefined
      return row
        ? { id: row.id, workspace: row.workspace, path: row.path, revision: row.revision,
            usageVersion: row.usage_version, state: row.enabled ? 'active' : 'disabled' }
        : null
    },
    workspaces: () => db.prepare('SELECT DISTINCT workspace FROM memory_documents').all().map(row => String(row.workspace)),
    indexFile(scope, id) {
      const row = rowById(id)
      return row?.workspace === scope ? { path: row.path, revision: row.revision,
        state: row.forgotten ? 'forgotten' : row.enabled ? 'active' : 'disabled' } : null
    },
    needsRecovery, recover, checkpointCleanup,
    recoverDeletedFiles: () => { applyPurges(purges()); checkpointCleanup() },
    deletedFileCleanupPending: (scope: string, id: string) => rowById(id)?.workspace === scope && hasPendingCleanup(id),
    recoverManagement(operationId) {
      journal.recover(operationId, managed)
      return journal.state(operationId) === 'cancelled' ? 'cancelled' : undefined
    },
    receipt: readReceipt, hasPendingCleanup, pendingCleanup,
    read, list, commit, deleteFile, writeManual, undoCandidate, undo, setEnabled,
  }
}
