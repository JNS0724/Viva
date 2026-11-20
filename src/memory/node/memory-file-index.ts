import { createHmac, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryFileIndex, MemoryFileNode, MemoryFilePage, MemoryFileQueryScope, MemoryFileSnapshot, MemoryFileIdentity, MemoryFileVersion, MemoryFilePassage, MemoryFileChunkRef, MemoryFileHit, MemoryVectorState, MemoryVectorSpace } from '../core/ports/file-index.ts'
import { dailyPath, digestPath } from '../contracts/memory-file-contract.ts'
import { memorySearchTokens } from '../core/search-tokens.ts'
import { transaction, truncateMemoryJournal } from './sqlite.ts'

const same = (a: MemoryFileVersion, b: MemoryFileVersion) => a.revision === b.revision && a.usageVersion === b.usageVersion && a.policyToken === b.policyToken
const key = (ref: MemoryFileChunkRef) => JSON.stringify([ref.workspace, ref.fileId, ref.ordinal, ref.revision, ref.usageVersion, ref.policyToken])
const identity = ({ name: _name, description: _description, tags: _tags, ...file }: MemoryFileNode): MemoryFileIdentity => file
const node = (file: MemoryFileSnapshot): MemoryFileNode => {
  const { chunks: _chunks, ...meta } = file
  return { ...meta }
}
const page = <T>(rows: T[], limit: number): MemoryFilePage<T> => ({
  rows: rows.slice(0, limit), incomplete: rows.length > limit,
})
const limitOf = (limit: number) => Number.isSafeInteger(limit) && limit > 0 ? limit : 0

/** Accepted projections are the only inputs. This adapter deliberately has no filesystem dependency. */
export function openMemoryFileIndex({ db, checkpoint = () => {} }: { db: DatabaseSync, now?: () => number, checkpoint?: (point: string) => void }): MemoryFileIndex {
  db.exec(`PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS memory_file_index_nodes(rowid INTEGER PRIMARY KEY,workspace TEXT NOT NULL,id TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,day TEXT,updated_at INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(workspace,id),UNIQUE(workspace,path));
    CREATE TABLE IF NOT EXISTS memory_file_index_chunks(rowid INTEGER PRIMARY KEY AUTOINCREMENT,workspace TEXT NOT NULL,file_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(workspace,file_id,ordinal));
    CREATE TABLE IF NOT EXISTS memory_file_index_vectors(generation INTEGER NOT NULL,ref TEXT NOT NULL,passage INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(generation,ref,passage));
    CREATE TABLE IF NOT EXISTS memory_file_index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_file_index_withdrawn(source TEXT PRIMARY KEY);
  `)
  const meta = (name: string) => db.prepare('SELECT value FROM memory_file_index_meta WHERE key=?').get(name)?.value as string | undefined
  const setMeta = (name: string, value: string) => db.prepare('INSERT OR REPLACE INTO memory_file_index_meta VALUES(?,?)').run(name, value)
  if (!meta('salt')) setMeta('salt', randomBytes(32).toString('hex'))
  if (!meta('vectors')) setMeta('vectors', JSON.stringify({space: null, generation: 0, active: false}))
  const salt = meta('salt')!
  const token = (value: string) => 't' + createHmac('sha256', salt).update(value).digest('hex')
  const termsOf = (text: string) => memorySearchTokens(text, true).map(token).join(' ')
  const queryOf = (text: string) => [...new Set(memorySearchTokens(text, false))].map(token).join(' OR ')
  let lexicalReady = false
  function initializeFts(reset = false): boolean {
    try {
      reset ||= ['memory_file_index_fts', 'memory_file_index_node_fts'].some(table =>
        !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) || Boolean(meta('fts-dirty'))
      transaction(db, () => {
        for (const table of ['memory_file_index_fts', 'memory_file_index_node_fts']) {
          if (reset) db.exec(`DROP TABLE IF EXISTS ${table}`)
          db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(terms,content='',contentless_delete=1)`)
          db.exec(`INSERT INTO ${table}(${table},rank) VALUES('secure-delete',1)`)
        }
        if (reset) {
          const insertChunk = db.prepare('INSERT INTO memory_file_index_fts(rowid,terms) VALUES(?,?)')
          for (const row of db.prepare('SELECT rowid,payload FROM memory_file_index_chunks').iterate()) {
            const chunk = JSON.parse(String(row.payload)) as MemoryFilePassage
            insertChunk.run(Number(row.rowid), termsOf(chunk.searchText))
          }
          const insertNode = db.prepare('INSERT INTO memory_file_index_node_fts(rowid,terms) VALUES(?,?)')
          for (const row of db.prepare("SELECT rowid,payload FROM memory_file_index_nodes WHERE kind='digest'").iterate()) {
            const entry = JSON.parse(String(row.payload)) as MemoryFileNode
            insertNode.run(Number(row.rowid), termsOf(`${entry.name}
${entry.description}`))
          }
        }
        db.exec("INSERT INTO memory_file_index_fts(memory_file_index_fts) VALUES('integrity-check')")
        db.exec("INSERT INTO memory_file_index_node_fts(memory_file_index_node_fts) VALUES('integrity-check')")
        db.prepare("DELETE FROM memory_file_index_meta WHERE key='fts-dirty'").run()
      })
      return true
    } catch { return false }
  }
  lexicalReady = initializeFts()
  const snapshot = (workspace: string, id: string) => {
    const row = db.prepare('SELECT payload FROM memory_file_index_nodes WHERE workspace=? AND id=?').get(workspace, id)
    return row ? JSON.parse(String(row.payload)) as MemoryFileNode : null
  }
  const vectorState = (): MemoryVectorState => JSON.parse(meta('vectors')!) as MemoryVectorState
  const saveState = (state: MemoryVectorState) => { setMeta('vectors', JSON.stringify(state)) }
  const dirty = () => { setMeta('erase-pending', '1') }
  function recover() {
    if (!meta('erase-pending')) return
    checkpoint('before-truncate')
    if (truncateMemoryJournal(db)) db.prepare("DELETE FROM memory_file_index_meta WHERE key='erase-pending'").run()
  }
  function passages(file: MemoryFileSnapshot): MemoryFilePassage[] {
    const base = identity(node(file))
    return file.chunks.map((chunk, ordinal) => ({ ...chunk, file: base, ref: {workspace: file.workspace, fileId: file.id, ordinal, revision: file.revision, usageVersion: file.usageVersion, policyToken: file.policyToken} }))
  }
  const allChunks = () => db.prepare('SELECT payload FROM memory_file_index_chunks ORDER BY workspace,file_id,ordinal')
    .all().map(row => JSON.parse(String(row.payload)) as MemoryFilePassage)
  function chunks(authorized: readonly MemoryFileIdentity[]): MemoryFilePassage[] {
    const allowed = new Map(authorized.map(file => [JSON.stringify([file.workspace,file.id]), file]))
    return allChunks().filter(chunk => {
      const entry = allowed.get(JSON.stringify([chunk.file.workspace, chunk.file.id]))
      return Boolean(entry && entry.path === chunk.file.path && same(entry, chunk.file))
    })
  }
  function erase(file: Pick<MemoryFileIdentity, 'workspace' | 'id'>) {
    const rows = db.prepare('SELECT rowid,payload FROM memory_file_index_chunks WHERE workspace=? AND file_id=?').all(file.workspace, file.id)
    if (lexicalReady) try {
      for (const row of rows) db.prepare('DELETE FROM memory_file_index_fts WHERE rowid=?').run(Number(row.rowid))
      db.prepare('DELETE FROM memory_file_index_node_fts WHERE rowid IN (SELECT rowid FROM memory_file_index_nodes WHERE workspace=? AND id=?)')
        .run(file.workspace, file.id)
    } catch { lexicalReady = false; setMeta('fts-dirty','1'); db.exec('DROP TABLE IF EXISTS memory_file_index_fts; DROP TABLE IF EXISTS memory_file_index_node_fts') }
    if (!lexicalReady) { setMeta('fts-dirty','1'); db.exec('DROP TABLE IF EXISTS memory_file_index_fts; DROP TABLE IF EXISTS memory_file_index_node_fts') }
    for (const row of rows) db.prepare('DELETE FROM memory_file_index_vectors WHERE ref=?').run(key((JSON.parse(String(row.payload)) as MemoryFilePassage).ref))
    db.prepare('DELETE FROM memory_file_index_chunks WHERE workspace=? AND file_id=?').run(file.workspace,file.id)
    db.prepare('DELETE FROM memory_file_index_nodes WHERE workspace=? AND id=?').run(file.workspace,file.id)
    dirty()
  }
  function validate(file: MemoryFileSnapshot) {
    if (!/^[a-f0-9]{64}$/u.test(file.workspace) || !file.id || !file.revision || !file.policyToken || !Number.isSafeInteger(file.usageVersion) || file.usageVersion < 0 || !/^(daily|digest)\//u.test(file.path) || file.path.split('/').some(p => p === '..' || p === '.') || file.path.includes('\\')) throw new Error('invalid-file-snapshot')
    ;(file.kind === 'daily' ? dailyPath : digestPath).parse(file.path)
    for (const chunk of file.chunks) if (![chunk.startLine,chunk.endLine,chunk.startOffset,chunk.endOffset].every(Number.isSafeInteger) || chunk.startLine < 1 || chunk.endLine < chunk.startLine || chunk.startOffset < 0 || chunk.endOffset < chunk.startOffset || chunk.text.length !== chunk.endOffset - chunk.startOffset) throw new Error('invalid-file-chunk')
  }
  function accept(file: MemoryFileSnapshot, expected: MemoryFileVersion | null) {
    validate(file)
    return transaction(db, () => {
      const old = snapshot(file.workspace, file.id)
      if (old ? !expected || !same(old, expected) : expected !== null) return false
      if (file.sources.some(ref => db.prepare('SELECT 1 FROM memory_file_index_withdrawn WHERE source=?').get(ref.id))) return false
      const entry = passages(file)
      const nextNode = JSON.stringify(node(file))
      const nextChunks = entry.map(chunk => JSON.stringify(chunk))
      if (old && JSON.stringify(old) === nextNode) {
        const storedChunks = db.prepare('SELECT payload FROM memory_file_index_chunks WHERE workspace=? AND file_id=? ORDER BY ordinal').all(file.workspace, file.id)
        if (storedChunks.length === nextChunks.length && storedChunks.every((row, i) => String(row.payload) === nextChunks[i])) return true
      }
      if (old) erase(old)
      const inserted = db.prepare('INSERT INTO memory_file_index_nodes(workspace,id,path,kind,day,updated_at,payload) VALUES(?,?,?,?,?,?,?)')
        .run(file.workspace, file.id, file.path, file.kind, file.day ?? null, file.updatedAt, nextNode)
      if (lexicalReady && file.kind === 'digest') try {
        db.prepare('INSERT INTO memory_file_index_node_fts(rowid,terms) VALUES(?,?)').run(inserted.lastInsertRowid, termsOf(`${file.name}
${file.description}`))
      } catch { lexicalReady = false; setMeta('fts-dirty','1') }
      for (const [ordinal, payload] of nextChunks.entries()) {
        const row = db.prepare('INSERT INTO memory_file_index_chunks(workspace,file_id,ordinal,payload) VALUES(?,?,?,?)').run(file.workspace, file.id, ordinal, payload)
        if (lexicalReady) try { db.prepare('INSERT INTO memory_file_index_fts(rowid,terms) VALUES(?,?)').run(row.lastInsertRowid, termsOf(entry[ordinal]!.searchText)) } catch { lexicalReady = false; setMeta('fts-dirty','1') }
      }
      if (!lexicalReady) setMeta('fts-dirty','1')
      return true
    })
  }
  function fallback(query: string, candidates: MemoryFilePassage[]): MemoryFileHit[] {
    const terms = [...new Set(memorySearchTokens(query,false))]
    const documents = candidates.map(chunk => ({chunk,tokens: memorySearchTokens(chunk.searchText,true)}))
    const average = documents.reduce((sum,d) => sum+d.tokens.length,0) / Math.max(documents.length,1)
    return documents.map(({chunk,tokens}) => {
      let score = 0
      for (const term of terms) {
        const tf = tokens.filter(t => t === term).length
        if (!tf) continue
        const df = documents.filter(d => d.tokens.includes(term)).length
        score += Math.log(1+(documents.length-df+0.5)/(df+0.5))*tf*2.2/(tf+1.2*(0.25+0.75*tokens.length/Math.max(average,1)))
      }
      return {...chunk,score}
    }).filter(hit => hit.score > 0).sort((a,b) => b.score-a.score || key(a.ref).localeCompare(key(b.ref)))
  }
  function scopeArgs(scope: MemoryFileQueryScope) {
    return [JSON.stringify(scope.workspaces), scope.from ?? null, scope.through ?? null, scope.asOf ?? null]
  }
  const withinScope = `n.workspace IN (SELECT value FROM json_each(?))
    AND (n.kind <> 'daily' OR n.day IS NULL OR n.day >= coalesce(?,n.day))
    AND (n.kind <> 'daily' OR n.day IS NULL OR n.day <= coalesce(?,n.day))
    AND (n.updated_at = 0 OR n.updated_at <= coalesce(?,n.updated_at))`
  const chunksInScope = `JOIN memory_file_index_nodes n ON c.workspace=n.workspace AND c.file_id=n.id WHERE ${withinScope}`
  function passagePage(scope: MemoryFileQueryScope, limit: number, offset: number) {
    const rows = db.prepare(`SELECT c.payload FROM memory_file_index_chunks c ${chunksInScope}
      ORDER BY c.workspace,c.file_id,c.ordinal LIMIT ? OFFSET ?`).all(...scopeArgs(scope), limit + 1, offset)
    return page(rows.map(row => JSON.parse(String(row.payload)) as MemoryFilePassage), limit)
  }
  function lexicalCandidates(query: string, scope: MemoryFileQueryScope, limit: number, offset = 0) {
    const match = queryOf(query)
    if (!match || !limitOf(limit)) return { rows: [], incomplete: false, mode: lexicalReady ? 'fts' as const : 'fallback' as const }
    if (lexicalReady) try {
      const rows = db.prepare(`SELECT c.payload,bm25(memory_file_index_fts) AS rank FROM memory_file_index_fts
        JOIN memory_file_index_chunks c ON c.rowid=memory_file_index_fts.rowid ${chunksInScope}
        AND memory_file_index_fts MATCH ? ORDER BY rank,c.rowid LIMIT ? OFFSET ?`).all(...scopeArgs(scope), match, limit + 1, offset)
      return { ...page(rows.map(row => ({ ...(JSON.parse(String(row.payload)) as MemoryFilePassage), score: -Number(row.rank) })), limit), mode: 'fts' as const }
    } catch { lexicalReady = false; setMeta('fts-dirty','1') }
    const candidates = passagePage(scope, limit, offset)
    return { ...candidates, rows: fallback(query, candidates.rows), mode: 'fallback' as const }
  }
  function nodeCandidates(query: string, scope: MemoryFileQueryScope, limit: number, offset = 0) {
    const match = queryOf(query)
    if (!match || !limitOf(limit)) return { rows: [], incomplete: false }
    if (lexicalReady) try {
      const rows = db.prepare(`SELECT n.payload FROM memory_file_index_node_fts
        JOIN memory_file_index_nodes n ON n.rowid=memory_file_index_node_fts.rowid
        WHERE ${withinScope} AND memory_file_index_node_fts MATCH ?
        ORDER BY bm25(memory_file_index_node_fts),n.workspace,n.id LIMIT ? OFFSET ?`).all(...scopeArgs(scope), match, limit + 1, offset)
      return page(rows.map(row => JSON.parse(String(row.payload)) as MemoryFileNode), limit)
    } catch { lexicalReady = false; setMeta('fts-dirty','1') }
    const rows = db.prepare(`SELECT n.payload FROM memory_file_index_nodes n WHERE ${withinScope} AND n.kind='digest'
      ORDER BY n.workspace,n.id LIMIT ? OFFSET ?`).all(...scopeArgs(scope), limit + 1, offset)
    return page(rows.map(row => JSON.parse(String(row.payload)) as MemoryFileNode), limit)
  }
  function nodeAt(workspace: string, path: string) {
    const row = db.prepare('SELECT payload FROM memory_file_index_nodes WHERE workspace=? AND path=?').get(workspace, path)
    return row ? JSON.parse(String(row.payload)) as MemoryFileNode : null
  }
  const validVector = (vector: Float32Array, dimensions: number) => vector.length === dimensions && [...vector].every(Number.isFinite) && vector.some(v => v !== 0)
  function vectorsValid(state: MemoryVectorState) {
    if (!state.space) return false
    for (const row of db.prepare('SELECT vector FROM memory_file_index_vectors WHERE generation=?').iterate(state.generation)) {
      const data = row.vector as Uint8Array
      if (data.byteLength % 4 !== 0 || !validVector(new Float32Array(Uint8Array.from(data).buffer), state.space.dimensions)) return false
    }
    return true
  }
  function validSpace(space: MemoryVectorSpace) { if (!space.fingerprint || !Number.isSafeInteger(space.dimensions) || space.dimensions < 1) throw new Error('invalid-vector-space') }
  function beginVectors(space: MemoryVectorSpace) {
    validSpace(space)
    return transaction(db, () => {
      const state = vectorState()
      if (state.space?.fingerprint === space.fingerprint && state.space.dimensions === space.dimensions && vectorsValid(state)) return state.generation
      db.exec('DELETE FROM memory_file_index_vectors'); dirty()
      saveState({space,generation:state.generation+1,active:false})
      return state.generation+1
    })
  }
  function vectors(ref: MemoryFileChunkRef, state: MemoryVectorState): Float32Array[] {
    return db.prepare('SELECT vector FROM memory_file_index_vectors WHERE generation=? AND ref=? ORDER BY passage').all(state.generation,key(ref)).map(row => {
      const data = row.vector as Uint8Array
      return data.byteLength % 4 ? new Float32Array() : new Float32Array(Uint8Array.from(data).buffer)
    })
  }
  const covered = (ref: MemoryFileChunkRef, state: MemoryVectorState) => { const rows = vectors(ref,state); return rows.length > 0 && rows.every(v => validVector(v,state.space!.dimensions)) }
  function stageVectors(generation: number, records: readonly {ref: MemoryFileChunkRef,vectors:readonly Float32Array[]}[]) {
    return transaction(db, () => {
      const state = vectorState()
      if (generation !== state.generation || !state.space) return 0
      const acceptedChunk = db.prepare('SELECT payload FROM memory_file_index_chunks WHERE workspace=? AND file_id=? AND ordinal=?')
      let count = 0
      for (const record of records) {
        const { workspace, fileId, ordinal } = record.ref
        const row = acceptedChunk.get(workspace, fileId, ordinal)
        if (!row || key((JSON.parse(String(row.payload)) as MemoryFilePassage).ref) !== key(record.ref)) continue
        if (!record.vectors.length || !record.vectors.every(v => validVector(v,state.space!.dimensions))) throw new Error('invalid-passage-vectors')
        db.prepare('DELETE FROM memory_file_index_vectors WHERE generation=? AND ref=?').run(generation,key(record.ref))
        record.vectors.forEach((vector,passage) => db.prepare('INSERT INTO memory_file_index_vectors VALUES(?,?,?,?)').run(generation,key(record.ref),passage,new Uint8Array(vector.buffer,vector.byteOffset,vector.byteLength)))
        count++
      }
      return count
    })
  }
  function finishVectors(generation: number, expected: readonly MemoryFileChunkRef[]) {
    return transaction(db, () => {
      const state = vectorState(), current = allChunks().map(chunk => chunk.ref), expectedKeys = new Set(expected.map(key))
      if (state.generation !== generation || !state.space || expected.length !== expectedKeys.size || current.length !== expectedKeys.size || !current.every(ref => expectedKeys.has(key(ref)) && covered(ref,state))) return false
      saveState({...state,active:true}); return true
    })
  }
  function matchesVectorSpace(state: MemoryVectorState, space: MemoryVectorSpace, query: Float32Array) {
    return state.active && state.space?.fingerprint === space.fingerprint && state.space.dimensions === space.dimensions
      && validVector(query,space.dimensions)
  }
  function vectorScores(query: Float32Array, state: MemoryVectorState, candidates: readonly MemoryFilePassage[]) {
    const norm = Math.sqrt(query.reduce((sum,v) => sum+v*v,0))
    return candidates.flatMap(chunk => {
      const scores = vectors(chunk.ref,state).filter(v => validVector(v,state.space!.dimensions)).map(v => v.reduce((sum,value,i) => sum+value*query[i]!,0)/(norm*Math.sqrt(v.reduce((sum,value) => sum+value*value,0))))
      return scores.length ? [{...chunk,score:Math.max(...scores)}] : []
    }).sort((a,b) => b.score-a.score || key(a.ref).localeCompare(key(b.ref)))
  }
  function vector(query: Float32Array, space: MemoryVectorSpace, authorized: readonly MemoryFileIdentity[], limit: number) {
    const state = vectorState()
    return matchesVectorSpace(state, space, query) ? vectorScores(query,state,chunks(authorized)).slice(0,limitOf(limit)) : null
  }
  async function vectorCandidates(query: Float32Array, space: MemoryVectorSpace, scope: MemoryFileQueryScope, limit: number, current = () => true, deadline = Infinity) {
    const state = vectorState()
    if (!matchesVectorSpace(state, space, query)) return null
    if (!limitOf(limit)) return { rows: [], incomplete: false }
    const chunksPage = db.prepare(`SELECT c.file_id,c.ordinal,json_extract(c.payload,'$.ref') AS ref
      FROM memory_file_index_chunks c JOIN memory_file_index_nodes n ON n.workspace=c.workspace AND n.id=c.file_id
      WHERE c.workspace=? AND (c.file_id,c.ordinal) > (?,?)
      AND (n.kind <> 'daily' OR n.day IS NULL OR n.day >= coalesce(?,n.day))
      AND (n.kind <> 'daily' OR n.day IS NULL OR n.day <= coalesce(?,n.day))
      AND (n.updated_at = 0 OR n.updated_at <= coalesce(?,n.updated_at))
      ORDER BY c.file_id,c.ordinal LIMIT 32`)
    const scored = db.prepare('SELECT vector FROM memory_file_index_vectors WHERE generation=? AND ref=?')
    const lookup = db.prepare('SELECT payload FROM memory_file_index_chunks WHERE workspace=? AND file_id=? AND ordinal=?')
    type Match = { ref: MemoryFileChunkRef, score: number, key: string }
    const matches: Match[] = []
    const rank = (a: Match, b: Match) => b.score - a.score || a.key.localeCompare(b.key)
    const norm = Math.sqrt(query.reduce((sum, v) => sum + v*v, 0))
    let incomplete = false, yieldAt = performance.now() + 4
    search: for (const workspace of scope.workspaces) {
      let fileId = '', ordinal = -1
      do {
        if (!current() || performance.now() >= deadline) { incomplete = true; break search }
        const rows = chunksPage.all(workspace, fileId, ordinal, scope.from ?? null, scope.through ?? null, scope.asOf ?? null)
        for (const row of rows) {
          fileId = String(row.file_id); ordinal = Number(row.ordinal)
          const ref = JSON.parse(String(row.ref)) as MemoryFileChunkRef
          const tag = key(ref)
          let score = -Infinity
          for (const item of scored.iterate(state.generation, tag)) {
            const bytes = item.vector as Uint8Array
            if (bytes.byteLength !== query.byteLength) continue
            const vector = new Float32Array(Uint8Array.from(bytes).buffer)
            let dot = 0, squared = 0
            for (let i = 0; i < vector.length; i++) {
              dot += vector[i]! * query[i]!
              squared += vector[i]! * vector[i]!
            }
            if (squared > 0) score = Math.max(score, dot / (norm * Math.sqrt(squared)))
          }
          if (Number.isFinite(score)) matches.push({ ref, score, key: tag })
        }
        if (matches.length > limit) { matches.sort(rank); matches.length = limit; incomplete = true }
        if (rows.length < 32) break
        if (performance.now() >= yieldAt) {
          await new Promise<void>(resolve => setImmediate(resolve))
          yieldAt = performance.now() + 4
        }
      } while (true)
    }
    // A caller can retire the owner or replace a generation while scoring yielded.
    if (!current()) return { rows: [], incomplete: true }
    if (vectorState().generation !== state.generation) return null
    const rows = matches.sort(rank).flatMap(({ ref, score, key: tag }) => {
      const row = lookup.get(ref.workspace, ref.fileId, ref.ordinal)
      const passage = row && JSON.parse(String(row.payload)) as MemoryFilePassage | undefined
      return passage && key(passage.ref) === tag ? [{ ...passage, score }] : []
    })
    return { rows, incomplete }
  }
  return {
    accept, snapshot, chunks, beginVectors, vectorState, stageVectors, finishVectors, vector,
    lexicalCandidates, nodeCandidates, vectorCandidates, nodeAt,
    digestNodes: workspace => db.prepare("SELECT payload FROM memory_file_index_nodes WHERE workspace=? AND kind='digest'").all(workspace)
      .map(row => JSON.parse(String(row.payload)) as MemoryFileNode),
    files: workspaces => db.prepare('SELECT payload FROM memory_file_index_nodes WHERE workspace IN (SELECT value FROM json_each(?)) ORDER BY workspace,id')
      .all(JSON.stringify(workspaces)).map(row => identity(JSON.parse(String(row.payload)) as MemoryFileNode)),
    remove(file) { return transaction(db, () => { const old=snapshot(file.workspace,file.id); if (!old || old.path !== file.path || !same(old,file)) return false; erase(old); return true }) },
    missingVectors(generation) { const state=vectorState(); return state.generation !== generation || !state.space ? [] : allChunks().filter(chunk => !covered(chunk.ref,state)) },
    reindex() { lexicalReady=initializeFts(true); const state=vectorState(); transaction(db, () => { db.exec('DELETE FROM memory_file_index_vectors'); dirty(); saveState({...state,generation:state.generation+1,active:false}) }); return {lexical:lexicalReady,vectorGeneration:state.generation+1} },
    withdraw(sourceId) {
      transaction(db, () => {
        db.prepare('INSERT OR IGNORE INTO memory_file_index_withdrawn VALUES(?)').run(sourceId)
        for (const row of db.prepare('SELECT payload FROM memory_file_index_nodes ORDER BY workspace,id').all()) {
          const file = JSON.parse(String(row.payload)) as MemoryFileNode
          if (file.sources.some(ref => ref.id === sourceId)) erase(file)
        }
        dirty()
      })
    },
    recover, pendingCleanup: () => meta('erase-pending') ? 1 : 0,
  }
}
