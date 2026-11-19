import type { MemoryFileIndexChanges } from '../core/ports/runtime.ts'
import type { DailyAllocation, DailyFileRegistration } from '../core/ports/notes.ts'
import { openMemoryFileRestrictions } from './memory-file-restrictions.ts'
import { truncateMemoryJournal } from './sqlite.ts'
import { documentSourceProofCurrent, documentSourceRestricted, erasedDocumentSource, projectDocumentSource } from '../core/memory-document-restrictions.ts'
import { dailyPath } from '../contracts/memory-file-contract.ts'
import type { DocumentRename, DocumentSourceCut, DocumentExternalEdit, DocumentSupersession, MemoryPhysicalFile } from '../core/ports/documents.ts'
import { memoryFileRevision } from './memory-file-store.ts'
import { memorySourceWorkspace as workspaceOf, memorySourceToken as token } from './source-identity.ts'
import { fileErasure, openMemoryFileJournal } from './memory-file-journal.ts'
import type { FileReplacement, FileCheckpoint, FilePlan } from './memory-file-journal.ts'
import { formatMemoryDocument, parseMemoryDocument, memoryDocumentLines, readMemoryLines } from '../core/memory-document.ts'
import type { MemorySource, MemoryStore } from './memory-store.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'

export const dailyNoteKey = (session: string, day: string, workspace = '', generation = 0) =>
  JSON.stringify(generation ? [workspace, session, day, generation] : [workspace, session, day])
function noteDay(key: string): string {
  const identity: unknown = JSON.parse(key)
  if (!Array.isArray(identity) || typeof identity[2] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(identity[2])) throw new Error('invalid-note-identity')
  if (identity.length !== 3 && (identity.length !== 4 || !Number.isSafeInteger(identity[3]) || identity[3] < 1)) throw new Error('invalid-note-identity')
  return identity[2]
}
const sessionPath = (session: string) => `session/dialog/${memoryFileRevision(session)}.jsonl`
// Root date files are generated navigation for every day, never card identities.
const isDailyIndexPath = (path: string) => /^daily\/\d{4}-\d{2}-\d{2}\.md$/u.test(path)
type SourceRef = import('../core/ports/documents.ts').DocumentSourceRef
type DialogTurn = { id: string, session: string, day: string, messages: Array<{
  role: 'user' | 'assistant', text: string, sourceId?: string, version?: number, author?: MemorySource['author'], at: number,
}> }
type DialogPurge = { session: string, turn: string, mode: string, source: string | null }
type DialogCut = DocumentSourceCut & { turnIds: string[] }
function purgeDialog(text: string, purge: DialogPurge): string | null {
  const cut = purge.mode === 'redact' ? JSON.parse(purge.source!) as DialogCut : null
  const turns = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as DialogTurn)
  if (cut && turns.some(row => !cut.turnIds.includes(row.id) && row.messages.some(message => message.sourceId === cut.id))) {
    throw new Error('memory-purge-version')
  }
  const rows = turns.flatMap(row => {
    if (row.id !== purge.turn) return [row]
    if (purge.mode === 'remove') return []
    const messages = row.messages.flatMap(message => {
      if (message.role === 'assistant') return []
      if (!cut) return message.sourceId === purge.source ? [] : [message]
      if (message.sourceId !== cut.id) return [message]
      if (message.version !== cut.version || message.text.length !== cut.length || memoryFileRevision(message.text) !== cut.hash) {
        throw new Error('memory-purge-version')
      }
      const projected = projectDocumentSource(message.text, cut, [cut])
      return [{ ...message, text: projected, version: cut.version + 1 }]
    })
    return messages.length ? [{ ...row, messages }] : []
  })
  return rows.length ? rows.map(row => JSON.stringify(row)).join('\n') + '\n' : null
}
interface TurnRow { id: string, note: string, session: string, day: string, workspace: string, sources: string, source_tokens: string, assistant_sources: string, assistant_digest: string | null, assistant_valid: number, question_sources: string, question_valid: number, written: number }
interface NoteRow { key: string, day: string, workspace: string, path: string, revision: number, processed: number, updatedAt: number, file_revision: string | null }
type Note = NoteRow & { file_revision: string, title: string, markdown: string, document: string, fileRevision: string }
type Data = { refs: SourceRef[], indexKeys?: string[] } & (
  | { kind: 'turn', row: TurnRow }
  | { kind: 'note', key: string, day: string, workspace: string, path: string | null, revision: number, expectedRevision: number | null, policyToken: string, generation: number, at: number, rows: string[], contributed: boolean, fileRevision: string | null, previousRefs: SourceRef[], remove?: boolean, clearAliases?: boolean }
  | { kind: 'edit', key: string, workspace: string, path: string, revision: number, fileRevision: string, observedRevision: string, at: number, input: DocumentExternalEdit }
  | { kind: 'rename', key: string, workspace: string, from: string, to: string, revision: number, fileRevision: string, at: number, input: DocumentRename }
  | { kind: 'purge', id: number, dialog: DialogPurge }
  | { kind: 'restore', key: string, path: string, revision: string, markdown: string }
)

/** Markdown/JSONL own content. SQLite keeps identities, dependencies, pending work and commit receipts. */
export function openMemoryNotes(store: MemoryStore, readable: (id: string) => boolean,
  checkpoint?: (point: FileCheckpoint, path?: string) => void, currentJob?: (key: string, generation: number) => boolean, onRenamed: (input: DocumentRename) => void = () => {}, onExternalEdit: (input: DocumentExternalEdit) => void = () => {},
  externalCurrent: (input: DocumentExternalEdit) => boolean = () => false, options: { deferRecovery?: boolean, onCommitted?: () => void, index?: MemoryFileIndexChanges } = {}) {
  const db = store.db
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_note_erasures (source TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS memory_deleted_daily_notes (note TEXT PRIMARY KEY, base TEXT NOT NULL, public_id TEXT NOT NULL UNIQUE);
    CREATE INDEX IF NOT EXISTS memory_deleted_daily_notes_base ON memory_deleted_daily_notes(base);
    CREATE TABLE IF NOT EXISTS memory_note_aliases (workspace TEXT NOT NULL,path TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(workspace,path));
    CREATE TABLE IF NOT EXISTS memory_note_turns (
      id TEXT PRIMARY KEY, note TEXT NOT NULL, session TEXT NOT NULL, day TEXT NOT NULL,
      workspace TEXT NOT NULL, sources TEXT NOT NULL, source_tokens TEXT NOT NULL, assistant_sources TEXT NOT NULL, assistant_digest TEXT, assistant_valid INTEGER NOT NULL DEFAULT 1, question_sources TEXT NOT NULL, question_valid INTEGER NOT NULL, written INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memory_note_turns_group ON memory_note_turns(note,written);
    CREATE TABLE IF NOT EXISTS memory_daily_notes (
      key TEXT PRIMARY KEY, day TEXT NOT NULL, workspace TEXT NOT NULL, path TEXT NOT NULL, file_revision TEXT,
      revision INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      UNIQUE(workspace,path)
    );
    CREATE TABLE IF NOT EXISTS memory_note_sources (note TEXT NOT NULL, source TEXT NOT NULL, token TEXT NOT NULL, spans TEXT, PRIMARY KEY(note,source));
    CREATE INDEX IF NOT EXISTS memory_note_sources_by_source ON memory_note_sources(source,note);
    CREATE TABLE IF NOT EXISTS memory_note_purges (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, note TEXT NOT NULL, path TEXT, expected_revision TEXT, session TEXT NOT NULL, turn TEXT NOT NULL, mode TEXT NOT NULL, source TEXT);
  `)
  const snapshot = (ids: readonly string[]): SourceRef[] => [...new Set(ids)].map(id => {
    const source = store.readSource(id)
    if (!source || !readable(id)) throw new Error('memory-source-version')
    return { id, token: token(source) }
  })
  function references(key: string): SourceRef[] {
    return (db.prepare('SELECT source AS id,token,spans FROM memory_note_sources WHERE note=? ORDER BY rowid').all(key) as Array<{id:string,token:string,spans:string|null}>).map(({spans,...ref}) => ({...ref,...(spans ? {spans:JSON.parse(spans) as NonNullable<SourceRef['spans']>} : {})}))
  }
  function validRef(ref: SourceRef): boolean {
    const source = store.readSource(ref.id)
    return Boolean(source?.text && readable(ref.id) && documentSourceProofCurrent(ref, source.text, token(source), erasedDocumentSource(source)))
  }
  const useRestrictions = openMemoryFileRestrictions(db)
  const restrictions = (workspace: string) => [...store.fileErasures(workspace), ...useRestrictions.sources(workspace)]
  const usePolicyToken = (workspace: string) => memoryFileRevision(JSON.stringify(restrictions(workspace)))
  const dailyPathBase = (day: string, key: string) => `daily/${day}/note-${memoryFileRevision(key)}`
  function canonicalLocator(path: string, day: string, key: string) {
    const base = dailyPathBase(day, key)
    return path === `${base}.md` || path.startsWith(`${base}-`) && /^-[0-9]+\.md$/u.test(path.slice(base.length))
  }
  function requiresOpaqueLocator(workspace: string, key: string): boolean {
    const blocked = restrictions(workspace)
    if (!blocked.length) return false
    if (useRestrictions.forTarget({ kind: 'daily', workspace, key }).length) return true
    const turns = db.prepare('SELECT source_tokens,assistant_sources,question_sources FROM memory_note_turns WHERE note=?')
      .all(key) as Pick<TurnRow, 'source_tokens' | 'assistant_sources' | 'question_sources'>[]
    return [...references(key), ...turns.flatMap(row => [row.source_tokens, row.assistant_sources, row.question_sources]
      .flatMap(value => JSON.parse(value) as SourceRef[]))].some(ref => documentSourceRestricted(ref, blocked))
  }
  const rawNote = (key: string) => db.prepare('SELECT *,updated_at AS updatedAt FROM memory_daily_notes WHERE key=?').get(key) as NoteRow | undefined
  const deleted = (key: string) => Boolean(db.prepare('SELECT 1 FROM memory_deleted_daily_notes WHERE note=?').get(key))
  const publicNoteId = (key: string) => `daily:${memoryFileRevision(key)}`
  function indexTarget(data: Data) {
    return data.kind === 'note' && (data.path || data.remove) || data.kind === 'edit' || data.kind === 'rename' || data.kind === 'restore'
      ? publicNoteId(data.key) : null
  }
  const journal = openMemoryFileJournal<Data>({ db, root: store.fileRoot, checkpoint,
    afterCommit(data, workspace) {
      const id = indexTarget(data)
      if (id) options.index?.publish(workspace, id)
    },
    projectErasure(data, path, before) {
      if (data.kind === 'restore' && path === data.path) return data.markdown
      if (data.kind === 'purge' && path === sessionPath(data.dialog.session)) return purgeDialog(before, data.dialog)
    },
    valid: data => (data.kind !== 'edit' || validExternalEdit(data)) && (data.kind !== 'rename' || validRename(data))
      && (data.kind !== 'note' || !deleted(data.key) && (rawNote(data.key)?.revision ?? null) === data.expectedRevision
        && usePolicyToken(data.workspace) === data.policyToken && (!currentJob || currentJob(data.key, data.generation)))
      && (data.kind !== 'restore' || rawNote(data.key)?.file_revision === data.revision)
      && data.refs.every(validRef),

    finish(data) {
      const id = indexTarget(data)
      const workspace = data.kind === 'restore' ? rawNote(data.key)?.workspace : 'workspace' in data ? data.workspace : undefined
      if (id && workspace) options.index?.queue({ workspace, id })
      if (data.kind === 'turn') {
        const row = data.row
        db.prepare(`INSERT INTO memory_note_turns(id,note,session,day,workspace,sources,source_tokens,assistant_sources,assistant_digest,question_sources,question_valid)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.note, row.session, row.day, row.workspace, row.sources, row.source_tokens,
          row.assistant_sources, row.assistant_digest, row.question_sources, row.question_valid)
      } else if (data.kind === 'note') {
        if (data.remove) {
          // Keep the allocation when a safe rebuild has no usable content. The
          // next projection of the same session/day still belongs at this path.
          db.prepare("UPDATE memory_daily_notes SET file_revision=NULL,revision=?,updated_at=? WHERE key=?")
            .run(data.revision, data.at, data.key)
        }
        if (data.path) db.prepare(`INSERT INTO memory_daily_notes(key,day,workspace,path,file_revision,revision,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET path=excluded.path,file_revision=excluded.file_revision,revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(data.key, data.day, data.workspace, data.path, data.fileRevision!, data.revision, data.at)
        if (data.clearAliases) db.prepare('DELETE FROM memory_note_aliases WHERE note=?').run(data.key)
        if (data.contributed || data.remove) {
          db.prepare('DELETE FROM memory_note_sources WHERE note=?').run(data.key)
          if (!data.remove) for (const ref of data.refs) db.prepare('INSERT INTO memory_note_sources(note,source,token,spans) VALUES(?,?,?,?)').run(data.key, ref.id, ref.token, ref.spans ? JSON.stringify(ref.spans) : null)
        }
        for (const id of data.rows) db.prepare('UPDATE memory_note_turns SET written=? WHERE id=?').run(data.contributed ? 1 : 2, id)
        if (data.path || data.remove) options.onCommitted?.()
        for (const ref of data.refs) if (store.readSource(ref.id)?.outcome === 'note-pending') {
          store.outcome(ref.id, data.contributed ? 'note-ready' : 'note-skipped')
        }
      } else if (data.kind === 'edit') {
        db.prepare('UPDATE memory_daily_notes SET file_revision=?,revision=revision+1,updated_at=? WHERE key=?').run(data.observedRevision,data.at,data.key)
        db.prepare('DELETE FROM memory_note_sources WHERE note=?').run(data.key)
        for (const ref of data.refs) db.prepare('INSERT INTO memory_note_sources(note,source,token,spans) VALUES(?,?,?,?)')
          .run(data.key,ref.id,ref.token,ref.spans ? JSON.stringify(ref.spans) : null)
        onExternalEdit(data.input)
      } else if (data.kind === 'rename') {
        db.prepare('UPDATE memory_daily_notes SET path=?,revision=revision+1,updated_at=? WHERE key=?').run(data.to,data.at,data.key)
        db.prepare('INSERT OR REPLACE INTO memory_note_aliases VALUES(?,?,?)').run(data.workspace,data.from,data.key)
        onRenamed(data.input)
      } else if (data.kind === 'purge') {
        const deletedNote = data.dialog.mode === 'file' && db.prepare(`SELECT d.public_id FROM memory_deleted_daily_notes d
          JOIN memory_note_purges p ON p.note=d.note WHERE p.id=?`).get(data.id)
        db.prepare('INSERT OR IGNORE INTO memory_note_erasures VALUES(?)').run(deletedNote ? `file:${deletedNote.public_id}` : `purge:${data.id}`)
        db.prepare('DELETE FROM memory_note_purges WHERE id=?').run(data.id)
      }
    },
  })
  function validExternalEdit(data: Extract<Data,{kind:'edit'}>): boolean {
    const row=rawNote(data.key)
    if (!row?.file_revision || row.workspace!==data.workspace || row.path!==data.path || row.revision!==data.revision || row.file_revision!==data.fileRevision || !externalCurrent(data.input) || db.prepare('SELECT 1 FROM memory_note_purges WHERE note=?').get(data.key)) return false
    const observed=journal.files(data.workspace).read(data.path)
    if (!observed || observed.revision!==data.observedRevision) return false
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_documents'").get()) {
      const anchors=db.prepare('SELECT corrections FROM memory_documents WHERE workspace=?').all(data.workspace)
        .flatMap(item=>JSON.parse(String(item.corrections)) as DocumentSupersession[]).filter(item=>item.sourceDocumentId===data.key)
      if (anchors.some(item=>item.endLine>memoryDocumentLines(observed.markdown).length || readMemoryLines(observed.markdown,item.startLine,item.endLine)!==item.text)) return false
    }
    return true
  }
  function reconcileEdit(input: DocumentExternalEdit): boolean {
    const row=rawNote(input.id)
    if (!row?.file_revision || row.workspace!==input.workspace || row.path!==input.path || row.file_revision!==input.expectedRevision || row.revision!==input.expectedUsageVersion || row.file_revision===input.observedRevision || !journal.visible(input.workspace,row.path) || !input.sources.length || input.corrections?.length || input.action==='CORRECT') return false
    const data:Extract<Data,{kind:'edit'}>={kind:'edit',key:row.key,workspace:row.workspace,path:row.path,revision:row.revision,fileRevision:row.file_revision,observedRevision:input.observedRevision,at:Date.now(),input,refs:input.sources}
    if (!validExternalEdit(data) || !data.refs.every(validRef)) return false
    return journal.commit(`external-edit:${input.operationId}`,memoryFileRevision(JSON.stringify(input)),()=>{
      const edit=changes(input.workspace),file=edit.files.read(row.path)!
      parseMemoryDocument(file.markdown)
      edit.index(row.day,{key:row.key,path:row.path,title:String(parseMemoryDocument(file.markdown).metadata.name ?? '')})
      edit.edits.set(row.path,{path:row.path,before:file.markdown,after:file.markdown})
      return {workspace:row.workspace,changes:[...edit.edits.values()],data: { ...data, indexKeys: [...edit.indexKeys] }}
    })
  }
  function validRename(data: Extract<Data,{kind:'rename'}>): boolean {
    if (isDailyIndexPath(data.from) || isDailyIndexPath(data.to)) return false
    const row=rawNote(data.key)
    if (!row?.file_revision || row.path!==data.from || row.revision!==data.revision || row.file_revision!==data.fileRevision) return false
    if (requiresOpaqueLocator(data.workspace, data.key) && !canonicalLocator(data.to, row.day, row.key)) return false
    const files=journal.files(data.workspace)
    return !files.read(data.from) && files.read(data.to)?.revision===data.fileRevision && !db.prepare('SELECT 1 FROM memory_note_purges WHERE note=?').get(data.key)
  }
  function reconcileRename(input: DocumentRename): boolean {
    dailyPath.parse(input.from); dailyPath.parse(input.to)
    if (isDailyIndexPath(input.from) || isDailyIndexPath(input.to)) return false
    const row=rawNote(input.id)
    if (!row?.file_revision || row.workspace!==input.workspace || row.path!==input.from || row.revision!==input.usageVersion || row.file_revision!==input.revision) return false
    if (db.prepare('SELECT 1 FROM memory_daily_notes WHERE workspace=? AND path=?').get(input.workspace,input.to) || !journal.visible(input.workspace,input.from) || !journal.visible(input.workspace,input.to)) return false
    const data: Extract<Data,{kind:'rename'}>={kind:'rename',key:row.key,workspace:row.workspace,from:input.from,to:input.to,revision:row.revision,fileRevision:row.file_revision,at:Date.now(),input,refs:references(row.key)}
    if (!validRename(data) || !data.refs.every(validRef)) return false
    return journal.commit(`rename:${input.operationId}`,memoryFileRevision(JSON.stringify(input)),()=>{
      const edit=changes(input.workspace), file=edit.files.read(input.to)!
      edit.index(row.day,{key:row.key,path:input.to,title:String(parseMemoryDocument(file.markdown).metadata.name ?? '')})
      // Both paths participate in the journal reservation and restart validation, even though their contents stay unchanged.
      edit.edits.set(input.from,{path:input.from,before:null,after:null})
      edit.edits.set(input.to,{path:input.to,before:file.markdown,after:file.markdown})
      return {workspace:row.workspace,changes:[...edit.edits.values()],data: { ...data, indexKeys: [...edit.indexKeys] }}
    })
  }
  function read(key: string, physical?: MemoryPhysicalFile | null): Note | undefined {
    const row = rawNote(key)
    if (!row?.file_revision || !journal.visible(row.workspace, row.path)) return
    const refs = references(key)
    if (!refs.every(validRef)) return
    try {
      const file = physical === undefined ? journal.files(row.workspace).read(row.path) : physical
      if (!file || file.path !== row.path || file.revision !== row.file_revision) return
      const doc = parseMemoryDocument(file.markdown)
      return { ...row, file_revision: file.revision, title: String(doc.metadata.name ?? ''), markdown: doc.body, document: file.markdown, fileRevision: file.revision }
    } catch { return undefined } // One malformed or externally replaced file cannot hide unrelated accepted notes.

  }
  function dialog(workspace: string, session: string): DialogTurn[] {
    const text = journal.files(workspace).read(sessionPath(session))?.markdown ?? ''
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as DialogTurn)
  }
  const sourceIds = (row: TurnRow) => JSON.parse(row.sources) as string[]
  function turn(row: TurnRow) {
    const refs = JSON.parse(row.source_tokens) as SourceRef[]
    const invalid = refs.filter(ref => { const source = store.readSource(ref.id); return !source || token(source) !== ref.token })
    if (!journal.visible(row.workspace, sessionPath(row.session))) throw new Error('memory-session-pending')
    const saved = dialog(row.workspace, row.session).find(item => item.id === row.id)
    if (!saved) throw new Error('memory-session-missing')
    const questionRefs = JSON.parse(row.question_sources) as SourceRef[]
    const questionCurrent = Boolean(row.question_valid && questionRefs.every(validRef))
    const invalidAnswers = new Set(!questionCurrent ? saved.messages.filter(message => message.role === 'user' && message.author === 'answer').map(message => message.sourceId) : [])
    if (invalid.some(ref => !invalidAnswers.has(ref.id))) throw new Error('memory-source-version')
    const omitted = new Set(invalid.map(ref => ref.id))
    const dependencies = JSON.parse(row.assistant_sources) as SourceRef[]
    const assistant = saved.messages.filter(item => item.role === 'assistant').map(item => item.text).join('\n\n')
    // User prose comes from the canonical store. Generated context is eligible
    // only while the session copy matches the accepted intake.
    const assistantCurrent = row.assistant_valid && row.assistant_digest === memoryFileRevision(assistant) && dependencies.every(validRef)
    return { ...row, sourceIds: sourceIds(row).filter(id => !omitted.has(id)), assistantSourceIds: assistantCurrent ? dependencies.map(ref => ref.id) : [],
      questionSourceIds: questionRefs.map(ref => ref.id), questionCurrent,
      assistant: assistantCurrent ? assistant : '' }

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
  type Purge = DialogPurge & { id: number, note: string, workspace: string, path: string | null, expected_revision: string | null }
  const purges = () => db.prepare('SELECT * FROM memory_note_purges ORDER BY id').all() as Purge[]
  function purgePlan(purge: Purge): FilePlan<Data> | null {
    const edit = changes(purge.workspace)
    if (purge.path) {
      const owner = db.prepare('SELECT key FROM memory_daily_notes WHERE workspace=? AND path=?').get(purge.workspace,purge.path)
      // Registration owns this managed path until erasure completes. Changed bytes do not
      // transfer ownership; only a different registered logical identity protects a new file.
      if (!owner || owner.key === purge.note) {
        const observed = edit.files.read(purge.path)
        if (observed && purge.expected_revision && observed.revision !== purge.expected_revision) return null
        edit.put(purge.path, null)
      }
      // External rename changes a pathname, never the session/day identity that owns the index.
      edit.index(noteDay(purge.note), undefined, !owner || owner.key === purge.note ? purge.path : undefined)
    }
    const directive: DialogPurge = { session: purge.session, turn: purge.turn, mode: purge.mode, source: purge.source }
    const path = sessionPath(purge.session), before = purge.mode === 'file' ? null : edit.files.read(path)
    if (before) edit.put(path, purgeDialog(before.markdown, directive))
    const members = [...edit.edits.values()].map(change => change.path === path || change.path === purge.path ? fileErasure(change) : change)
    return { workspace: purge.workspace, changes: members, data: { kind: 'purge', refs: [], id: purge.id, dialog: directive } }
  }
  function purgeReady(purge: Purge) {
    // A prepared purge is checked against its own durable plan by journal.needsRecovery().
    if (journal.state(`purge:${purge.id}`)) return false
    const plan = purgePlan(purge)
    return plan && plan.changes.every(change => journal.visible(plan.workspace, change.path))
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
        // A quarantined file/plan is local to its note. Keep cleanup durable without blocking other workspaces.
        if (!(error instanceof Error && ['memory-purge-version', 'memory-file-plan-busy', 'memory-file-plan-conflict', 'memory-index-pending'].includes(error.message))) throw error
      }
    }
  }
  function checkpointCleanup() {
    if (db.prepare('SELECT 1 FROM memory_note_erasures LIMIT 1').get() && truncateMemoryJournal(db)) db.exec('DELETE FROM memory_note_erasures')
  }
  function removeEvidence(sourceId: string, cut?: DocumentSourceCut) {
    const matches = (ref: SourceRef) => ref.id === sourceId && (!cut || documentSourceRestricted(ref, [cut]))
    const pendingKeys: string[] = []
    db.prepare('INSERT OR IGNORE INTO memory_note_erasures VALUES(?)').run(sourceId)
    const affected = db.prepare('SELECT * FROM memory_note_turns WHERE EXISTS (SELECT 1 FROM json_each(sources) WHERE value=?)')
      .all(sourceId) as unknown as TurnRow[]
    const affectedIds = new Set(affected.map(row => row.id))
    const assistants = (db.prepare(`SELECT * FROM memory_note_turns WHERE assistant_valid=1
      AND EXISTS (SELECT 1 FROM json_each(assistant_sources) WHERE json_extract(value,'$.id')=?)`).all(sourceId) as unknown as TurnRow[])
      .filter(row => !affectedIds.has(row.id))
    const questions = (db.prepare(`SELECT * FROM memory_note_turns WHERE question_valid=1
      AND EXISTS (SELECT 1 FROM json_each(question_sources) WHERE json_extract(value,'$.id')=?)`).all(sourceId) as unknown as TurnRow[]).filter(row => !affectedIds.has(row.id))
    const dependent = db.prepare('SELECT note FROM memory_note_sources WHERE source=?').all(sourceId) as Array<{ note: string }>
    const affectedCards = new Set(cut ? dependent.filter(row => references(row.note).some(matches)).map(row => row.note)
      : [...affected, ...assistants, ...questions, ...dependent].map(row => row.note))
    // Every unfinished source-bearing plan is a plaintext copy. Cancel it before recovery can
    // restore withdrawn bytes, then erase only its registered card/session identities.
    for (const pending of db.prepare("SELECT id,plan FROM memory_file_intents WHERE namespace='notes' AND plan IS NOT NULL").all()) {
      const plan = JSON.parse(String(pending.plan)) as FilePlan<Data>
      const data=plan.data
      if (data.kind === 'purge') continue
      // A rebuild can have no new sources and still retain old plaintext in its before-image.
      const refs = data.kind === 'note' ? [...data.refs, ...data.previousRefs] : data.refs
      if (!refs.some(matches)) {
        if (data.indexKeys?.some(key => affectedCards.has(key))) {
          // The following purge rebuilds navigation. An independent card's
          // plan must neither retain the old link nor reserve the index path.
          plan.changes = plan.changes.filter(change => !isDailyIndexPath(change.path))
          delete data.indexKeys
          db.prepare('UPDATE memory_file_intents SET plan=? WHERE id=?').run(JSON.stringify(plan), String(pending.id))
        }
        continue
      }
      const key=data.kind==='turn' ? data.row.note : data.key
      const turn=db.prepare('SELECT session FROM memory_note_turns WHERE note=? LIMIT 1').get(key)
      const session=data.kind==='turn' ? data.row.session : String(turn?.session ?? '')
      const path = data.kind === 'rename' ? data.to : data.kind === 'turn' ? null : data.path
      const registered = rawNote(key)
      if (cut && data.kind === 'note' && path && registered?.path === path && registered.file_revision
        && !references(key).some(matches)) {
        const change = plan.changes.find(item => item.path === path)
        if (change && 'before' in change && change.before !== null && change.after !== null
          && memoryFileRevision(change.before) === registered.file_revision) {
          const restore: FilePlan<Data> = { workspace: plan.workspace,
            changes: [fileErasure({ path, before: change.after, after: change.before })],
            data: { kind: 'restore', refs: references(key), key, path, revision: registered.file_revision, markdown: change.before } }
          db.prepare("UPDATE memory_file_intents SET plan=?,state='pending' WHERE id=?").run(JSON.stringify(restore), String(pending.id))
          continue
        }
      }
      const revision = data.kind === 'edit' ? data.observedRevision : data.kind === 'turn' ? null
        : data.kind === 'restore' ? data.revision : data.fileRevision
      const expected = path && (!registered?.file_revision || registered.path !== path) ? revision : null
      if (data.kind !== 'turn' || !cut) pendingKeys.push(key)
      db.prepare('INSERT INTO memory_note_purges(workspace,note,path,expected_revision,session,turn,mode,source) VALUES(?,?,?,?,?,?,?,?)')
        .run(plan.workspace,key,path,expected,session,data.kind==='turn' ? data.row.id : '',data.kind==='turn' ? 'remove' : 'assistant',null)
      db.prepare("UPDATE memory_file_intents SET state='cancelled',plan=NULL WHERE id=?").run(String(pending.id))
    }
    const keys = [...new Set([...affectedCards, ...pendingKeys])]
    const plannedCards = new Set<string>()
    function enqueue(row: Pick<TurnRow, 'workspace' | 'note' | 'session' | 'id'>, mode: 'remove' | 'assistant' | 'source' | 'redact') {
      const allocation = plannedCards.has(row.note) || cut && !keys.includes(row.note) ? undefined : rawNote(row.note)
      // An empty allocation owns a pathname, but contains no accepted bytes to erase.
      const card = allocation?.file_revision ? allocation : undefined
      const directive = cut && mode === 'redact' ? { ...cut, turnIds: affected
        .filter(turn => turn.workspace === row.workspace && turn.session === row.session).map(turn => turn.id) } satisfies DialogCut : null
      if (card) plannedCards.add(row.note)
      db.prepare('INSERT INTO memory_note_purges(workspace,note,path,expected_revision,session,turn,mode,source) VALUES(?,?,?,?,?,?,?,?)')
        .run(row.workspace, row.note, card?.path ?? null, null, row.session, row.id, mode, directive ? JSON.stringify(directive) : mode === 'source' ? sourceId : null)
    }
    for (const row of affected) {
      if (cut) {
        enqueue(row, 'redact')
        db.prepare("UPDATE memory_note_turns SET assistant_valid=0,assistant_sources='[]',assistant_digest=NULL,question_valid=0,question_sources='[]' WHERE id=?").run(row.id)
        continue
      }
      const survivors = sourceIds(row).filter(id => id !== sourceId)
      enqueue(row, survivors.length ? 'source' : 'remove')
      if (survivors.length) {
        const refs = (JSON.parse(row.source_tokens) as SourceRef[]).filter(ref => ref.id !== sourceId)
        db.prepare("UPDATE memory_note_turns SET sources=?,source_tokens=?,assistant_valid=0,assistant_sources='[]',assistant_digest=NULL,question_valid=0,question_sources='[]',written=0 WHERE id=?")
          .run(JSON.stringify(survivors), JSON.stringify(refs), row.id)
      } else db.prepare('DELETE FROM memory_note_turns WHERE id=?').run(row.id)
    }
    for (const row of assistants) {
      enqueue(row, 'assistant')
      db.prepare("UPDATE memory_note_turns SET assistant_valid=0,assistant_sources='[]',assistant_digest=NULL,question_valid=0,question_sources='[]',written=0 WHERE id=?").run(row.id)
    }
    for (const row of questions) {
      enqueue(row, 'assistant')
      db.prepare("UPDATE memory_note_turns SET question_valid=0,question_sources='[]',assistant_valid=0,assistant_sources='[]',assistant_digest=NULL,written=0 WHERE id=?").run(row.id)
    }
    for (const key of keys) {
      const note = rawNote(key)
      if (note && !plannedCards.has(key)) {
        const row = db.prepare('SELECT * FROM memory_note_turns WHERE note=? LIMIT 1').get(key) as unknown as TurnRow | undefined
        if (row) enqueue({ ...row, id: '' }, 'assistant')
      }
      db.prepare('DELETE FROM memory_note_sources WHERE note=?').run(key)
      db.prepare('DELETE FROM memory_note_aliases WHERE note=?').run(key)
      const remainingRestrictions = note && useRestrictions.forTarget({ kind: 'daily', workspace: note.workspace, key })
        .some(restriction => restriction.sources.some(ref => ref.id !== sourceId))
      if (note && (cut || remainingRestrictions)) {
        // Keep the logical allocation for surviving restrictions, but do not
        // retain a source-derived filename from the withdrawn projection.
        const base = dailyPathBase(note.day, key)
        let path = `${base}.md`, suffix = 1
        if (cut && canonicalLocator(note.path, note.day, key)) path = note.path
        else while (path === note.path || journal.files(note.workspace).read(path)
          || db.prepare('SELECT 1 FROM memory_daily_notes WHERE workspace=? AND path=?').get(note.workspace, path)) {
          path = `${base}-${suffix++}.md`
        }
        db.prepare('UPDATE memory_daily_notes SET path=?,file_revision=NULL,revision=revision+1,updated_at=? WHERE key=?')
          .run(path, Date.now(), key)
      } else db.prepare('DELETE FROM memory_daily_notes WHERE key=?').run(key)
      if (!cut) db.prepare('UPDATE memory_note_turns SET written=0 WHERE note=? AND written=1').run(key)
    }
    return keys
  }
  function deleteFile(workspace: string, key: string, expectedUsageVersion: number) {
    return store.tx(() => {
      const row = rawNote(key)
      if (!row || row.workspace !== workspace || row.revision !== expectedUsageVersion || !journal.visible(workspace, row.path)) throw new Error('memory-file-version')
      const [, session] = JSON.parse(key) as [string, string, string, number?]
      const publicId = `daily:${memoryFileRevision(key)}`
      db.prepare('INSERT INTO memory_deleted_daily_notes(note,base,public_id) VALUES(?,?,?)').run(key, dailyNoteKey(session, row.day, workspace), publicId)
      db.prepare("INSERT INTO memory_note_purges(workspace,note,path,expected_revision,session,turn,mode) VALUES(?,?,?,?,?,'','file')")
        .run(workspace, key, row.file_revision ? row.path : null, row.file_revision, session)
      db.prepare('DELETE FROM memory_note_sources WHERE note=?').run(key)
      db.prepare('DELETE FROM memory_note_aliases WHERE note=?').run(key)
      db.prepare('DELETE FROM memory_daily_notes WHERE key=?').run(key)
      useRestrictions.removeTarget({ kind: 'daily', workspace, key })
      return row.revision + 1
    })
  }
  const pendingCleanup = () => Number(db.prepare('SELECT (SELECT count(*) FROM memory_note_purges)+(SELECT count(*) FROM memory_note_erasures) AS n').get()?.n ?? 0)
  if (!options.deferRecovery) recover()
  return {
    allocations: () => db.prepare('SELECT key,day,workspace,path,revision,updated_at AS updatedAt FROM memory_daily_notes ORDER BY workspace,key').all() as unknown as DailyAllocation[],
    fileRegistry: () => db.prepare(`SELECT n.key,n.day,n.workspace,n.path,n.revision,n.updated_at AS updatedAt,n.file_revision AS fileRevision
      FROM memory_daily_notes n WHERE n.file_revision IS NOT NULL OR EXISTS (
        SELECT 1 FROM memory_file_use_restrictions r WHERE r.workspace=n.workspace AND r.kind='daily' AND r.target=n.key
      )`).all() as unknown as DailyFileRegistration[],
    advanceUseVersion: (key: string, revision: number, at: number) => db.prepare('UPDATE memory_daily_notes SET revision=revision+1,updated_at=? WHERE key=? AND revision=?')
      .run(at, key, revision).changes === 1,
    usePolicyToken, deleteFile,
    reconcileRename, reconcileEdit,
    reconciliationState: (operationId: string, kind: 'edit' | 'rename') => journal.state(`${kind === 'edit' ? 'external-edit' : 'rename'}:${operationId}`),
    resolveFileAlias(workspace: string, path: string) {
      if (db.prepare('SELECT 1 FROM memory_daily_notes WHERE workspace=? AND path=?').get(workspace, path)) return path
      const row = db.prepare(`SELECT n.path FROM memory_note_aliases a JOIN memory_daily_notes n ON n.key=a.note
        WHERE a.workspace=? AND a.path=? AND n.workspace=a.workspace`).get(workspace, path)
      return row ? String(row.path) : null
    },
    fileAliases: (workspace: string, path: string) => db.prepare(`SELECT a.path FROM memory_daily_notes n JOIN memory_note_aliases a
      ON a.note=n.key AND a.workspace=n.workspace WHERE n.workspace=? AND n.path=?`).all(workspace, path).map(row => String(row.path)),
    aliases: () => db.prepare('SELECT workspace,path,note AS id FROM memory_note_aliases').all().map(row => ({workspace:String(row.workspace),path:String(row.path),id:String(row.id)})),
    registeredAt: (workspace: string, path: string) => db.prepare(
      'SELECT key,file_revision FROM memory_daily_notes WHERE workspace=? AND path=? AND file_revision IS NOT NULL'
    ).get(workspace, path) as { key: string, file_revision: string } | undefined,
    registeredForSources: (ids: readonly string[]) => db.prepare(`SELECT DISTINCT n.workspace,n.path
      FROM memory_note_sources s JOIN memory_daily_notes n ON n.key=s.note
      WHERE s.source IN (SELECT value FROM json_each(?)) AND n.file_revision IS NOT NULL ORDER BY n.workspace,n.key`).all(JSON.stringify(ids))
      .map(row => ({ workspace: String(row.workspace), path: String(row.path) })),
    registered: () => db.prepare('SELECT * FROM memory_daily_notes WHERE file_revision IS NOT NULL ORDER BY workspace,key').all().map(row => ({
      key: String(row.key), day: String(row.day), workspace: String(row.workspace), path: String(row.path),
      revision: Number(row.revision), processed: Number(row.processed), updatedAt: Number(row.updated_at),
      file_revision: String(row.file_revision), sources: references(String(row.key)),
      state: db.prepare('SELECT 1 FROM memory_note_purges WHERE note=?').get(String(row.key)) ? 'withdrawing' as const : 'active' as const,
    })),
    needsRecovery: () => journal.needsRecovery(data => data.kind !== 'purge' || data.dialog.mode !== 'file')
      || purges().some(row => row.mode !== 'file' && purgeReady(row)),
    recoverDeletedFiles: () => applyPurges(purges().filter(row => row.mode === 'file')),
    deletedFileCleanupPending: (workspace: string, id: string) => Boolean(db.prepare(`SELECT 1 FROM memory_deleted_daily_notes d
      WHERE public_id=? AND json_extract(d.note,'$[0]')=? AND (EXISTS (SELECT 1 FROM memory_note_purges p WHERE p.note=d.note AND p.mode='file')
      OR EXISTS (SELECT 1 FROM memory_note_erasures WHERE source=?))`).get(id, workspace, `file:${id}`)),
    checkpointCleanup,
    recover, read, snapshot, references,
    pendingCleanup,
    rebuildRows: (key: string) => deleted(key) ? [] : (db.prepare('SELECT * FROM memory_note_turns WHERE note=? ORDER BY rowid').all(key) as unknown as TurnRow[]).map(turn),
    jobState: (key: string, generation: number) => journal.state(`note:${memoryFileRevision(key)}:${generation}`),
    blocked: (key: string) => Boolean(db.prepare('SELECT 1 FROM memory_note_purges WHERE note=?').get(key) || rawNote(key)?.file_revision && !read(key)),
    contextSources(session: string, source: MemorySource) {
      const rows = db.prepare('SELECT * FROM memory_note_turns WHERE session=? AND workspace=? ORDER BY rowid')
        .all(session, workspaceOf(source)) as unknown as TurnRow[]
      return [...new Set(rows.flatMap(row => [...sourceIds(row), ...(row.assistant_valid ? (JSON.parse(row.assistant_sources) as SourceRef[]).map(ref => ref.id) : []), ...(row.question_valid ? (JSON.parse(row.question_sources) as SourceRef[]).map(ref => ref.id) : [])]))]
    },
    add(session: string, day: string, sources: MemorySource[], assistant: string, requestId = sources[0]!.id, assistantSources: readonly string[] = [], inputAssistant = assistant, options: { questionSources?: readonly string[], questionCurrent?: boolean } = {}) {
      // Recovery may change accepted daily versions. It belongs to the fenced job lifecycle, not intake.
      const workspace = workspaceOf(sources[0]!)
      if (sources.some(source => workspaceOf(source) !== workspace || source.session !== session)) throw new Error('memory-turn-scope')
      const base = dailyNoteKey(session, day, workspace)
      const generation = Number(db.prepare('SELECT count(*) AS n FROM memory_deleted_daily_notes WHERE base=?').get(base)!.n)
      const key = generation ? dailyNoteKey(session, day, workspace, generation) : base
      const userRefs = snapshot(sources.map(source => source.id))
      const assistantRefs = assistant ? snapshot([...sources.map(source => source.id), ...assistantSources]) : []
      const answers = sources.filter(source => source.author === 'answer')
      const hasQuestions = answers.length > 0
      const questionCurrent = !hasQuestions || (options.questionCurrent === true && answers.every(source => Boolean(source.question)))
      const questionRefs = hasQuestions && questionCurrent ? snapshot(options.questionSources ?? []) : []
      const refs = [...new Map([...userRefs, ...assistantRefs, ...questionRefs].map(ref => [ref.id, ref])).values()]
      const row: TurnRow = { id: requestId, note: key, session, day, workspace, sources: JSON.stringify(sources.map(source => source.id)), source_tokens: JSON.stringify(userRefs), assistant_sources: JSON.stringify(assistantRefs), assistant_digest: assistant ? memoryFileRevision(assistant) : null, assistant_valid: 1, question_sources: JSON.stringify(questionRefs), question_valid: questionCurrent ? 1 : 0, written: 0 }
      const input = memoryFileRevision(JSON.stringify([session, day, userRefs, inputAssistant]))
      const exists = Boolean(db.prepare('SELECT 1 FROM memory_note_turns WHERE id=?').get(requestId))
      const accepted = journal.commit(`turn:${requestId}`, input, () => {
        const path = sessionPath(session)
        const before = journal.files(workspace).read(path)
        const entry: DialogTurn = { id: requestId, session, day, messages: [
          ...sources.map(source => ({ role: 'user' as const, sourceId: source.id, version: source.version, author: source.author, at: source.at, text: source.text! })),
          ...(assistant ? [{ role: 'assistant' as const, text: assistant, at: sources.at(-1)!.at }] : []),
        ] }
        const append = JSON.stringify(entry) + '\n'
        return { workspace, changes: [{ path, append, beforeRevision: before?.revision ?? null,
          afterRevision: memoryFileRevision((before?.markdown ?? '') + append) }], data: { kind: 'turn', row, refs } }
      })
      return accepted && !exists ? key : null
    },
    list(from: string | null, through: string | null) {
      return (db.prepare('SELECT key FROM memory_daily_notes WHERE file_revision IS NOT NULL AND (? IS NULL OR day>=?) AND (? IS NULL OR day<=?) ORDER BY day,key')
        .all(from, from, through, through) as Array<{ key: string }>).flatMap(row => read(row.key) ?? [])
    },
    changedFiles(from: string, through: string) {
      return db.prepare('SELECT key, workspace, path FROM memory_daily_notes WHERE file_revision IS NOT NULL AND day BETWEEN ? AND ? AND revision>processed ORDER BY day,key')
        .all(from, through) as Array<{ key: string, workspace: string, path: string }>
    },
    pendingGroups: () => db.prepare('SELECT note,session,day,COUNT(*) AS count FROM memory_note_turns WHERE written=0 AND note NOT IN (SELECT note FROM memory_deleted_daily_notes) GROUP BY note,session,day')
      .all() as Array<{ note: string, session: string, day: string, count: number }>,
    pending: (key: string, limit: number = defaults.noteInterval) => deleted(key) ? [] : (db.prepare('SELECT * FROM memory_note_turns WHERE note=? AND written=0 ORDER BY rowid LIMIT ?')
      .all(key, limit) as unknown as TurnRow[]).map(turn),
    previous(_key: string, id: string) {
      const row = db.prepare('SELECT * FROM memory_note_turns WHERE workspace=(SELECT workspace FROM memory_note_turns WHERE id=?) AND session=(SELECT session FROM memory_note_turns WHERE id=?) AND rowid<(SELECT rowid FROM memory_note_turns WHERE id=?) AND note NOT IN (SELECT note FROM memory_deleted_daily_notes) ORDER BY rowid DESC LIMIT 1')
        .get(id, id, id) as TurnRow | undefined
      return row && turn(row)
    },
    sourceQuestionContext(sourceId: string) {
      const rows = db.prepare('SELECT * FROM memory_note_turns WHERE EXISTS (SELECT 1 FROM json_each(sources) WHERE value=?)').all(sourceId) as unknown as TurnRow[]
      if (!rows.length) return { current: false, refs: [] }
      const refs = rows.flatMap(row => JSON.parse(row.question_sources) as SourceRef[])
      return { current: rows.every(row => Boolean(row.question_valid)) && refs.every(validRef), refs: [...new Map(refs.map(ref => [ref.id, ref])).values()] }
    },
    sources(key: string) {
      return (db.prepare('SELECT source FROM memory_note_sources WHERE note=? ORDER BY rowid').all(key) as Array<{ source: string }>).map(row => row.source)
    },
    finish(rows: Array<{ id: string }>, contributed: boolean) {
      for (const row of rows) db.prepare('UPDATE memory_note_turns SET written=? WHERE id=?').run(contributed ? 1 : 2, row.id)
    },
    commit(key: string, rows: Array<{ id: string }>, reply: { status: 'skip' } | { status: 'write', title: string, markdown: string, filename?: string },
      generation: number, at: number, refs: SourceRef[], expected: Note | undefined, options: { rebuild?: boolean } = {}) {
      if (deleted(key)) return false
      const first = db.prepare('SELECT * FROM memory_note_turns WHERE id=?').get(rows[0]!.id) as unknown as TurnRow
      const id = `note:${memoryFileRevision(key)}:${generation}`
      const input = memoryFileRevision(JSON.stringify([key, rows.map(row => row.id), refs, expected?.fileRevision, expected?.revision, options.rebuild ?? false]))
      return journal.commit(id, input, () => {
        const allocation = rawNote(key), current = read(key)
        if (allocation?.file_revision && !current) throw new Error('memory-file-version')
        if (current?.fileRevision !== expected?.fileRevision || current?.revision !== expected?.revision) throw new Error('memory-file-version')
        const edit = changes(first.workspace)
        let path: string | null = null, fileRevision: string | null = null
        const clearAliases = reply.status === 'write' && Boolean(allocation && (options.rebuild || !current)
          && requiresOpaqueLocator(first.workspace, key) && !canonicalLocator(allocation.path, first.day, key))
        if (reply.status === 'write') {
          // The locator is stable and contains no model-generated title or stopped prose.
          path = !clearAliases && allocation ? allocation.path : `${dailyPathBase(first.day, key)}.md`
          const base = path.slice(0, -3)
          if (allocation && !clearAliases && !current && edit.files.read(path)) throw new Error('memory-file-version')
          let suffix = 1
          while ((!allocation || clearAliases) && (edit.files.read(path) || db.prepare('SELECT 1 FROM memory_daily_notes WHERE workspace=? AND path=?').get(first.workspace, path))) {
            path = `${base}-${suffix++}.md`
          }
          const old = current && !options.rebuild ? parseMemoryDocument(edit.files.read(current.path)!.markdown).metadata : {}
          if (current && current.path !== path) edit.put(current.path, null)
          edit.put(path, formatMemoryDocument({ metadata: { ...old, name: reply.title, description: reply.title,
            session_id: first.session, source_conversation: `[[${sessionPath(first.session)}]]` }, body: reply.markdown }))
          fileRevision = memoryFileRevision(edit.edits.get(path)?.after ?? edit.files.read(path)!.markdown)
          edit.index(first.day, { key, path, title: reply.title })
        } else if (options.rebuild && current) {
          edit.put(current.path, null)
          edit.index(first.day, undefined, current.path)
        }
        return { workspace: first.workspace, changes: [...edit.edits.values()], data: {
          kind: 'note', indexKeys: [...edit.indexKeys], key, day: first.day, workspace: first.workspace, path, revision: Math.max(generation, (allocation?.revision ?? 0) + 1), expectedRevision: allocation?.revision ?? null, policyToken: usePolicyToken(first.workspace), generation, at, rows: rows.map(row => row.id),
          contributed: reply.status === 'write', refs, previousRefs: current ? references(key) : [], fileRevision, clearAliases, remove: Boolean(options.rebuild && reply.status === 'skip' && current),
        } }
      })
    },
    markProcessed(key: string, revision: number) {
      return Number(db.prepare('UPDATE memory_daily_notes SET processed=? WHERE key=? AND revision=? AND processed<>revision').run(revision, key, revision).changes) > 0
    },
    withdraw: (sourceId: string) => removeEvidence(sourceId),
    eraseSource: (cut: DocumentSourceCut) => removeEvidence(cut.id, cut),
  }
}
