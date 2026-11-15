import { memoryFileRevision } from './memory-file-store.ts'
import { openMemoryFileJournal } from './memory-file-journal.ts'
import type { FileChange, FileCheckpoint } from './memory-file-journal.ts'
import { formatMemoryDocument, parseMemoryDocument } from './memory-document.ts'
import type { MemorySource, MemoryStore } from './memory-store.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../shared/memory-daily-defaults.ts'

export const dailyNoteKey = (session: string, day: string, workspace = '') => JSON.stringify([workspace, session, day])
const workspaceOf = (source: MemorySource) => memoryFileRevision(JSON.stringify([source.scope, source.context, source.project ?? null]))
const sessionPath = (session: string) => `session/dialog/${memoryFileRevision(session)}.jsonl`
const token = (source: MemorySource) => memoryFileRevision(JSON.stringify([
  source.id, source.version, source.hash, source.text, source.author, source.at, source.timezone,
  source.session, source.conversation, source.question, source.scope, source.context, source.project ?? null,
]))
type SourceRef = { id: string, token: string }
type DialogTurn = { id: string, session: string, day: string, messages: Array<{
  role: 'user' | 'assistant', text: string, sourceId?: string, version?: number, author?: MemorySource['author'], at: number,
}> }
interface TurnRow { id: string, note: string, session: string, day: string, workspace: string, sources: string, source_tokens: string, assistant_sources: string, assistant_valid: number, written: number }
interface NoteRow { key: string, day: string, workspace: string, path: string, revision: number, processed: number, updatedAt: number, file_revision: string }
type Note = NoteRow & { title: string, markdown: string, fileRevision: string }
type LinkedCard = { key: string, before: string, after: string, refs: SourceRef[] }
type Data = { refs: SourceRef[], linkedCards?: LinkedCard[] } & (
  | { kind: 'turn', row: TurnRow }
  | { kind: 'note', key: string, day: string, workspace: string, path: string | null, revision: number, generation: number, at: number, rows: string[], contributed: boolean, fileRevision: string | null }
  | { kind: 'purge', id: number }
)

/** Markdown/JSONL own content. SQLite keeps identities, dependencies, pending work and commit receipts. */
export function openMemoryNotes(store: MemoryStore, readable: (id: string) => boolean,
  checkpoint?: (point: FileCheckpoint, path?: string) => void, currentJob?: (key: string, generation: number) => boolean) {
  const db = store.db
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_note_turns (
      id TEXT PRIMARY KEY, note TEXT NOT NULL, session TEXT NOT NULL, day TEXT NOT NULL,
      workspace TEXT NOT NULL, sources TEXT NOT NULL, source_tokens TEXT NOT NULL, assistant_sources TEXT NOT NULL, assistant_valid INTEGER NOT NULL DEFAULT 1, written INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memory_note_turns_group ON memory_note_turns(note,written);
    CREATE TABLE IF NOT EXISTS memory_daily_notes (
      key TEXT PRIMARY KEY, day TEXT NOT NULL, workspace TEXT NOT NULL, path TEXT NOT NULL, file_revision TEXT NOT NULL,
      revision INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_note_sources (note TEXT NOT NULL, source TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(note,source));
    CREATE TABLE IF NOT EXISTS memory_note_purges (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, note TEXT NOT NULL, path TEXT, expected_revision TEXT, session TEXT NOT NULL, turn TEXT NOT NULL, mode TEXT NOT NULL, source TEXT);
  `)
  const snapshot = (ids: readonly string[]): SourceRef[] => [...new Set(ids)].map(id => {
    const source = store.readSource(id)
    if (!source || !readable(id)) throw new Error('memory-source-version')
    return { id, token: token(source) }
  })
  const journal = openMemoryFileJournal<Data>({ db, root: store.fileRoot, checkpoint,
    valid: data => (data.kind !== 'note' || !currentJob || currentJob(data.key, data.generation)) && data.refs.every(ref => {
      const source = store.readSource(ref.id)
      return source && readable(ref.id) && token(source) === ref.token
    }) && (data.linkedCards ?? []).every(card => {
      const row = db.prepare('SELECT file_revision FROM memory_daily_notes WHERE key=?').get(card.key) as { file_revision: string } | undefined
      return row?.file_revision === card.before && card.refs.every(ref => {
        const source = store.readSource(ref.id)
        return source && readable(ref.id) && token(source) === ref.token
      })
    }),
    finish(data) {
      if (data.kind === 'turn') {
        const row = data.row
        db.prepare('INSERT INTO memory_note_turns(id,note,session,day,workspace,sources,source_tokens,assistant_sources) VALUES(?,?,?,?,?,?,?,?)')
          .run(row.id, row.note, row.session, row.day, row.workspace, row.sources, row.source_tokens, row.assistant_sources)
      } else if (data.kind === 'note') {
        if (data.path) db.prepare(`INSERT INTO memory_daily_notes(key,day,workspace,path,file_revision,revision,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET path=excluded.path,file_revision=excluded.file_revision,revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(data.key, data.day, data.workspace, data.path, data.fileRevision!, data.revision, data.at)
        for (const card of data.linkedCards ?? []) {
          db.prepare('UPDATE memory_daily_notes SET file_revision=?,revision=MAX(revision+1,?),updated_at=? WHERE key=?')
            .run(card.after, data.generation, data.at, card.key)
        }
        if (data.contributed) {
          db.prepare('DELETE FROM memory_note_sources WHERE note=?').run(data.key)
          for (const ref of data.refs) db.prepare('INSERT INTO memory_note_sources(note,source,token) VALUES(?,?,?)').run(data.key, ref.id, ref.token)
        }
        for (const id of data.rows) db.prepare('UPDATE memory_note_turns SET written=? WHERE id=?').run(data.contributed ? 1 : 2, id)
        for (const ref of data.refs) if (store.readSource(ref.id)?.outcome === 'note-pending') {
          store.outcome(ref.id, data.contributed ? 'note-ready' : 'note-skipped')
        }
      } else db.prepare('DELETE FROM memory_note_purges WHERE id=?').run(data.id)
    },
  })
  const rawNote = (key: string) => db.prepare('SELECT *,updated_at AS updatedAt FROM memory_daily_notes WHERE key=?').get(key) as NoteRow | undefined
  function read(key: string): Note | undefined {
    const row = rawNote(key)
    if (!row || !journal.visible(row.workspace, row.path)) return
    const refs = db.prepare('SELECT source AS id,token FROM memory_note_sources WHERE note=?').all(key) as SourceRef[]
    if (refs.some(ref => { const source = store.readSource(ref.id); return !source || !readable(ref.id) || token(source) !== ref.token })) return
    const file = journal.files(row.workspace).read(row.path)
    if (!file) return
    const doc = parseMemoryDocument(file.markdown)
    return { ...row, title: String(doc.metadata.name ?? ''), markdown: doc.body, fileRevision: file.revision }
  }
  function dialog(workspace: string, session: string): DialogTurn[] {
    const text = journal.files(workspace).read(sessionPath(session))?.markdown ?? ''
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as DialogTurn)
  }
  const sourceIds = (row: TurnRow) => JSON.parse(row.sources) as string[]
  function turn(row: TurnRow) {
    const refs = JSON.parse(row.source_tokens) as SourceRef[]
    if (refs.some(ref => { const source = store.readSource(ref.id); return !source || token(source) !== ref.token })) throw new Error('memory-source-version')
    if (!journal.visible(row.workspace, sessionPath(row.session))) throw new Error('memory-session-pending')
    const saved = dialog(row.workspace, row.session).find(item => item.id === row.id)
    if (!saved) throw new Error('memory-session-missing')
    const dependencies = JSON.parse(row.assistant_sources) as SourceRef[]
    const assistantCurrent = row.assistant_valid && dependencies.every(ref => {
      const source = store.readSource(ref.id)
      return source && readable(ref.id) && token(source) === ref.token
    })
    return { ...row, sourceIds: sourceIds(row), assistantSourceIds: assistantCurrent ? dependencies.map(ref => ref.id) : [],
      assistant: assistantCurrent ? saved.messages.filter(item => item.role === 'assistant').map(item => item.text).join('\n\n') : '' }

  }
  function changes(workspace: string) {
    const files = journal.files(workspace)
    const edits = new Map<string, FileChange>()
    const put = (path: string, after: string | null) => {
      const before = files.read(path)?.markdown ?? null
      if (before !== after) edits.set(path, { path, before, after })
    }
    function index(day: string, extra?: { key: string, path: string, title: string }, removed?: string) {
      const cards = (db.prepare('SELECT key,path FROM memory_daily_notes WHERE workspace=? AND day=? ORDER BY key')
        .all(workspace, day) as Array<{ key: string, path: string }>).filter(row => row.path !== removed && row.key !== extra?.key)
        .flatMap(row => {
          if (!journal.visible(workspace, row.path)) throw new Error('memory-index-pending')
          const content = files.read(row.path)
          return content ? [{ path: row.path, title: String(parseMemoryDocument(content.markdown).metadata.name ?? '') }] : []
        })
      if (extra) cards.push(extra)
      cards.sort((a, b) => a.path.localeCompare(b.path))
      put(`daily/${day}.md`, formatMemoryDocument({ metadata: { name: day, description: `Daily notes: ${day}` },
        body: cards.map(card => `- [[${card.path}]]`).join('\n') + '\n' }))
    }
    return { files, edits, put, index }
  }
  function recover() {
    journal.recover()
    type Purge = { id: number, workspace: string, path: string | null, expected_revision: string | null, session: string, turn: string, mode: string, source: string | null }
    for (const purge of db.prepare('SELECT * FROM memory_note_purges ORDER BY id').all() as Purge[]) {
      try {
        journal.commit(`purge:${purge.id}`, String(purge.id), () => {
          const edit = changes(purge.workspace)
          if (purge.path) {
            const current = edit.files.read(purge.path)
            if (current && current.revision !== purge.expected_revision) throw new Error('memory-purge-version')
            edit.put(purge.path, null)
            edit.index(purge.path.split('/')[1]!, undefined, purge.path)
          }
          const retained = dialog(purge.workspace, purge.session).flatMap(row => {
            if (row.id !== purge.turn) return [row]
            if (purge.mode === 'remove') return []
            const messages = row.messages.filter(message => message.role !== 'assistant' && message.sourceId !== purge.source)
            return messages.length ? [{ ...row, messages }] : []
          })
          edit.put(sessionPath(purge.session), retained.length ? retained.map(row => JSON.stringify(row)).join('\n') + '\n' : null)
          return { workspace: purge.workspace, changes: [...edit.edits.values()], data: { kind: 'purge', refs: [], id: purge.id } }
        })
      } catch (error) {
        // A quarantined file/plan is local to its note. Keep cleanup durable without blocking other workspaces.
        if (!(error instanceof Error && ['memory-purge-version', 'memory-file-plan-busy', 'memory-file-plan-conflict'].includes(error.message))) throw error
      }
    }
  }
  recover()
  return {
    recover, read, snapshot,
    jobState: (key: string, generation: number) => journal.state(`note:${memoryFileRevision(key)}:${generation}`),
    blocked: (key: string) => Boolean(db.prepare('SELECT 1 FROM memory_note_purges WHERE note=?').get(key) || rawNote(key) && !read(key)),
    contextSources(session: string, source: MemorySource) {
      const rows = db.prepare('SELECT * FROM memory_note_turns WHERE session=? AND workspace=? ORDER BY rowid')
        .all(session, workspaceOf(source)) as unknown as TurnRow[]
      return [...new Set(rows.flatMap(row => [...sourceIds(row), ...(row.assistant_valid ? (JSON.parse(row.assistant_sources) as SourceRef[]).map(ref => ref.id) : [])]))]
    },
    add(session: string, day: string, sources: MemorySource[], assistant: string, requestId = sources[0]!.id, assistantSources: readonly string[] = [], inputAssistant = assistant) {
      recover()
      const workspace = workspaceOf(sources[0]!)
      if (sources.some(source => workspaceOf(source) !== workspace || source.session !== session)) throw new Error('memory-turn-scope')
      const key = dailyNoteKey(session, day, workspace)
      const userRefs = snapshot(sources.map(source => source.id))
      const assistantRefs = assistant ? snapshot([...sources.map(source => source.id), ...assistantSources]) : []
      const refs = [...new Map([...userRefs, ...assistantRefs].map(ref => [ref.id, ref])).values()]
      const row: TurnRow = { id: requestId, note: key, session, day, workspace, sources: JSON.stringify(sources.map(source => source.id)), source_tokens: JSON.stringify(userRefs), assistant_sources: JSON.stringify(assistantRefs), assistant_valid: 1, written: 0 }
      const input = memoryFileRevision(JSON.stringify([session, day, userRefs, inputAssistant]))
      const exists = Boolean(db.prepare('SELECT 1 FROM memory_note_turns WHERE id=?').get(requestId))
      const accepted = journal.commit(`turn:${requestId}`, input, () => {
        const path = sessionPath(session)
        const before = journal.files(workspace).read(path)?.markdown ?? null
        const entry: DialogTurn = { id: requestId, session, day, messages: [
          ...sources.map(source => ({ role: 'user' as const, sourceId: source.id, version: source.version, author: source.author, at: source.at, text: source.text! })),
          ...(assistant ? [{ role: 'assistant' as const, text: assistant, at: sources.at(-1)!.at }] : []),
        ] }
        return { workspace, changes: [{ path, before, after: (before ?? '') + JSON.stringify(entry) + '\n' }], data: { kind: 'turn', row, refs } }
      })
      return accepted && !exists ? key : null
    },
    list(from: string | null, through: string | null) {
      return (db.prepare('SELECT key FROM memory_daily_notes WHERE (? IS NULL OR day>=?) AND (? IS NULL OR day<=?) ORDER BY day,key')
        .all(from, from, through, through) as Array<{ key: string }>).flatMap(row => read(row.key) ?? [])
    },
    changed(from: string, through: string) {
      return (db.prepare('SELECT key FROM memory_daily_notes WHERE day BETWEEN ? AND ? AND revision>processed ORDER BY day,key')
        .all(from, through) as Array<{ key: string }>).flatMap(row => read(row.key) ?? [])
    },
    pendingGroups: () => db.prepare('SELECT note,session,day,COUNT(*) AS count FROM memory_note_turns WHERE written=0 GROUP BY note,session,day')
      .all() as Array<{ note: string, session: string, day: string, count: number }>,
    pending: (key: string, limit: number = defaults.noteInterval) => (db.prepare('SELECT * FROM memory_note_turns WHERE note=? AND written=0 ORDER BY rowid LIMIT ?')
      .all(key, limit) as unknown as TurnRow[]).map(turn),
    previous(_key: string, id: string) {
      const row = db.prepare('SELECT * FROM memory_note_turns WHERE workspace=(SELECT workspace FROM memory_note_turns WHERE id=?) AND session=(SELECT session FROM memory_note_turns WHERE id=?) AND rowid<(SELECT rowid FROM memory_note_turns WHERE id=?) ORDER BY rowid DESC LIMIT 1')
        .get(id, id, id) as TurnRow | undefined
      return row && turn(row)
    },
    sources(key: string) {
      return (db.prepare('SELECT source FROM memory_note_sources WHERE note=? ORDER BY rowid').all(key) as Array<{ source: string }>).map(row => row.source)
    },
    finish(rows: Array<{ id: string }>, contributed: boolean) {
      for (const row of rows) db.prepare('UPDATE memory_note_turns SET written=? WHERE id=?').run(contributed ? 1 : 2, row.id)
    },
    commit(key: string, rows: Array<{ id: string }>, reply: { status: 'skip' } | { status: 'write', title: string, markdown: string, filename?: string },
      generation: number, at: number, refs: SourceRef[], expected: Note | undefined) {
      const first = db.prepare('SELECT * FROM memory_note_turns WHERE id=?').get(rows[0]!.id) as unknown as TurnRow
      const id = `note:${memoryFileRevision(key)}:${generation}`
      const input = memoryFileRevision(JSON.stringify([key, rows.map(row => row.id), refs, expected?.fileRevision]))
      return journal.commit(id, input, () => {
        const current = read(key)
        if (current?.fileRevision !== expected?.fileRevision) throw new Error('memory-file-version')
        const edit = changes(first.workspace)
        let path: string | null = null, fileRevision: string | null = null
        if (reply.status === 'write') {
          let slug = (reply.filename ?? reply.title).replace(/\.md$/u, '').normalize('NFKC')
            .replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72) || 'note'
          while (Buffer.byteLength(slug) > 120) slug = [...slug].slice(0, -1).join('')
          path = `daily/${first.day}/${slug}-${memoryFileRevision(first.session)}.md`
          // Identity remains session + day; a colliding unowned file is never adopted.
          const base = path.slice(0, -3)
          let suffix = 1
          while (path !== current?.path && edit.files.read(path)) path = `${base}-${suffix++}.md`
          const old = current ? parseMemoryDocument(edit.files.read(current.path)!.markdown).metadata : {}
          edit.put(path, formatMemoryDocument({ metadata: { ...old, name: reply.title, description: reply.title,
            session_id: first.session, source_conversation: `[[${sessionPath(first.session)}]]` }, body: reply.markdown }))
          if (current && current.path !== path) {
            edit.put(current.path, null)
            for (const linked of edit.files.list()) {
              if (linked === current.path || linked === path) continue
              const content = edit.files.read(linked)!.markdown
              // Only rewrite the exact wikilink destination, preserving labels and anchors.
              const updated = content.replace(/\[\[([^\]|#]+)([^\]]*)\]\]/gu,
                (whole, target: string, suffix: string) => target === current.path ? `[[${path}${suffix}]]` : whole)
              if (updated !== content) edit.put(linked, updated)
            }
          }
          fileRevision = memoryFileRevision(edit.edits.get(path)?.after ?? edit.files.read(path)!.markdown)
          edit.index(first.day, { key, path, title: reply.title })
        }
        const linkedCards = [...edit.edits.values()].flatMap(change => {
          if (change.after === null) return []
          const card = db.prepare('SELECT * FROM memory_daily_notes WHERE workspace=? AND path=? AND key<>?')
            .get(first.workspace, change.path, key) as NoteRow | undefined
          if (!card) return []
          const refs = db.prepare('SELECT source AS id,token FROM memory_note_sources WHERE note=?').all(card.key) as SourceRef[]
          return [{ key: card.key, before: card.file_revision, after: memoryFileRevision(change.after), refs }]
        })
        return { workspace: first.workspace, changes: [...edit.edits.values()], data: {
          kind: 'note', key, day: first.day, workspace: first.workspace, path, revision: Math.max(generation, (rawNote(key)?.revision ?? 0) + 1), generation, at, rows: rows.map(row => row.id),
          contributed: reply.status === 'write', refs, fileRevision, linkedCards,
        } }
      })
    },
    markProcessed(key: string, revision: number) {
      db.prepare('UPDATE memory_daily_notes SET processed=? WHERE key=? AND revision=?').run(revision, key, revision)
    },
    withdraw(sourceId: string) {
      const affected = db.prepare('SELECT * FROM memory_note_turns WHERE EXISTS (SELECT 1 FROM json_each(sources) WHERE value=?)')
        .all(sourceId) as unknown as TurnRow[]
      const affectedIds = new Set(affected.map(row => row.id))
      const assistants = (db.prepare(`SELECT * FROM memory_note_turns WHERE assistant_valid=1
        AND EXISTS (SELECT 1 FROM json_each(assistant_sources) WHERE json_extract(value,'$.id')=?)`).all(sourceId) as unknown as TurnRow[])
        .filter(row => !affectedIds.has(row.id))
      const dependent = db.prepare('SELECT note FROM memory_note_sources WHERE source=?').all(sourceId) as Array<{ note: string }>
      const keys = [...new Set([...affected, ...assistants, ...dependent].map(row => row.note))]
      const plannedCards = new Set<string>()
      function enqueue(row: Pick<TurnRow, 'workspace' | 'note' | 'session' | 'id'>, mode: 'remove' | 'assistant' | 'source') {
        const card = plannedCards.has(row.note) ? undefined : rawNote(row.note)
        plannedCards.add(row.note)
        db.prepare('INSERT INTO memory_note_purges(workspace,note,path,expected_revision,session,turn,mode,source) VALUES(?,?,?,?,?,?,?,?)')
          .run(row.workspace, row.note, card?.path ?? null, card?.file_revision ?? null, row.session, row.id, mode, mode === 'source' ? sourceId : null)
      }
      for (const row of affected) {
        const survivors = sourceIds(row).filter(id => id !== sourceId)
        enqueue(row, survivors.length ? 'source' : 'remove')
        if (survivors.length) {
          const refs = (JSON.parse(row.source_tokens) as SourceRef[]).filter(ref => ref.id !== sourceId)
          db.prepare("UPDATE memory_note_turns SET sources=?,source_tokens=?,assistant_valid=0,assistant_sources='[]',written=0 WHERE id=?")
            .run(JSON.stringify(survivors), JSON.stringify(refs), row.id)
        } else db.prepare('DELETE FROM memory_note_turns WHERE id=?').run(row.id)
      }
      for (const row of assistants) {
        enqueue(row, 'assistant')
        db.prepare("UPDATE memory_note_turns SET assistant_valid=0,assistant_sources='[]',written=0 WHERE id=?").run(row.id)
      }
      for (const key of keys) {
        const note = rawNote(key)
        if (note && !plannedCards.has(key)) {
          const row = db.prepare('SELECT * FROM memory_note_turns WHERE note=? LIMIT 1').get(key) as unknown as TurnRow | undefined
          if (row) enqueue({ ...row, id: '' }, 'assistant')
        }
        db.prepare('DELETE FROM memory_note_sources WHERE note=?').run(key)
        db.prepare('DELETE FROM memory_daily_notes WHERE key=?').run(key)
        db.prepare('UPDATE memory_note_turns SET written=0 WHERE note=? AND written=1').run(key)
      }
      return keys
    },
  }
}
