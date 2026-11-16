import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { APP_DB_PRAGMAS, transaction } from './sqlite.ts'
import { MEMORY_CONTRACT, memoryScope } from '../contracts/memory-contract.ts'
import type { MemoryKind, MemoryScope } from '../contracts/memory-contract.ts'
import { memoryFileDependencySchema } from '../contracts/provenance.ts'
import { objectOf } from '../contracts/unknown-value.ts'
import { memorySourceToken, memorySourceWorkspace } from './source-identity.ts'
import { planDocumentSourceErasure } from '../core/memory-document-restrictions.ts'
import type { DocumentSourceRef } from '../core/ports/documents.ts'
import type { MemorySourceErasure } from '../contracts/records.ts'
import { memoryRelationLabel } from '../core/memory-facts.ts'
import type { MemoryFact } from '../core/memory-facts.ts'
import type { MemoryInterval } from '../core/memory-intervals.ts'

const SCHEMA = `
  CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE memory_sources (
    id TEXT PRIMARY KEY, operation TEXT NOT NULL, version INTEGER NOT NULL,
    conversation TEXT, session TEXT, scope TEXT NOT NULL, context TEXT, author TEXT NOT NULL,
    text TEXT, hash TEXT, remembered_hash TEXT, length INTEGER NOT NULL, question TEXT, request_id TEXT, question_id TEXT, at INTEGER NOT NULL, timezone TEXT NOT NULL,
    outcome TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0, UNIQUE(operation, version)
  );
  CREATE INDEX memory_sources_conversation ON memory_sources(conversation);
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL,
    scope TEXT NOT NULL, modality TEXT NOT NULL, conditional INTEGER NOT NULL, keywords TEXT NOT NULL,
    source TEXT NOT NULL, conversation TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active', retention TEXT NOT NULL DEFAULT 'retained', authorized_revision INTEGER NOT NULL DEFAULT 0,
    invalid_at INTEGER, invalidated_by TEXT, valid_from INTEGER, valid_to INTEGER,
    asserted_from INTEGER, asserted_to INTEGER, windows TEXT NOT NULL
  );
  CREATE INDEX memories_scope ON memories(scope, state, retention);
  CREATE TABLE memory_evidence (
    memory INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    source TEXT NOT NULL REFERENCES memory_sources(id), version INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
    parts TEXT, spans TEXT NOT NULL, change_id INTEGER, asserted_from INTEGER, asserted_to INTEGER, inherits_change_time INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(memory, source, start, end)
  );
  CREATE INDEX memory_evidence_source ON memory_evidence(source);
  CREATE TABLE memory_candidates (
    source TEXT NOT NULL REFERENCES memory_sources(id), start INTEGER NOT NULL, end INTEGER NOT NULL,
    proposal TEXT NOT NULL, reason TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(source, start, end)
  );
  CREATE INDEX memory_candidates_expiry ON memory_candidates(expires_at);
  CREATE TABLE memory_exclusions (
    fingerprint TEXT NOT NULL, size INTEGER NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(fingerprint, scope)
  );
  CREATE TABLE memory_excluded_sources (id TEXT PRIMARY KEY);
  CREATE TABLE memory_sessions (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
  CREATE TABLE memory_commands (key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, result INTEGER);
  CREATE TABLE profile (field TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL);
`

const FACT_SCHEMA = `
  CREATE TABLE memory_facts (
    memory INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    subject TEXT NOT NULL, predicate TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
    polarity TEXT NOT NULL, dated INTEGER NOT NULL, intended_from INTEGER, intended_to INTEGER
  );
  CREATE INDEX memory_fact_subject ON memory_facts(subject,predicate);
  CREATE TABLE memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL,
    target INTEGER NOT NULL, replacement INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('correct','supersede','end','possible_conflict','pending_relation')),
    source TEXT REFERENCES memory_sources(id), source_version INTEGER,
    spans TEXT NOT NULL, affected_from INTEGER, affected_to INTEGER, effective_at INTEGER,
    intent_from INTEGER, intent_to INTEGER, derived_from INTEGER, intent_windows TEXT,
    old_value_spans TEXT NOT NULL DEFAULT '[]', needs_confirmation INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, automatic INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'applied',
    CHECK(replacement IS NULL OR target<>replacement)
  );
  CREATE INDEX memory_links_target ON memory_links(target, kind, status);
  CREATE INDEX memory_links_replacement ON memory_links(replacement, kind, status);
  CREATE INDEX memory_links_source ON memory_links(source);
`

const DISPATCH_SCHEMA = `
  CREATE TABLE memory_delivered_sources (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, derived INTEGER NOT NULL);
  CREATE INDEX memory_delivered_sources_conversation ON memory_delivered_sources(conversation);
  CREATE TABLE memory_session_dependencies (
    session TEXT NOT NULL, fact INTEGER NOT NULL, revision INTEGER NOT NULL,
    as_of TEXT NOT NULL, disputed INTEGER NOT NULL,
    PRIMARY KEY(session, fact, revision, as_of, disputed)
  );
  CREATE TABLE memory_session_sources (
    session TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(session, source)
  );
  CREATE TABLE memory_session_turn_only (session TEXT PRIMARY KEY);
`

// Derived delivery metadata is additive. Existing session receipts do not have relation deadlines.
const DERIVED_DISPATCH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_session_file_dependencies (
    session TEXT NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(session,reference)
  );
  CREATE TABLE IF NOT EXISTS memory_session_file_sources (
    session TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(session,source)
  );
  CREATE TABLE IF NOT EXISTS memory_session_relation_dependencies (
    session TEXT NOT NULL, fact INTEGER NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL,
    PRIMARY KEY(session, fact, revision)
  );
  CREATE TABLE IF NOT EXISTS memory_session_projects (session TEXT PRIMARY KEY, project TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_session_profile_dependencies (
    session TEXT NOT NULL, fact INTEGER NOT NULL, revision INTEGER NOT NULL, collection_revision INTEGER NOT NULL, expires INTEGER,
    PRIMARY KEY(session, fact, revision, collection_revision)
  );
`

import type { MemoryDependency, MemoryFileDependency, MemoryProvenance, MemorySource, StoredFact, MemoryCandidate, MemoryEvidence, MemoryChangeKind, MemoryChangeStatus, MemoryChange, MemoryEntry } from '../core/ports/store.ts'
export type { MemoryDependency, MemoryFileDependency, MemoryProvenance, MemorySource, StoredFact, MemoryCandidate, MemoryEvidence, MemoryChangeKind, MemoryChangeStatus, MemoryChange, MemoryEntry } from '../core/ports/store.ts'

const CANDIDATE_TARGET = "COALESCE(json_extract(proposal,'$.proposal.change.target.id'),json_extract(proposal,'$.change.target.id'))"

type MemoryRow = Omit<MemoryEntry, 'scope' | 'conditional' | 'keywords' | 'evidence' | 'fact' | 'links' | 'windows'>
  & { scope: string, conditional: number, keywords: string, windows: string }
type ChangeRow = Omit<MemoryChange, 'spans' | 'automatic' | 'intentWindows' | 'oldValueSpans' | 'needsConfirmation'>
  & { spans: string, automatic: number, intentWindows: string | null, oldValueSpans: string, needsConfirmation: number }
type EvidenceRow = Omit<MemoryEvidence, 'parts' | 'spans' | 'inheritsChangeTime'> & { parts: string | null, spans: string, inheritsChangeTime: number }
type SourceRow = Omit<MemorySource, 'scope' | 'context' | 'project' | 'withdrawn' | 'requestId' | 'questionId' | 'rememberedHash' | 'erasure'> & { scope: string, context: string | null, project: string | null, withdrawn: number, request_id: string | null, question_id: string | null, remembered_hash: string | null }
const columns = 'id, revision, text, kind, scope, modality, conditional, keywords, source, conversation AS conversationId, created_at AS createdAt, updated_at AS updatedAt, state, retention, authorized_revision AS authorizedRevision, invalid_at AS invalidAt, invalidated_by AS invalidatedBy, valid_from AS validFrom, valid_to AS validTo, asserted_from AS assertedFrom, asserted_to AS assertedTo, windows'
const changeColumns = 'id, revision, target AS targetId, replacement AS replacementId, kind, source AS sourceId, source_version AS sourceVersion, spans, affected_from AS "from", affected_to AS "to", effective_at AS effectiveAt, intent_from AS intentFrom, intent_to AS intentTo, derived_from AS derivedFrom, intent_windows AS intentWindows, old_value_spans AS oldValueSpans, needs_confirmation AS needsConfirmation, created_at AS createdAt, automatic, status'
import { memoryScopeKey } from '../core/scope.ts'
export { memoryScopeKey } from '../core/scope.ts'
const userScopeKey = memoryScopeKey({ kind: 'user' })
const alternateScopeKey = (scope: MemoryScope) => scope.kind === 'user' ? userScopeKey : JSON.stringify({ id: scope.id, kind: scope.kind })
export function memoryScopeKeys(scope?: MemoryScope): [string, string, string] {
  return !scope || scope.kind === 'user' ? [userScopeKey, userScopeKey, userScopeKey]
    : [userScopeKey, memoryScopeKey(scope), alternateScopeKey(scope)]
}

export const memoryWindowsOverlap = `EXISTS (SELECT 1 FROM json_each(m.windows) w WHERE
  (? IS NULL OR json_extract(w.value,'$.from') IS NULL OR json_extract(w.value,'$.from') < ?)
  AND (? IS NULL OR json_extract(w.value,'$.to') IS NULL OR json_extract(w.value,'$.to') > ?))`
export const memoryEligibleEvidence = `EXISTS (
  SELECT 1 FROM memory_evidence e JOIN memory_sources s ON s.id=e.source
  LEFT JOIN memory_links l ON l.id=e.change_id
  WHERE e.memory=m.id AND s.withdrawn=0 AND s.version=e.version AND s.outcome<>'explicit-pending'
    AND (e.change_id IS NULL OR l.status='applied'))`
export const memoryContextCandidate = `((m.modality='asserted' AND m.conditional=0) OR EXISTS (
  SELECT 1 FROM memory_links l WHERE l.kind='possible_conflict' AND l.status='applied' AND l.target=m.id
  UNION ALL
  SELECT 1 FROM memory_links l WHERE l.kind='possible_conflict' AND l.status='applied' AND l.replacement=m.id
))`
export const memoryWindowParameters = ({ from, to }: MemoryInterval) => [to, to, from, from] as const
export const memoryHash = (text: string) => createHash('sha256').update(text).digest('hex')
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
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
      db.exec(FACT_SCHEMA)
      db.exec(DISPATCH_SCHEMA)
      db.exec(`PRAGMA user_version = ${MEMORY_CONTRACT}`)
      db.prepare('INSERT INTO memory_meta (key,value) VALUES (?,?)').run('secret', randomBytes(32).toString('hex'))
    })
    db.exec(DERIVED_DISPATCH_SCHEMA)
    db.exec(`CREATE TABLE IF NOT EXISTS memory_source_range_erasures (
      source TEXT PRIMARY KEY REFERENCES memory_sources(id), workspace TEXT NOT NULL, token TEXT NOT NULL, spans TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS memory_source_range_erasures_workspace ON memory_source_range_erasures(workspace)`)
    if (!db.prepare("SELECT 1 FROM pragma_table_info('memory_sources') WHERE name='project'").get()) {
      db.exec('ALTER TABLE memory_sources ADD COLUMN project TEXT')
    }
    // Reindex these derived keys if the normalization of entity labels changes.
    db.function('memory_relation_label', { deterministic: true }, value =>
      typeof value === 'string' ? memoryRelationLabel(value) : '')
    db.exec(`
      CREATE INDEX IF NOT EXISTS memory_fact_relation_subject ON memory_facts(memory_relation_label(subject)) WHERE polarity='positive';
      CREATE INDEX IF NOT EXISTS memory_fact_relation_object ON memory_facts(memory_relation_label(object)) WHERE polarity='positive';
      CREATE INDEX IF NOT EXISTS memory_candidates_target ON memory_candidates(${CANDIDATE_TARGET});
    `)
  } catch (error) {
    db.close()
    throw error
  }
  const meta = (key: string) => (db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  const setMeta = (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO memory_meta VALUES (?,?)').run(key, value)
  const revision = () => Number(meta('revision') ?? 0)
  const epoch = () => Number(meta('epoch') ?? 0)
  const secret = meta('secret')!
  const tx = <T>(work: () => T): T => transaction(db, work)
  const fingerprint = (value: string) => createHmac('sha256', secret).update(value).digest('hex')
  const nextRevision = (invalidate = false) => {
    const next = revision() + 1
    setMeta('revision', String(next))
    if (invalidate) setMeta('epoch', String(next))
    return next
  }
  const evidenceColumns = `e.source AS sourceId,s.conversation AS conversationId,e.version AS sourceVersion,
    e.start,e.end,e.parts,e.spans,e.change_id AS changeId,e.asserted_from AS assertedFrom,e.asserted_to AS assertedTo,e.inherits_change_time AS inheritsChangeTime`
  const evidenceOrder = 'ORDER BY s.at,e.source,e.start'
  const evidenceBase = `FROM memory_evidence e JOIN memory_sources s ON s.id=e.source
    LEFT JOIN memory_links l ON l.id=e.change_id
    WHERE s.withdrawn=0 AND s.version=e.version AND (e.change_id IS NULL OR l.status='applied')`
  const evidenceRows = db.prepare(`SELECT ${evidenceColumns} ${evidenceBase} AND e.memory=? ${evidenceOrder}`)
  const storedEvidenceRows = db.prepare(`SELECT ${evidenceColumns}
    FROM memory_evidence e JOIN memory_sources s ON s.id=e.source WHERE e.memory=? ${evidenceOrder}`)
  const factColumns = 'subject,predicate,relation,object,polarity,dated,intended_from AS intendedFrom,intended_to AS intendedTo'
  const factOf = db.prepare(`SELECT ${factColumns} FROM memory_facts WHERE memory=?`)
  const activeChangeSql = `SELECT ${changeColumns} FROM memory_links
    WHERE status='applied' AND (source IS NULL OR EXISTS (SELECT 1 FROM memory_sources s
      WHERE s.id=memory_links.source AND s.version=memory_links.source_version AND s.withdrawn=0))`
  const linksOf = db.prepare(`${activeChangeSql} AND (target=? OR replacement=?) ORDER BY id`)
  const activeChanges = db.prepare(`${activeChangeSql} ORDER BY id`)
  const rowOf = db.prepare(`SELECT ${columns} FROM memories WHERE id=?`)
  const exists = db.prepare('SELECT 1 FROM memories WHERE id=?')
  const entryOrder = 'ORDER BY updated_at DESC,id DESC'
  const allEntries = {
    rows: db.prepare(`SELECT ${columns} FROM memories ${entryOrder}`),
    evidence: db.prepare(`SELECT e.memory,${evidenceColumns} ${evidenceBase} ${evidenceOrder}`),
    facts: db.prepare(`SELECT memory,${factColumns} FROM memory_facts`),
    changes: activeChanges,
  }
  const retainedScope = "scope IN (?,?,?) AND retention='retained'"
  const scopedIds = `WITH scoped AS (SELECT id FROM memories WHERE ${retainedScope})`
  const scopedEntries = {
    rows: db.prepare(`SELECT ${columns} FROM memories WHERE ${retainedScope} ${entryOrder}`),
    evidence: db.prepare(`${scopedIds} SELECT e.memory,${evidenceColumns} ${evidenceBase} AND e.memory IN scoped ${evidenceOrder}`),
    facts: db.prepare(`${scopedIds} SELECT memory,${factColumns} FROM memory_facts WHERE memory IN scoped`),
    changes: db.prepare(`${scopedIds} ${activeChangeSql} AND (target IN scoped OR replacement IN scoped) ORDER BY id`),
  }
  const matchingText = db.prepare('SELECT id FROM memories WHERE text=? AND scope=? AND retention=\'retained\'')
  const readChange = db.prepare(`SELECT ${changeColumns} FROM memory_links WHERE id=?`)
  const allChanges = db.prepare(`SELECT ${changeColumns} FROM memory_links ORDER BY id DESC`)
  const toEvidence = (row: EvidenceRow): MemoryEvidence => ({ ...row, parts: row.parts ? JSON.parse(row.parts) : null, spans: JSON.parse(row.spans),
    inheritsChangeTime: Boolean(row.inheritsChangeTime) })
  const storedEvidence = (id: number) => (storedEvidenceRows.all(id) as unknown as EvidenceRow[]).map(toEvidence)
  const toChange = (row: ChangeRow): MemoryChange => ({ ...row, spans: JSON.parse(row.spans), automatic: Boolean(row.automatic),
    intentWindows: row.intentWindows === null ? null : JSON.parse(row.intentWindows),
    oldValueSpans: JSON.parse(row.oldValueSpans), needsConfirmation: Boolean(row.needsConfirmation) })
  const toFact = (row: Omit<StoredFact, 'dated'> & { dated: number }): StoredFact => ({ ...row, dated: Boolean(row.dated) })
  function toEntry(row: MemoryRow, evidence: MemoryEvidence[], fact: StoredFact | null, changes: MemoryChange[]): MemoryEntry {
    const links = changes.flatMap<MemoryEntry['links'][number]>(change => {
      const incoming = change.targetId === row.id
      const id = incoming ? change.replacementId : change.targetId
      if (!id) return []
      const kind = change.kind === 'possible_conflict' ? 'conflict' : change.kind === 'correct' ? 'corrects'
        : change.kind === 'pending_relation' ? 'pending-relation' : 'supersedes'
      return [{ id, kind, incoming, changeId: change.id, from: change.from, to: change.to }]
    })
    return { ...row, scope: memoryScope.parse(JSON.parse(row.scope)), conditional: Boolean(row.conditional),
      keywords: JSON.parse(row.keywords), windows: JSON.parse(row.windows), evidence, fact, links }
  }
  function get(id: number) {
    const row = rowOf.get(id) as MemoryRow | undefined
    if (!row) return null
    const fact = factOf.get(id) as Parameters<typeof toFact>[0] | undefined
    return toEntry(row, (evidenceRows.all(id) as unknown as EvidenceRow[]).map(toEvidence), fact ? toFact(fact) : null,
      (linksOf.all(id, id) as unknown as ChangeRow[]).map(toChange))
  }
  function readEntries(queries: { rows: StatementSync, evidence: StatementSync, facts: StatementSync, changes: StatementSync }, ...scopes: string[]) {
    const rows = queries.rows.all(...scopes) as unknown as MemoryRow[]
    if (!rows.length) return []
    const evidence = new Map<number, MemoryEvidence[]>()
    for (const { memory, ...row } of queries.evidence.all(...scopes) as unknown as Array<EvidenceRow & { memory: number }>) {
      const edges = evidence.get(memory) ?? []
      edges.push(toEvidence(row))
      evidence.set(memory, edges)
    }
    const facts = new Map((queries.facts.all(...scopes) as unknown as Array<Parameters<typeof toFact>[0] & { memory: number }>)
      .map(({ memory, ...row }) => [memory, toFact(row)]))
    const linked = new Map<number, MemoryChange[]>()
    for (const change of (queries.changes.all(...scopes) as unknown as ChangeRow[]).map(toChange)) {
      for (const id of [change.targetId, change.replacementId]) if (id) {
        const edges = linked.get(id) ?? []
        edges.push(change)
        linked.set(id, edges)
      }
    }
    return rows.map(row => toEntry(row, evidence.get(row.id) ?? [], facts.get(row.id) ?? null, linked.get(row.id) ?? []))
  }
  const list = () => readEntries(allEntries)
  const listForScope = (scope?: MemoryScope) => readEntries(scopedEntries, ...memoryScopeKeys(scope))
  const retainedReadable = "m.retention='retained' AND m.state IN ('active','superseded')"
  const eligibleEvidence = db.prepare(`SELECT 1 ${evidenceBase} AND e.memory=? AND s.outcome<>'explicit-pending' LIMIT 1`)
  const fallbackRefs = db.prepare(`SELECT m.id,m.revision FROM memories m
    WHERE m.scope IN (?,?,?) AND ${retainedReadable} AND ${memoryWindowsOverlap} AND ${memoryEligibleEvidence}
      AND (?=0 OR ${memoryContextCandidate})
    ORDER BY m.updated_at DESC,m.id DESC LIMIT ?`)
  const relationRefs = db.prepare(`
    SELECT m.id,m.revision FROM (
      SELECT memory FROM memory_facts WHERE polarity='positive' AND memory_relation_label(subject)=?
      UNION
      SELECT memory FROM memory_facts WHERE polarity='positive' AND memory_relation_label(object)=?
    ) f JOIN memories m ON m.id=f.memory
    WHERE m.scope IN (?,?) AND ${retainedReadable} AND m.modality='asserted' AND m.conditional=0 AND ${memoryWindowsOverlap} AND ${memoryEligibleEvidence}
    ORDER BY m.updated_at DESC,m.id DESC LIMIT ?`)
  type RecallRef = Pick<MemoryEntry, 'id' | 'revision'>
  const recentRecallRefs = (scope: MemoryScope | undefined, interval: MemoryInterval, limit: number, contextOnly = false) =>
    fallbackRefs.all(...memoryScopeKeys(scope), ...memoryWindowParameters(interval), Number(contextOnly), limit) as RecallRef[]
  const relationRecallRefs = (scope: MemoryScope, label: string, interval: MemoryInterval, limit: number) =>
    relationRefs.all(`named:${label}`, label, memoryScopeKey(scope), alternateScopeKey(scope), ...memoryWindowParameters(interval), limit) as RecallRef[]
  const profileRefs = db.prepare(`SELECT m.id,m.revision FROM memories m
    WHERE m.scope IN (?,?) AND ${retainedReadable} AND ${memoryEligibleEvidence}
      AND m.modality='asserted' AND m.conditional=0 AND ${memoryWindowsOverlap}
    ORDER BY m.updated_at DESC,m.id DESC LIMIT ?`)
  const profileBoundary = db.prepare(`WITH eligible AS (
    SELECT m.id, m.valid_from, m.windows FROM memories m WHERE m.scope IN (?,?)
      AND ${retainedReadable} AND ${memoryEligibleEvidence} AND m.modality='asserted' AND m.conditional=0
  ), bounds(at) AS (
    SELECT valid_from FROM eligible
    UNION ALL SELECT json_extract(w.value,'$.from') FROM eligible m JOIN json_each(m.windows) w
    UNION ALL SELECT json_extract(w.value,'$.to') FROM eligible m JOIN json_each(m.windows) w
    UNION ALL SELECT e.asserted_to FROM eligible m JOIN memory_evidence e ON e.memory=m.id
    UNION ALL SELECT l.affected_from FROM eligible m JOIN memory_links l ON l.target=m.id OR l.replacement=m.id WHERE l.status='applied'
    UNION ALL SELECT l.affected_to FROM eligible m JOIN memory_links l ON l.target=m.id OR l.replacement=m.id WHERE l.status='applied'
  ) SELECT MIN(at) AS at FROM bounds WHERE at>?`)
  const profileCandidates = (scope: MemoryScope, at: number, limit: number) =>
    profileRefs.all(memoryScopeKey(scope), alternateScopeKey(scope), ...memoryWindowParameters({ from: at, to: at + 1 }), limit) as RecallRef[]
  const nextProfileBoundary = (scope: MemoryScope, at: number) =>
    (profileBoundary.get(memoryScopeKey(scope), alternateScopeKey(scope), at) as { at: number | null }).at
  const modelEligible = (id: number) => Boolean(eligibleEvidence.get(id))
  const pendingEndingAt = db.prepare(`SELECT 1 FROM memory_links WHERE kind='end' AND status='applied' AND needs_confirmation=1
    AND (? IS NULL OR intent_from IS NULL OR intent_from<?)
    AND (? IS NULL OR intent_to IS NULL OR intent_to>?) LIMIT 1`)
  const inactiveRecall = db.prepare(`SELECT m.id,m.revision FROM memories m
    WHERE m.scope IN (?,?,?) AND ${retainedReadable} AND NOT ${memoryWindowsOverlap} AND ${memoryEligibleEvidence}
    ORDER BY m.updated_at DESC,m.id DESC LIMIT ?`)
  const inactiveRecallRefs = (scope: MemoryScope | undefined, interval: MemoryInterval, limit: number) =>
    inactiveRecall.all(...memoryScopeKeys(scope), ...memoryWindowParameters(interval), limit) as RecallRef[]
  const hasPendingEnding = (interval: MemoryInterval) => Boolean(pendingEndingAt.get(...memoryWindowParameters(interval)))
  const relatedEndings = db.prepare(`WITH RECURSIVE component(id) AS (
    SELECT value FROM json_each(?)
    UNION
    SELECT l.replacement FROM memory_links l JOIN component c ON l.target=c.id
      WHERE l.replacement IS NOT NULL AND (l.kind='supersede' OR (l.kind='correct' AND l.source IS NOT NULL))
    UNION
    SELECT l.target FROM memory_links l JOIN component c ON l.replacement=c.id
      WHERE l.kind='supersede' OR (l.kind='correct' AND l.source IS NOT NULL)
    LIMIT 256
  )
  SELECT ${changeColumns} FROM memory_links WHERE target IN component
    AND kind='end' AND status='applied' AND needs_confirmation=1 LIMIT 64`)
  const pendingEndingsFor = (ids: readonly number[]) =>
    (relatedEndings.all(JSON.stringify(ids)) as unknown as ChangeRow[]).map(toChange)
  const getChange = (id: number) => {
    const row = readChange.get(id) as ChangeRow | undefined
    return row ? toChange(row) : null
  }
  const listChanges = () => (allChanges.all() as unknown as ChangeRow[]).map(toChange)
  const appliedChanges = () => (activeChanges.all() as unknown as ChangeRow[]).map(toChange)
  const changesFor = (id: number) => (linksOf.all(id, id) as unknown as ChangeRow[]).map(toChange)
  const sameText = (text: string, scope: MemoryScope) =>
    (matchingText.all(text, memoryScopeKey(scope)) as Array<{ id: number }>).map(row => get(row.id)!)
  type OptionalChangeFields = 'derivedFrom' | 'intentWindows' | 'oldValueSpans' | 'needsConfirmation'
  const recordChange = (change: Omit<MemoryChange, 'id' | 'status' | OptionalChangeFields>
    & Partial<Pick<MemoryChange, OptionalChangeFields>>) =>
    Number(db.prepare(`INSERT INTO memory_links
      (revision,target,replacement,kind,source,source_version,spans,affected_from,affected_to,effective_at,intent_from,intent_to,derived_from,intent_windows,old_value_spans,needs_confirmation,created_at,automatic)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(change.revision, change.targetId, change.replacementId, change.kind, change.sourceId,
      change.sourceVersion, JSON.stringify(change.spans), change.from, change.to, change.effectiveAt, change.intentFrom, change.intentTo,
      change.derivedFrom ?? null, change.intentWindows ? JSON.stringify(change.intentWindows) : null, JSON.stringify(change.oldValueSpans ?? []),
      Number(change.needsConfirmation ?? false), change.createdAt, Number(change.automatic)).lastInsertRowid)
  const setChangeStatus = (id: number, status: MemoryChangeStatus, revision: number) =>
    db.prepare('UPDATE memory_links SET status=?,revision=? WHERE id=?').run(status, revision, id)
  const projectChange = (id: number, interval: MemoryInterval, needsConfirmation: boolean, revision: number) =>
    db.prepare('UPDATE memory_links SET affected_from=?,affected_to=?,needs_confirmation=?,revision=? WHERE id=?')
      .run(interval.from, interval.to, Number(needsConfirmation), revision, id)
  const reviseDispute = (id: number, interval: MemoryInterval, revision: number) =>
    db.prepare('UPDATE memory_links SET affected_from=?,affected_to=?,intent_from=?,intent_to=?,revision=? WHERE id=?')
      .run(interval.from, interval.to, interval.from, interval.to, revision, id)
  const recordFact = (id: number, fact: MemoryFact) =>
    db.prepare(`INSERT OR REPLACE INTO memory_facts VALUES (?,?,?,?,?,?,?,?,?)`).run(id, fact.subject, fact.predicate, fact.relation,
      fact.object, fact.polarity, Number(fact.dated), fact.dated && !fact.uncertain ? fact.from : null, fact.dated && !fact.uncertain ? fact.to : null)
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
    return { ...row, requestId: row.request_id, questionId: row.question_id, rememberedHash: row.remembered_hash,
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
      db.prepare(`UPDATE memory_sources SET text=?, hash=?,version=version+1,question=NULL,remembered_hash=NULL
        WHERE id=? AND version=?`).run(plan.text, memoryHash(plan.text), source.id, version)
      db.prepare(`INSERT INTO memory_source_range_erasures VALUES (?,?,?,?)
        ON CONFLICT(source) DO UPDATE SET spans=excluded.spans`)
        .run(source.id, memorySourceWorkspace(source), plan.erasure.token, JSON.stringify(plan.erasure.spans))
      return plan.erasure
    })
  }
  const insertSource = (source: MemorySource) => db.prepare(`INSERT INTO memory_sources
    (id, operation, version, conversation, session, scope, context, project, author, text, hash, remembered_hash, length, question, request_id, question_id, at, timezone, outcome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(source.id, source.operation, source.version, source.conversation, source.session,
    memoryScopeKey(source.scope), source.context ? memoryScopeKey(source.context) : null, source.project ? memoryScopeKey(source.project) : null, source.author, source.text, source.hash, source.rememberedHash ?? null, source.length,
    source.question, source.requestId, source.questionId, source.at, source.timezone, source.outcome)
  const outcome = (id: string, state: string) => db.prepare('UPDATE memory_sources SET outcome=? WHERE id=?').run(state, id)
  const withdrawSource = (id: string) => db.prepare("UPDATE memory_sources SET withdrawn=1,text=NULL,question=NULL,hash=NULL,remembered_hash=NULL,outcome='withdrawn' WHERE id=?").run(id)
  const evidence = (memory: number, source: MemorySource, start: number, end: number, parts: MemoryFact['evidence'] | null, changeId: number | null,
    interval: MemoryInterval, spans: MemoryEvidence['spans'], inheritsChangeTime = true) =>
    db.prepare(`INSERT INTO memory_evidence VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory,source,start,end)
      DO UPDATE SET parts=COALESCE(excluded.parts,memory_evidence.parts),spans=excluded.spans,change_id=excluded.change_id,
        asserted_from=excluded.asserted_from,asserted_to=excluded.asserted_to,inherits_change_time=excluded.inherits_change_time`)
      .run(memory, source.id, source.version, start, end, parts ? JSON.stringify(parts) : null, JSON.stringify(spans), changeId, interval.from, interval.to,
        Number(inheritsChangeTime)).changes
  const removeEvidence = (memory: number, source: string, start: number, end: number) =>
    db.prepare('DELETE FROM memory_evidence WHERE memory=? AND source=? AND start=? AND end=?').run(memory, source, start, end)
  const bindEvidenceChange = (memory: number, source: string, start: number, end: number, changeId: number, parts: MemoryFact['evidence'] | null) =>
    db.prepare('UPDATE memory_evidence SET change_id=?,parts=? WHERE memory=? AND source=? AND start=? AND end=?')
      .run(changeId, parts ? JSON.stringify(parts) : null, memory, source, start, end)
  const updateEvidenceSpans = (memory: number, edge: MemoryEvidence, spans: MemoryEvidence['spans']) =>
    db.prepare('UPDATE memory_evidence SET spans=? WHERE memory=? AND source=? AND start=? AND end=?')
      .run(JSON.stringify(spans), memory, edge.sourceId, edge.start, edge.end)
  const redactSource = (source: string, text: string) =>
    db.prepare('UPDATE memory_sources SET text=?,question=NULL WHERE id=?').run(text, source)
  // An assistant question can quote an old value without a reference to the entry it used.
  const clearSourceQuestions = () => (db.prepare('UPDATE memory_sources SET question=NULL WHERE question IS NOT NULL RETURNING id')
    .all() as { id: string }[]).map(row => row.id)
  const setKeywords = (id: number, words: readonly string[]) => db.prepare('UPDATE memories SET keywords=? WHERE id=?').run(JSON.stringify(words), id)
  const touchChange = (id: number, revision: number) =>
    db.prepare('UPDATE memory_links SET revision=? WHERE id=?').run(revision, id)
  function insert(entry: Pick<MemoryEntry, 'text' | 'kind' | 'scope' | 'modality' | 'conditional' | 'keywords' | 'source' | 'conversationId'>, rev: number, at: number, interval: MemoryInterval) {
    return Number(db.prepare(`INSERT INTO memories (revision,text,kind,scope,modality,conditional,keywords,source,conversation,created_at,updated_at,
      asserted_from,asserted_to,valid_from,valid_to,windows) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rev, entry.text, entry.kind, memoryScopeKey(entry.scope), entry.modality, Number(entry.conditional),
        JSON.stringify(entry.keywords), entry.source, entry.conversationId, at, at, interval.from, interval.to, interval.from, interval.to, JSON.stringify([interval])).lastInsertRowid)
  }
  const setAssertion = (id: number, interval: MemoryInterval, text: string, details: Pick<MemoryEntry, 'keywords' | 'scope' | 'conditional' | 'modality'>) =>
    db.prepare('UPDATE memories SET asserted_from=?,asserted_to=?,text=?,keywords=?,scope=?,conditional=?,modality=? WHERE id=?')
      .run(interval.from, interval.to, text, JSON.stringify(details.keywords), memoryScopeKey(details.scope), Number(details.conditional), details.modality, id)
  const project = (id: number, data: Pick<MemoryEntry, 'state' | 'text' | 'windows' | 'invalidAt' | 'invalidatedBy'>, revision: number) =>
    db.prepare('UPDATE memories SET text=?,state=?,windows=?,valid_from=?,valid_to=?,invalid_at=?,invalidated_by=?,revision=?,updated_at=? WHERE id=?')
      .run(data.text, data.state, JSON.stringify(data.windows), data.windows[0]?.from ?? null, data.windows.at(-1)?.to ?? null,
        data.invalidAt, data.invalidatedBy, revision, now(), id)
  const touch = (id: number, revision: number) => db.prepare('UPDATE memories SET revision=?,updated_at=? WHERE id=?').run(revision, now(), id)
  const authorize = (id: number, revision: number) => db.prepare('UPDATE memories SET authorized_revision=? WHERE id=?').run(revision, id)
  const remove = (id: number) => db.prepare('DELETE FROM memories WHERE id=?').run(id)
  const forgetEntry = (id: number, revision: number) => db.prepare("UPDATE memories SET revision=?,retention='forgotten',invalid_at=?,invalidated_by='user' WHERE id=?").run(revision, now(), id)
  const restoreEntry = (id: number, revision: number) => db.prepare("UPDATE memories SET retention='retained',invalid_at=NULL,invalidated_by=NULL,revision=?,authorized_revision=?,updated_at=? WHERE id=?").run(revision, revision, now(), id)
  function exclude(text: string, scope: MemoryScope) {
    const value = normalized(text)
    if (!value) return
    db.prepare('INSERT OR REPLACE INTO memory_exclusions VALUES (?,?,?,?)').run(fingerprint(value), value.length, memoryScopeKey(scope), revision())
  }
  function excluded(text: string, scope?: MemoryScope, authorizedRevision = -1): boolean {
    const value = normalized(text)
    if (!value) return false
    const rows = db.prepare('SELECT scope FROM memory_exclusions WHERE fingerprint=? AND revision>?')
      .all(fingerprint(value), authorizedRevision) as Array<{ scope: string }>
    return rows.some(row => !scope || row.scope === memoryScopeKey(scope) || row.scope === memoryScopeKey({ kind: 'user' }))
  }
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
  const memoriesFrom = (source: string) =>
    (db.prepare('SELECT DISTINCT memory FROM memory_evidence WHERE source=?').all(source) as Array<{ memory: number }>).map(row => row.memory)
  const changesFrom = (source: string) =>
    (db.prepare(`SELECT ${changeColumns} FROM memory_links WHERE source=? AND status='applied'`).all(source) as unknown as ChangeRow[]).map(toChange)
  const changesReferencing = (id: number) =>
    (db.prepare(`SELECT ${changeColumns} FROM memory_links WHERE target=? OR replacement=?`).all(id, id) as unknown as ChangeRow[]).map(toChange)
  const hasChangeSource = (id: string) => Boolean(db.prepare("SELECT 1 FROM memory_links WHERE source=? AND kind<>'possible_conflict'").get(id))
  const priorSources = (source: MemorySource) => db.prepare(`SELECT id,text FROM memory_sources
    WHERE conversation=? AND at<? AND withdrawn=0 AND author='user' AND length(text)<=500
    ORDER BY at DESC LIMIT 2`).all(source.conversation, source.at) as Array<{ id: string, text: string }>
  const candidate = (source: string, start: number, end: number, proposal: object, reason: string) =>
    db.prepare('INSERT OR REPLACE INTO memory_candidates VALUES (?,?,?,?,?,?)').run(source, start, end, JSON.stringify(proposal), reason, now() + 7 * 86_400_000)
  const pendingCandidates = db.prepare(`SELECT source AS sourceId,start,end,proposal,expires_at AS expiresAt
    FROM memory_candidates WHERE reason='uncertain-change' AND expires_at>?`)
  const scopedPendingCandidates = db.prepare(`SELECT c.source AS sourceId,c.start,c.end,c.proposal,c.expires_at AS expiresAt
    FROM memory_candidates c JOIN memory_sources s ON s.id=c.source
    WHERE c.reason='uncertain-change' AND c.expires_at>? AND s.withdrawn=0
      AND ((json_extract(c.proposal,'$.scope.kind')='user')
        OR (json_extract(c.proposal,'$.scope.kind')=? AND json_extract(c.proposal,'$.scope.id')=?))
    ORDER BY c.expires_at DESC,c.source,c.start LIMIT ?`)
  const pendingCandidate = db.prepare(`SELECT source AS sourceId,start,end,proposal,expires_at AS expiresAt
    FROM memory_candidates WHERE reason='uncertain-change' AND expires_at>? AND source=? AND start=? AND end=?`)
  const candidatesReferencing = db.prepare(`SELECT source AS sourceId,start,end,proposal,expires_at AS expiresAt
    FROM memory_candidates WHERE ${CANDIDATE_TARGET}=?`)
  const candidateReference = db.prepare(`SELECT 1 FROM memory_candidates WHERE ${CANDIDATE_TARGET}=? LIMIT 1`)
  const removeCandidate = db.prepare('DELETE FROM memory_candidates WHERE source=? AND start=? AND end=?')
  const discardUnused = (id: string) => db.prepare(`UPDATE memory_sources SET text=NULL,question=NULL WHERE id=?
    AND NOT EXISTS (SELECT 1 FROM memory_evidence WHERE source=?)
    AND NOT EXISTS (SELECT 1 FROM memory_candidates WHERE source=?)
    AND NOT EXISTS (SELECT 1 FROM memory_links WHERE source=?)`).run(id, id, id, id)
  /** Keep the original offsets and hash while discarding unrelated portions of received text. */
  function compactSource(id: string) {
    const source = readSource(id)
    if (!source?.text) return
    const evidence = (db.prepare('SELECT spans FROM memory_evidence WHERE source=?').all(id) as Array<{ spans: string }>)
      .flatMap(row => JSON.parse(row.spans) as MemoryEvidence['spans'])
    const changeRows = db.prepare('SELECT spans,old_value_spans AS oldValueSpans FROM memory_links WHERE source=?').all(id) as
      Array<{ spans: string, oldValueSpans: string }>
    const changes = changeRows.flatMap(row => [row.spans, row.oldValueSpans]
      .flatMap(encoded => JSON.parse(encoded) as MemoryEvidence['spans']))
    const candidates = (db.prepare('SELECT proposal FROM memory_candidates WHERE source=?').all(id) as Array<{ proposal: string }>)
      .flatMap(({ proposal }) => {
        const record = objectOf(JSON.parse(proposal))
        const spans = (objectOf(record?.proposal) ?? record)?.spans
        if (!Array.isArray(spans)) return []
        return spans.flatMap(raw => {
          const part = objectOf(raw)
          return typeof part?.start === 'number' && typeof part.end === 'number' ? [{ start: part.start, end: part.end }] : []
        })
      })
    const parts = [...evidence, ...changes, ...candidates].sort((left, right) => left.start - right.start)
    let end = 0
    const retained = []
    for (const part of parts) {
      if (part.end <= end) continue
      const start = Math.max(end, part.start)
      retained.push(' '.repeat(start - end), source.text.slice(start, part.end))
      end = part.end
    }
    const text = retained.join('')
    // When the remaining prefix is shorter, all retained spans still address identical UTF-16 positions.
    db.prepare('UPDATE memory_sources SET text=?,question=NULL WHERE id=?').run(text.trim() ? text : null, id)
  }
  function expire(retainSource: (id: string) => boolean = () => false) {
    const expired = db.prepare('SELECT DISTINCT source FROM memory_candidates WHERE expires_at<=?').all(now()) as Array<{ source: string }>
    if (expired.length) tx(() => {
      db.prepare('DELETE FROM memory_candidates WHERE expires_at<=?').run(now())
      for (const { source } of expired) if (!retainSource(source)) compactSource(source)
    })
  }
  const nextCandidateExpiry = () => (db.prepare('SELECT MIN(expires_at) AS at FROM memory_candidates').get() as { at: number | null }).at
  const clearCandidates = (id: string) => db.prepare('DELETE FROM memory_candidates WHERE source=?').run(id)
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

  const insertDependency = db.prepare('INSERT OR IGNORE INTO memory_session_dependencies VALUES (?, ?, ?, ?, ?)')
  const readDependencies = db.prepare('SELECT fact AS id, revision, as_of AS asOf, disputed FROM memory_session_dependencies WHERE session = ?')
  const addRelationDeadline = db.prepare(`INSERT INTO memory_session_relation_dependencies VALUES (?, ?, ?, ?)
    ON CONFLICT(session, fact, revision) DO UPDATE SET expires=MIN(expires,excluded.expires)`)
  const readRelationDeadlines = db.prepare('SELECT fact AS id, revision, expires AS expiresAt FROM memory_session_relation_dependencies WHERE session=?')
  const addProfileDependency = db.prepare(`INSERT INTO memory_session_profile_dependencies VALUES (?,?,?,?,?)
    ON CONFLICT(session,fact,revision,collection_revision) DO UPDATE SET expires=
      CASE WHEN expires IS NULL OR excluded.expires IS NULL THEN COALESCE(expires,excluded.expires) ELSE MIN(expires,excluded.expires) END`)
  const readProfileDependencies = db.prepare(`SELECT fact AS id, revision, collection_revision AS collectionRevision, expires
    FROM memory_session_profile_dependencies WHERE session=?`)
  const insertSessionFile = db.prepare('INSERT OR IGNORE INTO memory_session_file_dependencies VALUES (?, ?)')
  const readSessionFiles = db.prepare('SELECT reference FROM memory_session_file_dependencies WHERE session=? ORDER BY rowid')
  const insertSessionSource = db.prepare('INSERT OR IGNORE INTO memory_session_sources VALUES (?, ?)')
  const readSessionSources = db.prepare('SELECT source FROM memory_session_sources WHERE session = ?')
  const insertFileSource = db.prepare('INSERT OR IGNORE INTO memory_session_file_sources VALUES (?, ?)')
  const readFileSources = db.prepare(`SELECT source FROM memory_session_file_sources f WHERE session=?
    AND NOT EXISTS (SELECT 1 FROM memory_session_sources s WHERE s.session=f.session AND s.source=f.source) ORDER BY rowid`)
  const retainTurnOnly = db.prepare('INSERT OR IGNORE INTO memory_session_turn_only VALUES (?)')
  const usedTurnOnly = db.prepare('SELECT 1 FROM memory_session_turn_only WHERE session = ?')
  const dispatch = {
    replace(session: string, sources: readonly string[]) {
      tx(() => {
        for (const table of ['memory_session_dependencies', 'memory_session_sources', 'memory_session_turn_only',
          'memory_session_file_dependencies', 'memory_session_file_sources', 'memory_session_relation_dependencies', 'memory_session_profile_dependencies']) {
          db.prepare(`DELETE FROM ${table} WHERE session=?`).run(session)
        }
        for (const source of new Set(sources)) insertSessionSource.run(session, source)
        db.prepare('INSERT INTO memory_sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch').run(session, epoch())
      })
    },
    dependencies(session: string, dependencies: readonly MemoryDependency[]) {
      tx(() => {
        for (const item of dependencies) {
          if (item.collectionRevision !== undefined) addProfileDependency.run(session, item.id, item.revision, item.collectionRevision, item.expiresAt ?? null)
          else if (item.expiresAt !== undefined) addRelationDeadline.run(session, item.id, item.revision, item.expiresAt)
          else {
            // A civil date and its IANA zone together identify the day delivered by recall.
            const dated = item.asOf && item.asOfZone ? `${item.asOf}|${item.asOfZone}` : item.asOf ?? ''
            insertDependency.run(session, item.id, item.revision, dated, Number(item.disputed ?? false))
          }
        }
      })
    },
    files(session: string, files: readonly MemoryFileDependency[], sources: readonly string[] = []) {
      // Serialize a canonical field order; retain different scopes, versions and policies without overwriting.
      const references = files.map(file => JSON.stringify(memoryFileDependencySchema.parse(file)))
      if (sources.length && !references.length) throw new Error('File sources require file dependencies')
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
      const rows = readDependencies.all(session) as Array<{ id: number, revision: number, asOf: string, disputed: number }>
      const rawSources = (readSessionSources.all(session) as Array<{ source: string }>).map(row => row.source)
      const fileSources = (readFileSources.all(session) as Array<{ source: string }>).map(row => row.source)
      return {
        dependencies: [
          ...rows.map(row => {
            const [day, asOfZone] = row.asOf.split('|')
            return { ...row, asOf: day || undefined, ...(asOfZone ? { asOfZone } : {}), disputed: Boolean(row.disputed) }
          }),
          ...readRelationDeadlines.all(session) as Array<{ id: number, revision: number, expiresAt: number }>,
          ...(readProfileDependencies.all(session) as { id: number, revision: number, collectionRevision: number, expires: number | null }[])
            .map(({ expires, ...item }) => ({ ...item, ...(expires === null ? {} : { expiresAt: expires }) })),
        ],
        sources: [...rawSources, ...fileSources],
        ...(fileSources.length ? { fileSources } : {}),
        turnOnly: Boolean(usedTurnOnly.get(session)),
        ...(project ? { projects: [project] } : {}),
        epoch: epoch(),
        ...(files.length ? { files } : {}),
      }
    },
  }
  let temporaryFileRoot: string | undefined
  return { get fileRoot() {
    return file === ':memory:' ? temporaryFileRoot ??= fs.mkdtempSync(path.join(tmpdir(), 'viva-memory-files-'))
      : path.join(path.dirname(file), 'memory-files')
  }, db, tx, revision, epoch, nextRevision, get, exists: (id: number) => Boolean(exists.get(id)), list, listForScope, recentRecallRefs, relationRecallRefs, inactiveRecallRefs, profileCandidates, nextProfileBoundary, modelEligible, hasPendingEnding, pendingEndingsFor, sameText, getChange, listChanges, appliedChanges, changesFor, recordChange, setChangeStatus, projectChange, reviseDispute,
    readSource, insertSource, outcome, withdrawSource, eraseFileSource, fileErasures, evidence, storedEvidence, removeEvidence, bindEvidenceChange, updateEvidenceSpans, redactSource, clearSourceQuestions,
    insert, setAssertion, project, touch, authorize, remove, forgetEntry, restoreEntry, recordFact, setKeywords, touchChange,
    exclude, excluded, sourceExcluded, excludeSource, sourceIds, answerSourceIds, memoriesFrom, changesFrom, changesReferencing, hasChangeSource,
    deliveredSourceIds, deliveredSource, recordDeliveredSource, dispatch,
    priorSources, candidate, expire, clearCandidates, discardUnused, compactSource, nextCandidateExpiry,
    candidatesReferencing: (id: number) => candidatesReferencing.all(id) as unknown as MemoryCandidate[],
    hasCandidateReference: (id: number) => Boolean(candidateReference.get(id)),
    removeCandidate: ({ sourceId, start, end }: MemoryCandidate) => removeCandidate.run(sourceId, start, end),
    pendingChanges: (at: number) => pendingCandidates.all(at) as unknown as MemoryCandidate[],
    recallPendingChanges: (at: number, scope: MemoryScope | undefined, limit: number) =>
      scopedPendingCandidates.all(at, scope?.kind ?? 'user', scope && 'id' in scope ? scope.id : '', limit) as unknown as MemoryCandidate[],
    pendingChange: (at: number, ref: Pick<MemoryCandidate, 'sourceId' | 'start' | 'end'>) =>
      pendingCandidate.get(at, ref.sourceId, ref.start, ref.end) as unknown as MemoryCandidate | undefined,
    sessionEpoch, recordSession, sessionProject, recordSessionProject, meta, setMeta, profile, setProfile, command, recordCommand, close() {
      try { db.close() } finally { if (temporaryFileRoot) fs.rmSync(temporaryFileRoot, { recursive: true, force: true }) }
    } }
}
export type MemoryStore = ReturnType<typeof openMemoryStore>
