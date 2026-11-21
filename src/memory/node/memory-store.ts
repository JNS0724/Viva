import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { APP_DB_PRAGMAS, transaction } from './sqlite.ts'
import { MEMORY_CONTRACT, memoryScope } from '../contracts/memory-contract.ts'
import { memoryFileDependencySchema, memoryProvenanceSchema } from '../contracts/provenance.ts'
import { memorySourceToken, memorySourceWorkspace } from './source-identity.ts'
import { documentSourceRestricted, planDocumentSourceErasure, subtractDocumentSourceSpans } from '../core/memory-document-restrictions.ts'
import type { DocumentSourceRef, DocumentSourceCut } from '../core/ports/documents.ts'
import type { MemorySourceErasure, MemorySource, MemoryProvenance, MemoryFileDependency } from '../contracts/records.ts'
import { memoryScopeKey } from '../core/scope.ts'
export { memoryScopeKey } from '../core/scope.ts'
export type { MemorySource, MemoryProvenance, MemoryFileDependency } from '../contracts/records.ts'

type SourceRow = Omit<MemorySource, 'scope' | 'context' | 'project' | 'withdrawn' | 'requestId' | 'questionId' | 'erasure'> & {
  scope: string, context: string | null, project: string | null, withdrawn: number, request_id: string | null, question_id: string | null
}
export const memoryHash = (text: string) => createHash('sha256').update(text).digest('hex')

const SCHEMA = `
  CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE memory_sources (
    id TEXT PRIMARY KEY, operation TEXT NOT NULL, version INTEGER NOT NULL,
    conversation TEXT, session TEXT, scope TEXT NOT NULL, context TEXT, project TEXT, author TEXT NOT NULL,
    text TEXT, hash TEXT, length INTEGER NOT NULL, question TEXT, request_id TEXT, question_id TEXT, at INTEGER NOT NULL, timezone TEXT NOT NULL,
    outcome TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0, UNIQUE(operation, version)
  );
  CREATE INDEX memory_sources_conversation ON memory_sources(conversation);
  CREATE TABLE memory_source_range_erasures (
    source TEXT PRIMARY KEY REFERENCES memory_sources(id), workspace TEXT NOT NULL, token TEXT NOT NULL, spans TEXT NOT NULL
  );
  CREATE INDEX memory_source_range_erasures_workspace ON memory_source_range_erasures(workspace);
  CREATE TABLE memory_manual_file_lineage (
    source TEXT NOT NULL, parent TEXT NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(source,parent)
  );
  CREATE INDEX memory_manual_file_lineage_parent ON memory_manual_file_lineage(parent);
  CREATE TABLE memory_excluded_sources (id TEXT PRIMARY KEY);
  CREATE TABLE memory_sessions (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
  CREATE TABLE memory_commands (key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, result INTEGER);
  CREATE TABLE profile (field TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL);
  CREATE TABLE memory_delivered_sources (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, derived INTEGER NOT NULL);
  CREATE INDEX memory_delivered_sources_conversation ON memory_delivered_sources(conversation);
  CREATE TABLE memory_session_sources (session TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(session,source));
  CREATE TABLE memory_session_turn_only (session TEXT PRIMARY KEY);
  CREATE TABLE memory_session_file_dependencies (session TEXT NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(session,reference));
  CREATE TABLE memory_session_file_sources (session TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(session,source));
  CREATE TABLE memory_session_projects (session TEXT PRIMARY KEY, project TEXT NOT NULL);
`

export function openMemoryStore(file: string, now = Date.now) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== MEMORY_CONTRACT && (version !== 0 || db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get())) {
      throw new Error('memory.db has an incompatible contract version')
    }
    db.exec(APP_DB_PRAGMAS)
    if (version === 0) transaction(db, () => {
      db.exec(SCHEMA)
      db.exec(`PRAGMA user_version = ${MEMORY_CONTRACT}`)
      db.prepare('INSERT INTO memory_meta (key,value) VALUES (?,?)').run('secret', randomBytes(32).toString('hex'))
    })
  } catch (error) { db.close(); throw error }
  const meta = (key: string) => (db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  const setMeta = (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO memory_meta VALUES (?,?)').run(key, value)
  const revision = () => Number(meta('revision') ?? 0)
  const epoch = () => Number(meta('epoch') ?? 0)
  const tx = <T>(work: () => T): T => transaction(db, work)
  const nextRevision = (invalidate = false) => {
    const next = revision() + 1
    setMeta('revision', String(next))
    if (invalidate) setMeta('epoch', String(next))
    return next
  }
  const sourceById = db.prepare(`SELECT s.*, e.token AS erasure_token, e.spans AS erasure_spans FROM memory_sources s
    LEFT JOIN memory_source_range_erasures e ON e.source=s.id WHERE s.id=?`)
  const erasuresByWorkspace = db.prepare('SELECT source,token,spans FROM memory_source_range_erasures WHERE workspace=? ORDER BY source')
  function fileErasures(workspace: string): DocumentSourceRef[] {
    const rows = erasuresByWorkspace.all(workspace) as Array<{ source: string, token: string, spans: string }>
    return rows.map(row => ({ id: row.source, token: row.token, spans: JSON.parse(row.spans) as MemorySourceErasure['spans'] }))
  }
  const readSource = (id: string): MemorySource | null => {
    const stored = sourceById.get(id) as (SourceRow & { erasure_token: string | null, erasure_spans: string | null }) | undefined
    if (!stored) return null
    const { erasure_token, erasure_spans, ...row } = stored
    return { ...row, requestId: row.request_id, questionId: row.question_id,
      scope: memoryScope.parse(JSON.parse(row.scope)), context: row.context ? memoryScope.parse(JSON.parse(row.context)) : null,
      project: row.project ? memoryScope.parse(JSON.parse(row.project)) : null, withdrawn: Boolean(row.withdrawn),
      ...(erasure_token && erasure_spans ? { erasure: { token: erasure_token, spans: JSON.parse(erasure_spans) as MemorySourceErasure['spans'] } } : {}) }
  }
  function eraseFileSource(target: DocumentSourceRef, version: number): MemorySourceErasure | null {
    return transaction(db, () => {
      const source = readSource(target.id)
      if (!source || source.withdrawn || source.version !== version || sourceExcluded(source.id)) return null
      const plan = planDocumentSourceErasure(source, memorySourceToken(source), target)
      if (!plan) return null
      db.prepare(`UPDATE memory_sources SET text=?, hash=?,version=version+1,question=NULL
        WHERE id=? AND version=?`).run(plan.text, memoryHash(plan.text), source.id, version)
      db.prepare(`INSERT INTO memory_source_range_erasures VALUES (?,?,?,?)
        ON CONFLICT(source) DO UPDATE SET spans=excluded.spans`)
        .run(source.id, memorySourceWorkspace(source), plan.erasure.token, JSON.stringify(plan.erasure.spans))
      return plan.erasure
    })
  }
  const insertSource = (source: MemorySource) => db.prepare(`INSERT INTO memory_sources
    (id, operation, version, conversation, session, scope, context, project, author, text, hash, length, question, request_id, question_id, at, timezone, outcome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.id, source.operation, source.version, source.conversation, source.session,
    memoryScopeKey(source.scope), source.context ? memoryScopeKey(source.context) : null, source.project ? memoryScopeKey(source.project) : null, source.author, source.text, source.hash, source.length,
    source.question, source.requestId, source.questionId, source.at, source.timezone, source.outcome)
  function insertManualFileSource(source: MemorySource, parents: readonly DocumentSourceRef[]) {
    tx(() => {
      insertSource(source)
      const insert = db.prepare('INSERT INTO memory_manual_file_lineage VALUES(?,?,?)')
      for (const parent of parents) insert.run(source.id, parent.id, JSON.stringify(parent))
    })
  }
  function manualFileRetainsText(matches: (workspace: string, text: string) => boolean) {
    const ids = db.prepare("SELECT id FROM memory_sources WHERE author='manual' AND text IS NOT NULL").iterate()
    for (const row of ids) {
      const source = readSource(String(row.id))
      if (source?.text && matches(memorySourceWorkspace(source), source.text)) return true
    }
    return false
  }
  const manualFileSources = () => db.prepare("SELECT id FROM memory_sources WHERE author='manual' AND text IS NOT NULL AND withdrawn=0").all()
    .flatMap(row => readSource(String(row.id)) ?? [])
  function trimManualFileParents(cuts: readonly DocumentSourceCut[]) {
    for (const cut of cuts) for (const row of copiesOfManualFile.all(cut.id)) {
      const ref = JSON.parse(String(row.reference)) as DocumentSourceRef
      if (!documentSourceRestricted(ref, [cut])) continue
      const spans = subtractDocumentSourceSpans(cut.length, ref, [cut])
      if (spans.length) db.prepare('UPDATE memory_manual_file_lineage SET reference=? WHERE source=? AND parent=?')
        .run(JSON.stringify({ ...ref, spans }), row.source, cut.id)
      else db.prepare('DELETE FROM memory_manual_file_lineage WHERE source=? AND parent=?').run(row.source, cut.id)
    }
  }
  const parentsOfManualFile = db.prepare('SELECT reference FROM memory_manual_file_lineage WHERE source=? ORDER BY parent')
  const copiesOfManualFile = db.prepare('SELECT source,reference FROM memory_manual_file_lineage WHERE parent=? ORDER BY source')
  const manualFileParents = (source: string) => parentsOfManualFile.all(source).map(row => JSON.parse(String(row.reference)) as DocumentSourceRef)
  const manualFileCopies = (parent: string) => copiesOfManualFile.all(parent)
    .map(row => ({ source: String(row.source), reference: JSON.parse(String(row.reference)) as DocumentSourceRef }))
  const outcome = (id: string, state: string) => db.prepare('UPDATE memory_sources SET outcome=? WHERE id=?').run(state, id)
  const withdrawSource = (id: string) => db.prepare("UPDATE memory_sources SET withdrawn=1,text=NULL,question=NULL,hash=NULL,outcome='withdrawn' WHERE id=?").run(id)
  const sourceExcluded = (id: string) => Boolean(db.prepare('SELECT 1 FROM memory_excluded_sources WHERE id=?').get(id))
  const excludeSource = (id: string) => db.prepare('INSERT OR IGNORE INTO memory_excluded_sources VALUES (?)').run(id)
  const sourceIds = (conversation: string) => (db.prepare('SELECT id FROM memory_sources WHERE conversation=?').all(conversation) as Array<{ id: string }>).map(row => row.id)
  const deliveredSourceIds = (conversation: string) => (db.prepare('SELECT id FROM memory_delivered_sources WHERE conversation=?')
    .all(conversation) as Array<{ id: string }>).map(row => row.id)
  const deliveredSource = (id: string) => db.prepare('SELECT conversation, derived FROM memory_delivered_sources WHERE id=?')
    .get(id) as { conversation: string, derived: number } | undefined
  const recordDeliveredSource = (id: string, conversation: string, derived: boolean) =>
    db.prepare('INSERT OR IGNORE INTO memory_delivered_sources VALUES (?,?,?)').run(id, conversation, Number(derived))
  const answerSourceIds = (conversation: string, request: string) => (db.prepare(
    "SELECT id FROM memory_sources WHERE conversation=? AND request_id=? AND author='answer'",
  ).all(conversation, request) as Array<{ id: string }>).map(row => row.id)
  const sessionEpoch = (id: string) => (db.prepare('SELECT epoch FROM memory_sessions WHERE id=?').get(id) as { epoch: number } | undefined)?.epoch ?? 0
  const recordSession = (id: string) => db.prepare('INSERT OR IGNORE INTO memory_sessions VALUES (?,?)').run(id, epoch())
  const sessionProject = (id: string) => db.prepare('SELECT project FROM memory_session_projects WHERE session=?').get(id)?.project as string | undefined
  const recordSessionProject = (id: string, project: string) => db.prepare('INSERT OR IGNORE INTO memory_session_projects VALUES (?,?)').run(id, project)
  const profile = () => Object.fromEntries((db.prepare('SELECT field,value,updated_at AS updatedAt,revision FROM profile').all() as Array<{ field: string, value: string, updatedAt: number, revision: number }>)
    .map(({ field, value, updatedAt, revision }) => [field, { value, updatedAt, revision, source: 'user' }]))
  function setProfile(fields: Record<string, string>) {
    for (const [key, value] of Object.entries(fields)) {
      if (value) db.prepare('INSERT OR REPLACE INTO profile VALUES (?,?,?,?)').run(key, value, now(), revision())
      else db.prepare('DELETE FROM profile WHERE field=?').run(key)
    }
    return profile()
  }
  const command = (key: string) => db.prepare('SELECT kind,payload,result FROM memory_commands WHERE key=?').get(key) as { kind: string, payload: string, result: number | null } | undefined
  const recordCommand = (key: string, kind: string, payload: string, result: number | null) =>
    db.prepare('INSERT INTO memory_commands VALUES (?,?,?,?)').run(key, kind, payload, result)
  const insertSessionFile = db.prepare('INSERT OR IGNORE INTO memory_session_file_dependencies VALUES (?, ?)')
  const readSessionFiles = db.prepare('SELECT reference FROM memory_session_file_dependencies WHERE session=? ORDER BY rowid')
  const insertSessionSource = db.prepare('INSERT OR IGNORE INTO memory_session_sources VALUES (?, ?)')
  const readSessionSources = db.prepare('SELECT source FROM memory_session_sources WHERE session = ?')
  const insertFileSource = db.prepare('INSERT OR IGNORE INTO memory_session_file_sources VALUES (?, ?)')
  const readFileSources = db.prepare(`SELECT source FROM memory_session_file_sources f WHERE session=?
    AND NOT EXISTS (SELECT 1 FROM memory_session_sources s WHERE s.session=f.session AND s.source=f.source) ORDER BY rowid`)
  const retainTurnOnly = db.prepare('INSERT OR IGNORE INTO memory_session_turn_only VALUES (?)')
  const usedTurnOnly = db.prepare('SELECT 1 FROM memory_session_turn_only WHERE session=?')
  const dispatch = {
    replace(session: string, sources: readonly string[]) {
      tx(() => {
        for (const table of ['memory_session_sources', 'memory_session_turn_only', 'memory_session_file_dependencies', 'memory_session_file_sources']) {
          db.prepare(`DELETE FROM ${table} WHERE session=?`).run(session)
        }
        for (const source of new Set(sources)) insertSessionSource.run(session, source)
        db.prepare('INSERT INTO memory_sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch').run(session, epoch())
      })
    },
    files(session: string, files: readonly MemoryFileDependency[], sources: readonly string[] = []) {
      // Serialize a canonical field order; retain different scopes, versions and policies without overwriting.
      const references = files.map(file => JSON.stringify(memoryFileDependencySchema.parse(file)))
      if (sources.length) memoryProvenanceSchema.parse({ sources: [...sources], fileSources: [...sources], files: [...files], turnOnly: false, epoch: epoch() })
      tx(() => {
        for (const reference of references) insertSessionFile.run(session, reference)
        for (const source of sources) insertFileSource.run(session, source)
      })
    },
    source: (session: string, source: string) => insertSessionSource.run(session, source),
    turnOnly: (session: string) => retainTurnOnly.run(session),
    snapshot(session: string): MemoryProvenance {
      const project = sessionProject(session)
      const files = (readSessionFiles.all(session) as Array<{ reference: string }>).map(row => memoryFileDependencySchema.parse(JSON.parse(row.reference)))
      const rawSources = (readSessionSources.all(session) as Array<{ source: string }>).map(row => row.source)
      const fileSources = (readFileSources.all(session) as Array<{ source: string }>).map(row => row.source)
      return { sources: [...rawSources, ...fileSources], ...(fileSources.length ? { fileSources } : {}),
        turnOnly: Boolean(usedTurnOnly.get(session)), ...(project ? { projects: [project] } : {}), epoch: epoch(), ...(files.length ? { files } : {}) }
    },
  }
  let temporaryFileRoot: string | undefined
  return { get fileRoot() {
    return file === ':memory:' ? temporaryFileRoot ??= fs.mkdtempSync(path.join(tmpdir(), 'viva-memory-files-')) : path.join(path.dirname(file), 'memory-files')
  }, db, tx, revision, epoch, nextRevision,
    readSource, insertSource, insertManualFileSource, manualFileRetainsText, manualFileParents, manualFileCopies, manualFileSources, trimManualFileParents,
    outcome, withdrawSource, eraseFileSource, fileErasures, sourceExcluded, excludeSource, sourceIds, answerSourceIds,
    deliveredSourceIds, deliveredSource, recordDeliveredSource, dispatch,
    sessionEpoch, recordSession, sessionProject, recordSessionProject, meta, setMeta, profile, setProfile, command, recordCommand,
    close() { try { db.close() } finally { if (temporaryFileRoot) fs.rmSync(temporaryFileRoot, { recursive: true, force: true }) } }
  }
}
export type MemoryStore = ReturnType<typeof openMemoryStore>
