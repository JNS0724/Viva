import type { MemoryFileIndexChanges } from '../core/ports/runtime.ts'
import type { DailyAllocation, DailyFileRegistration, NoteRangeTurn } from '../core/ports/notes.ts'
import { truncateMemoryJournal } from './sqlite.ts'
import { documentSourceProofCurrent } from '../core/memory-source-proof.ts'
import type { MemoryPhysicalFile } from '../core/ports/documents.ts'
import { memoryFileRevision } from './memory-file-store.ts'
import { memorySourceWorkspace as workspaceOf, memorySourceToken as token } from './source-identity.ts'
import { fileErasure, openMemoryFileJournal } from './memory-file-journal.ts'
import type { FileReplacement, FileCheckpoint, FilePlan } from './memory-file-journal.ts'
import { formatMemoryDocument, parseMemoryDocument } from '../core/memory-document.ts'
import type { MemorySource, MemoryStore } from './memory-store.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'

export const dailyNoteKey = (session: string, day: string, workspace = '', generation = 0) =>
  JSON.stringify(generation ? [workspace, session, day, generation] : [workspace, session, day])
export const noteRangeId = (session: string, fromSeq: number, toSeq: number) =>
  memoryFileRevision(JSON.stringify([session, fromSeq, toSeq]))

function noteDay(key: string): string {
  const identity: unknown = JSON.parse(key)
  if (!Array.isArray(identity) || typeof identity[2] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(identity[2])) throw new Error('invalid-note-identity')
  if (identity.length !== 3 && (identity.length !== 4 || !Number.isSafeInteger(identity[3]) || identity[3] < 1)) throw new Error('invalid-note-identity')
  return identity[2]
}

type SourceRef = import('../core/ports/documents.ts').DocumentSourceRef
interface RangeRow {
  range_id: string
  note_key: string
  session: string
  workspace: string
  day: string
  from_seq: number
  to_seq: number
  turn: number
  sources_json: string
  source_tokens_json: string
  assistant_sources_json: string
  assistant_digest: string | null
  assistant_valid: number
  question_sources_json: string
  question_valid: number
  status: string
}
interface NoteRow { key: string, day: string, workspace: string, path: string, revision: number, processed: number, updatedAt: number, file_revision: string | null, enabled: number }
type Note = Omit<NoteRow, 'enabled'> & { file_revision: string, title: string, markdown: string, document: string, fileRevision: string, enabled: boolean }
type Data = { refs: SourceRef[], indexKeys?: string[] } & (
  | { kind: 'note', key: string, day: string, workspace: string, path: string | null, revision: number, expectedRevision: number | null, generation: number, at: number, rows: string[], contributed: boolean, fileRevision: string | null }
  | { kind: 'purge', id: number }
)

/**
 * Markdown files own Daily Note content; DSH session-persistence logs own conversation transcripts.
 * SQLite keeps identities, pending turn ranges, dependencies, and commit receipts (no session/dialog/*.jsonl).
 */
export function openMemoryNotes(store: MemoryStore, readable: (id: string) => boolean,
  checkpoint?: (point: FileCheckpoint, path?: string) => void, currentJob?: (key: string, generation: number) => boolean,
  options: { deferRecovery?: boolean, onCommitted?: () => void, index?: MemoryFileIndexChanges } = {}) {
  const db = store.db
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_note_erasures (source TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS memory_deleted_daily_notes (note TEXT PRIMARY KEY, base TEXT NOT NULL, public_id TEXT NOT NULL UNIQUE);
    CREATE INDEX IF NOT EXISTS memory_deleted_daily_notes_base ON memory_deleted_daily_notes(base);
    CREATE TABLE IF NOT EXISTS memory_note_ranges (
      range_id TEXT PRIMARY KEY,
      note_key TEXT NOT NULL,
      session TEXT NOT NULL,
      workspace TEXT NOT NULL,
      day TEXT NOT NULL,
      from_seq INTEGER NOT NULL,
      to_seq INTEGER NOT NULL,
      turn INTEGER NOT NULL DEFAULT 0,
      sources_json TEXT NOT NULL,
      source_tokens_json TEXT NOT NULL,
      assistant_sources_json TEXT NOT NULL,
      assistant_digest TEXT,
      assistant_valid INTEGER NOT NULL DEFAULT 1,
      question_sources_json TEXT NOT NULL,
      question_valid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(session, from_seq, to_seq)
    );
    CREATE INDEX IF NOT EXISTS memory_note_ranges_group ON memory_note_ranges(note_key, status);
    CREATE INDEX IF NOT EXISTS memory_note_ranges_session ON memory_note_ranges(session, workspace);
    CREATE TABLE IF NOT EXISTS memory_daily_notes (
      key TEXT PRIMARY KEY, day TEXT NOT NULL, workspace TEXT NOT NULL, path TEXT NOT NULL, file_revision TEXT,
      revision INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(workspace,path)
    );
    CREATE TABLE IF NOT EXISTS memory_note_sources (note TEXT NOT NULL, source TEXT NOT NULL, token TEXT NOT NULL, spans TEXT, PRIMARY KEY(note,source));
    CREATE INDEX IF NOT EXISTS memory_note_sources_by_source ON memory_note_sources(source,note);
    CREATE TABLE IF NOT EXISTS memory_note_purges (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, note TEXT NOT NULL, path TEXT, expected_revision TEXT);
  `)
  // In-memory assistant text fallback ONLY for standalone unit tests calling add() without DSH persistence.
  const ephemeralAssistants = new Map<string, string>()
  let syntheticSeq = 0

  const snapshot = (ids: readonly string[]): SourceRef[] => [...new Set(ids)].map(id => {
    const source = store.readSource(id)
    if (!source || !readable(id)) throw new Error('memory-source-version')
    return { id, token: token(source) }
  })
  function references(key: string): SourceRef[] {
    return (db.prepare('SELECT source AS id,token,spans FROM memory_note_sources WHERE note=? ORDER BY rowid').all(key) as Array<{ id: string, token: string, spans: string | null }>)
      .map(({ spans, ...ref }) => ({ ...ref, ...(spans ? { spans: JSON.parse(spans) as NonNullable<SourceRef['spans']> } : {}) }))
  }
  function validRef(ref: SourceRef): boolean {
    const source = store.readSource(ref.id)
    return Boolean(source?.text && readable(ref.id) && documentSourceProofCurrent(ref, source.text, token(source)))
  }
  const dailyPathBase = (day: string, key: string) => `daily/${day}/note-${memoryFileRevision(key)}`
  const rawNote = (key: string) => db.prepare('SELECT *,updated_at AS updatedAt FROM memory_daily_notes WHERE key=?').get(key) as NoteRow | undefined
  const deleted = (key: string) => Boolean(db.prepare('SELECT 1 FROM memory_deleted_daily_notes WHERE note=?').get(key))
  const publicNoteId = (key: string) => `daily:${memoryFileRevision(key)}`
  function indexTarget(data: Data) {
    return data.kind === 'note' && data.path ? publicNoteId(data.key) : null
  }
  function retireConsumedRanges(rangeIds: readonly string[], contributed: boolean) {
    if (!rangeIds.length) return
    const status = contributed ? 'written' : 'skipped'
    const sessions = new Map<string, { workspace: string, session: string }>()
    for (const rangeId of rangeIds) {
      const row = db.prepare('SELECT workspace, session FROM memory_note_ranges WHERE range_id=?').get(rangeId) as
        { workspace: string, session: string } | undefined
      db.prepare('UPDATE memory_note_ranges SET status=? WHERE range_id=?').run(status, rangeId)
      if (row) sessions.set(`${row.workspace}\0${row.session}`, row)
    }
    for (const { workspace, session } of sessions.values()) {
      const latest = db.prepare(`SELECT rowid, range_id
        FROM memory_note_ranges
        WHERE workspace=? AND session=? AND status IN ('written','skipped')
        ORDER BY rowid DESC LIMIT 1`).get(workspace, session) as
        { rowid: number, range_id: string } | undefined
      if (!latest) continue
      // Keep only the single latest consumed range per (workspace, session) for `previous()`.
      // Preserve its complete `assistant_sources_json` proof list intact so revoking an earlier
      // turn still invalidates `previousAssistant`; clear only `question_sources_json` since
      // `memory_sources` owns direct question metadata (§5.3 item 2).
      db.prepare(`UPDATE memory_note_ranges
        SET question_sources_json='[]'
        WHERE rowid=?`).run(latest.rowid)
      const retired = db.prepare(`SELECT range_id FROM memory_note_ranges
        WHERE workspace=? AND session=? AND status IN ('written','skipped') AND rowid<?`)
        .all(workspace, session, latest.rowid) as Array<{ range_id: string }>
      for (const old of retired) ephemeralAssistants.delete(old.range_id)
      db.prepare(`DELETE FROM memory_note_ranges
        WHERE workspace=? AND session=? AND status IN ('written','skipped') AND rowid<?`)
        .run(workspace, session, latest.rowid)
    }
  }
  const journal = openMemoryFileJournal<Data>({ db, root: store.fileRoot, checkpoint,
    afterCommit(data, workspace) {
      const id = indexTarget(data)
      if (id) options.index?.publish(workspace, id)
    },
    valid: data => (data.kind !== 'note' || !deleted(data.key)
      && (rawNote(data.key)?.revision ?? null) === data.expectedRevision
      && (!currentJob || currentJob(data.key, data.generation))) && data.refs.every(validRef),
    finish(data) {
      const id = indexTarget(data)
      const workspace = data.kind === 'note' ? data.workspace : undefined
      if (id && workspace) options.index?.queue({ workspace, id })
      if (data.kind === 'note') {
        if (data.path) db.prepare(`INSERT INTO memory_daily_notes(key,day,workspace,path,file_revision,revision,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET path=excluded.path,file_revision=excluded.file_revision,revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(data.key, data.day, data.workspace, data.path, data.fileRevision!, data.revision, data.at)
        if (data.contributed) {
          db.prepare('DELETE FROM memory_note_sources WHERE note=?').run(data.key)
          for (const ref of data.refs) db.prepare('INSERT INTO memory_note_sources(note,source,token,spans) VALUES(?,?,?,?)').run(data.key, ref.id, ref.token, ref.spans ? JSON.stringify(ref.spans) : null)
        }
        retireConsumedRanges(data.rows, data.contributed)
        if (data.path) options.onCommitted?.()
        for (const ref of data.refs) if (store.readSource(ref.id)?.outcome === 'note-pending') {
          store.outcome(ref.id, data.contributed ? 'note-ready' : 'note-skipped')
        }
      } else if (data.kind === 'purge') {
        const deletedNote = db.prepare(`SELECT d.public_id FROM memory_deleted_daily_notes d
          JOIN memory_note_purges p ON p.note=d.note WHERE p.id=?`).get(data.id)
        db.prepare('INSERT OR IGNORE INTO memory_note_erasures VALUES(?)').run(deletedNote ? `file:${deletedNote.public_id}` : `purge:${data.id}`)
        db.prepare('DELETE FROM memory_note_purges WHERE id=?').run(data.id)
      }
    },
  })
  function read(key: string, physical?: MemoryPhysicalFile | null): Note | undefined {
    const row = rawNote(key)
    if (!row?.file_revision || !journal.visible(row.workspace, row.path)) return
    const refs = references(key)
    if (!refs.every(validRef)) return
    let file: MemoryPhysicalFile | null
    if (physical === undefined) {
      try { file = journal.files(row.workspace).read(row.path) }
      catch { return undefined }
    } else {
      file = physical
    }
    if (!file || file.path !== row.path || file.revision !== row.file_revision) return
    try {
      const doc = parseMemoryDocument(file.markdown)
      const session = doc.metadata.session_id
      return { ...row, file_revision: file.revision, enabled: Boolean(row.enabled), title: String(doc.metadata.name ?? ''), markdown: doc.body,
        document: file.markdown, fileRevision: file.revision, ...(typeof session === 'string' ? { session } : {}) }
    } catch { return undefined }
  }

  const sourceIdsOf = (row: RangeRow) => JSON.parse(row.sources_json) as string[]

  function projectRange(row: RangeRow): NoteRangeTurn {
    const refs = JSON.parse(row.source_tokens_json) as SourceRef[]
    const activeSourceIds: string[] = []
    for (const ref of refs) {
      const source = store.readSource(ref.id)
      if (!source || source.text === null || source.outcome === 'rejected') continue
      if (token(source) === ref.token) {
        activeSourceIds.push(ref.id)
      } else {
        throw new Error('memory-source-version')
      }
    }
    const questionRefs = JSON.parse(row.question_sources_json) as SourceRef[]
    const questionCurrent = Boolean(row.question_valid && questionRefs.every(validRef))
    const dependencies = JSON.parse(row.assistant_sources_json) as SourceRef[]
    const assistantValid = Boolean(row.assistant_valid && row.assistant_digest && dependencies.every(validRef))
    const ephemeral = ephemeralAssistants.get(row.range_id) ?? ''
    const assistant = assistantValid && ephemeral && memoryFileRevision(ephemeral) === row.assistant_digest ? ephemeral : ''
    return {
      id: row.range_id,
      note: row.note_key,
      session: row.session,
      day: row.day,
      workspace: row.workspace,
      fromSeq: row.from_seq,
      toSeq: row.to_seq,
      turn: row.turn,
      sourceIds: activeSourceIds,
      assistantSourceIds: assistantValid ? dependencies.map(ref => ref.id) : [],
      assistantDigest: assistantValid ? row.assistant_digest : null,
      assistantValid,
      questionSourceIds: questionRefs.map(ref => ref.id),
      questionCurrent,
      assistant,
    }
  }

  function changes(workspace: string) {
    const files = journal.files(workspace)
    const edits = new Map<string, FileReplacement>()
    const indexKeys = new Set<string>()
    const put = (path: string, after: string | null) => {
      const before = files.read(path)?.markdown ?? null
      if (before !== after) edits.set(path, { path, before, after })
    }
    function index(day: string, extra?: { key: string, path: string, title: string }, removed?: string) {
      const registered = db.prepare('SELECT key,path FROM memory_daily_notes WHERE workspace=? AND day=? AND file_revision IS NOT NULL ORDER BY key')
        .all(workspace, day) as Array<{ key: string, path: string }>
      for (const row of registered) indexKeys.add(row.key)
      if (extra) indexKeys.add(extra.key)
      const cards = registered.filter(row => row.path !== removed && row.key !== extra?.key)
        .flatMap(row => {
          if (!journal.visible(workspace, row.path)) throw new Error('memory-index-pending')
          const content = read(row.key)
          return content ? [{ path: row.path, title: content.title }] : []
        })
      if (extra) cards.push(extra)
      cards.sort((a, b) => a.path.localeCompare(b.path))
      put(`daily/${day}.md`, formatMemoryDocument({ metadata: { name: day, description: `Daily notes: ${day}` },
        body: cards.map(card => `- [[${card.path}]]`).join('\n') + '\n' }))
    }
    return { files, edits, put, index, indexKeys }
  }
  type Purge = { id: number, note: string, workspace: string, path: string | null, expected_revision: string | null }
  const purges = () => db.prepare('SELECT * FROM memory_note_purges ORDER BY id').all() as Purge[]
  function purgePlan(purge: Purge): FilePlan<Data> | null {
    const edit = changes(purge.workspace)
    if (purge.path) {
      const owner = db.prepare('SELECT key FROM memory_daily_notes WHERE workspace=? AND path=?').get(purge.workspace, purge.path)
      if (!owner || owner.key === purge.note) {
        const observed = edit.files.read(purge.path)
        if (observed && purge.expected_revision && observed.revision !== purge.expected_revision) return null
        edit.put(purge.path, null)
      }
      edit.index(noteDay(purge.note), undefined, !owner || owner.key === purge.note ? purge.path : undefined)
    }
    const members = [...edit.edits.values()].map(change => change.path === purge.path ? fileErasure(change) : change)
    return { workspace: purge.workspace, changes: members, data: { kind: 'purge', refs: [], id: purge.id } }
  }
  function recover() {
    journal.recover()
    applyPurges(purges())
    checkpointCleanup()
  }
  function applyPurges(rows: Purge[]) {
    for (const purge of rows) {
      try {
        journal.commit(`purge:${purge.id}`, String(purge.id), () => {
          const plan = purgePlan(purge)
          if (!plan) throw new Error('memory-purge-version')
          return plan
        })
      } catch (error) {
        if (!(error instanceof Error && ['memory-purge-version', 'memory-file-plan-busy', 'memory-file-plan-conflict', 'memory-index-pending'].includes(error.message))) throw error
      }
    }
  }
  function checkpointCleanup() {
    if (db.prepare('SELECT 1 FROM memory_note_erasures LIMIT 1').get() && truncateMemoryJournal(db)) db.exec('DELETE FROM memory_note_erasures')
  }
  function deleteFile(workspace: string, key: string, expectedUsageVersion: number) {
    return store.tx(() => {
      const row = rawNote(key)
      if (!row || row.workspace !== workspace || row.revision !== expectedUsageVersion || !journal.visible(workspace, row.path)) throw new Error('memory-file-version')
      const [, session] = JSON.parse(key) as [string, string, string, number?]
      const publicId = `daily:${memoryFileRevision(key)}`
      db.prepare('INSERT INTO memory_deleted_daily_notes(note,base,public_id) VALUES(?,?,?)').run(key, dailyNoteKey(session, row.day, workspace), publicId)
      db.prepare('INSERT INTO memory_note_purges(workspace,note,path,expected_revision) VALUES(?,?,?,?)')
        .run(workspace, key, row.file_revision ? row.path : null, row.file_revision)
      db.prepare('DELETE FROM memory_note_sources WHERE note=?').run(key)
      db.prepare('DELETE FROM memory_daily_notes WHERE key=?').run(key)
      return row.revision + 1
    })
  }

  function addRange(input: {
    session: string
    day: string
    fromSeq: number
    toSeq: number
    turn: number
    sources: MemorySource[]
    assistantDigest: string | null
    assistantSources?: readonly string[]
    questionSources?: readonly string[]
    questionCurrent?: boolean
    ephemeralAssistant?: string
    rangeIdOverride?: string
  }): string | null {
    const { session, day, fromSeq, toSeq, turn, sources, assistantDigest } = input
    const workspace = workspaceOf(sources[0]!)
    if (sources.some(source => workspaceOf(source) !== workspace || source.session !== session)) throw new Error('memory-turn-scope')
    const base = dailyNoteKey(session, day, workspace)
    const generation = Number(db.prepare('SELECT count(*) AS n FROM memory_deleted_daily_notes WHERE base=?').get(base)!.n)
    const key = generation ? dailyNoteKey(session, day, workspace, generation) : base
    const rangeId = input.rangeIdOverride ?? noteRangeId(session, fromSeq, toSeq)
    const existing = db.prepare('SELECT assistant_digest FROM memory_note_ranges WHERE range_id=? OR (session=? AND from_seq=? AND to_seq=?)')
      .get(rangeId, session, fromSeq, toSeq) as { assistant_digest: string | null } | undefined
    if (existing) {
      if (input.rangeIdOverride && existing.assistant_digest !== assistantDigest) throw new Error('memory-request-input-mismatch')
      return null
    }
    const userRefs = snapshot(sources.map(source => source.id))
    const assistantRefs = assistantDigest ? snapshot([...sources.map(source => source.id), ...(input.assistantSources ?? [])]) : []
    const answers = sources.filter(source => source.author === 'answer')
    const hasQuestions = answers.length > 0
    const baseQuestionDeps = input.questionSources ?? []
    const baseQuestionAllReadable = baseQuestionDeps.every(readable)
    const questionCurrent = !hasQuestions || (input.questionCurrent === true && baseQuestionAllReadable && answers.every(source => Boolean(source.question)))
    const nonAnswerIds = sources.filter(source => source.author !== 'answer').map(source => source.id)
    const questionRefs = hasQuestions && questionCurrent ? snapshot([...nonAnswerIds, ...baseQuestionDeps]) : []
    db.prepare(`INSERT INTO memory_note_ranges(
      range_id, note_key, session, workspace, day, from_seq, to_seq, turn,
      sources_json, source_tokens_json, assistant_sources_json, assistant_digest, assistant_valid,
      question_sources_json, question_valid, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(
      rangeId, key, session, workspace, day, fromSeq, toSeq, turn,
      JSON.stringify(sources.map(source => source.id)),
      JSON.stringify(userRefs),
      JSON.stringify(assistantRefs),
      assistantDigest,
      assistantDigest ? 1 : 0,
      JSON.stringify(questionRefs),
      questionCurrent ? 1 : 0,
    )
    // Persist direct question-context metadata directly on each answer's memory_sources row so
    // sourceQuestionContext() survives range consumption and DSH session-log deletion (§5.3 item 2).
    if (hasQuestions) {
      for (let i = 0; i < sources.length; i++) {
        const answer = sources[i]!
        if (answer.author !== 'answer') continue
        const askedAt = answer.questionAt ?? answer.at
        const precedingIds = sources
          .filter((source, idx) => source.id !== answer.id
            && (source.author === 'answer'
              ? idx < i && (!answer.requestId || source.requestId !== answer.requestId)
              : source.at <= askedAt))
          .map(source => source.id)
        // Exclude rejected sibling cards sharing the same `requestId` (already shown together
        // before either card was answered), while still checking genuine prior prerequisites.
        const priorDeps = baseQuestionDeps.filter(depId => {
          if (!answer.requestId) return true
          const dep = store.readSource(depId)
          return !(dep?.author === 'answer' && dep.requestId === answer.requestId)
        })
        const depIds = [...precedingIds, ...priorDeps]
        const answerQuestionCurrent = input.questionCurrent === true && Boolean(answer.question) && depIds.every(readable)
        const answerQuestionRefs = answerQuestionCurrent ? snapshot(depIds) : []
        store.updateSourceQuestionContext?.(answer.id, answerQuestionCurrent, answerQuestionRefs)
      }
    }
    if (input.ephemeralAssistant && assistantDigest) {
      ephemeralAssistants.set(rangeId, input.ephemeralAssistant)
    }
    return key
  }

  if (!options.deferRecovery) recover()
  return {
    allocations: () => db.prepare('SELECT key,day,workspace,path,revision,updated_at AS updatedAt FROM memory_daily_notes ORDER BY workspace,key').all() as unknown as DailyAllocation[],
    fileRegistry: () => (db.prepare(`SELECT key,day,workspace,path,revision,updated_at AS updatedAt,file_revision AS fileRevision,enabled
      FROM memory_daily_notes WHERE file_revision IS NOT NULL`).all() as unknown as Array<Omit<DailyFileRegistration, 'enabled'> & { enabled: number }>)
      .map(row => ({ ...row, enabled: Boolean(row.enabled) })),
    noteRegistration(key: string) {
      const isDeleted = deleted(key)
      const row = rawNote(key)
      if (!row) return isDeleted ? { key, workspace: '', path: '', revision: 0, processed: 0, fileRevision: null, enabled: false, deleted: true } : null
      return {
        key: row.key, workspace: row.workspace, path: row.path, revision: row.revision, processed: row.processed,
        fileRevision: row.file_revision, enabled: Boolean(row.enabled), deleted: isDeleted,
      }
    },
    setEnabled: (key: string, revision: number, enabled: boolean) => db.prepare(`UPDATE memory_daily_notes SET enabled=?,revision=revision+1
      WHERE key=? AND revision=? AND enabled<>?`).run(Number(enabled), key, revision, Number(enabled)).changes === 1,
    deleteFile,
    registeredAt: (workspace: string, path: string) => db.prepare(
      'SELECT key,file_revision FROM memory_daily_notes WHERE workspace=? AND path=? AND file_revision IS NOT NULL',
    ).get(workspace, path) as { key: string, file_revision: string } | undefined,
    registeredForSources: (ids: readonly string[]) => db.prepare(`SELECT DISTINCT n.workspace,n.path
      FROM memory_note_sources s JOIN memory_daily_notes n ON n.key=s.note
      WHERE s.source IN (SELECT value FROM json_each(?)) AND n.file_revision IS NOT NULL ORDER BY n.workspace,n.key`).all(JSON.stringify(ids))
      .map(row => ({ workspace: String(row.workspace), path: String(row.path) })),
    registered: () => db.prepare('SELECT * FROM memory_daily_notes WHERE file_revision IS NOT NULL ORDER BY workspace,key').all().map(row => ({
      key: String(row.key), day: String(row.day), workspace: String(row.workspace), path: String(row.path),
      revision: Number(row.revision), processed: Number(row.processed), updatedAt: Number(row.updated_at),
      file_revision: String(row.file_revision), enabled: Boolean(row.enabled), sources: references(String(row.key)),
      state: db.prepare('SELECT 1 FROM memory_note_purges WHERE note=?').get(String(row.key)) ? 'withdrawing' as const : 'active' as const,
    })),
    needsRecovery: () => journal.needsRecovery(data => data.kind !== 'purge'),
    recoverDeletedFiles: () => { applyPurges(purges()); checkpointCleanup() },
    deletedFileCleanupPending: (workspace: string, id: string) => Boolean(db.prepare(`SELECT 1 FROM memory_deleted_daily_notes d
      WHERE public_id=? AND json_extract(d.note,'$[0]')=? AND (EXISTS (SELECT 1 FROM memory_note_purges p WHERE p.note=d.note)
      OR EXISTS (SELECT 1 FROM memory_note_erasures WHERE source=?))`).get(id, workspace, `file:${id}`)),
    checkpointCleanup,
    pendingCleanup: () => Number(db.prepare('SELECT (SELECT count(*) FROM memory_note_purges)+(SELECT count(*) FROM memory_note_erasures) AS n').get()?.n ?? 0),
    recover, read, snapshot, references,
    jobState: (key: string, generation: number) => journal.state(`note:${memoryFileRevision(key)}:${generation}`),
    blocked: (key: string) => Boolean(db.prepare('SELECT 1 FROM memory_note_purges WHERE note=?').get(key) || rawNote(key)?.file_revision && !read(key)),
    contextSources(session: string, source: MemorySource, excludeIds?: ReadonlySet<string>): string[] | null {
      // Bound dependency capture to O(1) rows read and stored per turn even under deep pending
      // backlogs (e.g. when no Note model is configured). Lazy `.iterate()` stops at the 17th
      // matching workspace source and fails closed (returns null) instead of scanning all N rows.
      const MAX_CONTEXT_SOURCES = 16
      const targetWorkspace = workspaceOf(source)
      const stmt = db.prepare('SELECT id, scope, context, project FROM memory_sources WHERE session=? ORDER BY rowid DESC')
      const ids: string[] = []
      for (const raw of stmt.iterate(session)) {
        const row = raw as { id: string, scope: string, context: string | null, project: string | null }
        if (excludeIds ? excludeIds.has(row.id) : row.id === source.id) continue
        const rowWorkspace = workspaceOf({
          ...source,
          scope: JSON.parse(row.scope) as MemorySource['scope'],
          context: row.context ? JSON.parse(row.context) as NonNullable<MemorySource['context']> : null,
          project: row.project ? JSON.parse(row.project) as NonNullable<MemorySource['project']> : null,
        })
        if (rowWorkspace !== targetWorkspace) continue
        ids.push(row.id)
        if (ids.length > MAX_CONTEXT_SOURCES) return null
      }
      return ids
    },
    hasRange: (session: string, fromSeq: number, toSeq: number) =>
      Boolean(db.prepare('SELECT 1 FROM memory_note_ranges WHERE session=? AND from_seq=? AND to_seq=?').get(session, fromSeq, toSeq)),
    addRange,
    add(session: string, day: string, sources: MemorySource[], assistant: string, requestId = sources[0]!.id, assistantSources: readonly string[] = [], _inputAssistant = assistant, options: { questionSources?: readonly string[], questionCurrent?: boolean } = {}) {
      const minSeq = Number((db.prepare('SELECT COALESCE(MIN(from_seq), 0) AS m FROM memory_note_ranges WHERE session=?').get(session) as { m: number }).m)
      syntheticSeq = Math.min(syntheticSeq, minSeq) - 1
      return store.tx(() => addRange({
        session, day, fromSeq: syntheticSeq, toSeq: syntheticSeq, turn: 0, sources,
        assistantDigest: assistant ? memoryFileRevision(assistant) : null,
        assistantSources,
        questionSources: options.questionSources,
        questionCurrent: options.questionCurrent,
        ephemeralAssistant: assistant,
        rangeIdOverride: requestId,
      }))
    },
    list(from: string | null, through: string | null) {
      return (db.prepare('SELECT key FROM memory_daily_notes WHERE file_revision IS NOT NULL AND (? IS NULL OR day>=?) AND (? IS NULL OR day<=?) ORDER BY day,key')
        .all(from, from, through, through) as Array<{ key: string }>).flatMap(row => read(row.key) ?? [])
    },
    changedFiles(from: string, through: string) {
      return db.prepare('SELECT key, workspace, path FROM memory_daily_notes WHERE file_revision IS NOT NULL AND enabled=1 AND day BETWEEN ? AND ? AND revision>processed ORDER BY day,key')
        .all(from, through) as Array<{ key: string, workspace: string, path: string }>
    },
    pendingGroups: () => db.prepare("SELECT note_key AS note,session,day,COUNT(*) AS count FROM memory_note_ranges WHERE status='pending' AND note_key NOT IN (SELECT note FROM memory_deleted_daily_notes) GROUP BY note_key,session,day")
      .all() as Array<{ note: string, session: string, day: string, count: number }>,
    pending: (key: string, limit: number = defaults.noteInterval) => deleted(key) ? []
      : (db.prepare("SELECT * FROM memory_note_ranges WHERE note_key=? AND status='pending' ORDER BY rowid LIMIT ?")
        .all(key, limit) as unknown as RangeRow[]).map(projectRange),
    previous(_key: string, id: string) {
      const row = db.prepare(`SELECT * FROM memory_note_ranges
        WHERE workspace=(SELECT workspace FROM memory_note_ranges WHERE range_id=?)
          AND session=(SELECT session FROM memory_note_ranges WHERE range_id=?)
          AND rowid<(SELECT rowid FROM memory_note_ranges WHERE range_id=?)
          AND note_key NOT IN (SELECT note FROM memory_deleted_daily_notes)
        ORDER BY rowid DESC LIMIT 1`)
        .get(id, id, id) as RangeRow | undefined
      if (!row) return undefined
      try { return projectRange(row) } catch (error) {
        if (error instanceof Error && error.message === 'memory-source-version') return undefined
        throw error
      }
    },
    sourceQuestionContext(sourceId: string) {
      // Read directly from persisted memory_sources metadata so it survives memory_note_ranges consumption
      // and deletion of DSH session logs (§5.3 item 2).
      const source = store.readSource(sourceId)
      if (!source || !source.questionValid) return { current: false, refs: [] }
      const refs = source.questionSources ?? []
      return { current: refs.every(validRef), refs }
    },
    sources(key: string) {
      return (db.prepare('SELECT source FROM memory_note_sources WHERE note=? ORDER BY rowid').all(key) as Array<{ source: string }>).map(row => row.source)
    },
    finish(rows: Array<{ id: string }>, contributed: boolean) {
      retireConsumedRanges(rows.map(row => row.id), contributed)
      for (const row of rows) {
        if (!db.prepare('SELECT 1 FROM memory_note_ranges WHERE range_id=?').get(row.id)) {
          ephemeralAssistants.delete(row.id)
        }
      }
    },
    commit(key: string, rows: Array<{ id: string }>, reply: { status: 'skip' } | { status: 'write', title: string, markdown: string, filename?: string },
      generation: number, at: number, refs: SourceRef[], expected: Note | undefined) {
      if (deleted(key)) return false
      const first = db.prepare('SELECT * FROM memory_note_ranges WHERE range_id=?').get(rows[0]!.id) as unknown as RangeRow
      const id = `note:${memoryFileRevision(key)}:${generation}`
      const input = memoryFileRevision(JSON.stringify([key, rows.map(row => row.id), refs, expected?.fileRevision, expected?.revision]))
      return journal.commit(id, input, () => {
        const allocation = rawNote(key), current = read(key)
        if (allocation?.file_revision && !current) throw new Error('memory-file-version')
        if (current?.enabled === false || current?.fileRevision !== expected?.fileRevision || current?.revision !== expected?.revision) throw new Error('memory-file-version')
        const edit = changes(first.workspace)
        let path: string | null = null, fileRevision: string | null = null
        if (reply.status === 'write') {
          path = allocation ? allocation.path : `${dailyPathBase(first.day, key)}.md`
          const base = path.slice(0, -3)
          if (allocation && !current && edit.files.read(path)) throw new Error('memory-file-version')
          let suffix = 1
          while (!allocation && (edit.files.read(path) || db.prepare('SELECT 1 FROM memory_daily_notes WHERE workspace=? AND path=?').get(first.workspace, path))) {
            path = `${base}-${suffix++}.md`
          }
          const old = current ? parseMemoryDocument(edit.files.read(current.path)!.markdown).metadata : {}
          const metadata: Record<string, unknown> = { ...old, name: reply.title, description: reply.title, session_id: first.session }
          delete metadata.source_conversation
          edit.put(path, formatMemoryDocument({ metadata, body: reply.markdown }))
          fileRevision = memoryFileRevision(edit.edits.get(path)?.after ?? edit.files.read(path)!.markdown)
          edit.index(first.day, { key, path, title: reply.title })
        }
        return { workspace: first.workspace, changes: [...edit.edits.values()], data: {
          kind: 'note', indexKeys: [...edit.indexKeys], key, day: first.day, workspace: first.workspace, path, revision: Math.max(generation, (allocation?.revision ?? 0) + 1), expectedRevision: allocation?.revision ?? null, generation, at, rows: rows.map(row => row.id),
          contributed: reply.status === 'write', refs, fileRevision,
        } }
      })
    },
    markProcessed(key: string, revision: number) {
      return Number(db.prepare('UPDATE memory_daily_notes SET processed=? WHERE key=? AND revision=? AND processed<>revision').run(revision, key, revision).changes) > 0
    },
  }
}
