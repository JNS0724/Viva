import { createHmac, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryFileIndex, MemoryFileSnapshot, MemoryFileIdentity, MemoryFileVersion, MemoryFilePassage, MemoryFileChunkRef, MemoryFileHit, MemoryVectorState, MemoryVectorSpace } from '../core/ports/file-index.ts'
import { dailyPath, digestPath } from '../contracts/memory-file-contract.ts'
import { memorySearchTokens } from '../core/search-tokens.ts'
import { transaction, truncateMemoryJournal } from './sqlite.ts'

const same = (a: MemoryFileVersion, b: MemoryFileVersion) => a.revision === b.revision && a.usageVersion === b.usageVersion && a.policyToken === b.policyToken
const key = (ref: MemoryFileChunkRef) => JSON.stringify([ref.workspace, ref.fileId, ref.ordinal, ref.revision, ref.usageVersion, ref.policyToken])
const identity = ({ chunks: _chunks, links: _links, name: _name, description: _description, ...file }: MemoryFileSnapshot): MemoryFileIdentity => file
const limitOf = (limit: number) => Number.isSafeInteger(limit) && limit > 0 ? limit : 0

/** Accepted projections are the only inputs. This adapter deliberately has no filesystem dependency. */
export function openMemoryFileIndex({ db, checkpoint = () => {} }: { db: DatabaseSync, now?: () => number, checkpoint?: (point: string) => void }): MemoryFileIndex {
  db.exec(`PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS memory_file_index_nodes(workspace TEXT NOT NULL,id TEXT NOT NULL,path TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace,id),UNIQUE(workspace,path));
    CREATE TABLE IF NOT EXISTS memory_file_index_chunks(rowid INTEGER PRIMARY KEY AUTOINCREMENT,workspace TEXT NOT NULL,file_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(workspace,file_id,ordinal));
    CREATE TABLE IF NOT EXISTS memory_file_index_vectors(generation INTEGER NOT NULL,ref TEXT NOT NULL,passage INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(generation,ref,passage));
    CREATE TABLE IF NOT EXISTS memory_file_index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_file_index_withdrawn(source TEXT PRIMARY KEY);
  `)
  const meta = (name: string) => db.prepare('SELECT value FROM memory_file_index_meta WHERE key=?').get(name)?.value as string | undefined
  const setMeta = (name: string, value: string) => db.prepare('INSERT OR REPLACE INTO memory_file_index_meta VALUES(?,?)').run(name, value)
  if (!meta('salt')) setMeta('salt', randomBytes(32).toString('hex'))
  if (!meta('vectors')) setMeta('vectors', JSON.stringify({space: null, generation: 0, active: false}))
  const token = (value: string) => 't' + createHmac('sha256', meta('salt')!).update(value).digest('hex')
  let lexicalReady = false
  function initializeFts(reset = false): boolean {
    try {
      reset ||= !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_file_index_fts'").get() || Boolean(meta('fts-dirty'))
      transaction(db, () => {
        if (reset) db.exec('DROP TABLE IF EXISTS memory_file_index_fts')
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_file_index_fts USING fts5(terms,content='',contentless_delete=1)")
        db.exec("INSERT INTO memory_file_index_fts(memory_file_index_fts,rank) VALUES('secure-delete',1)")
        if (reset) for (const row of db.prepare('SELECT rowid,payload FROM memory_file_index_chunks').all()) {
          const chunk = JSON.parse(String(row.payload)) as MemoryFilePassage
          db.prepare('INSERT INTO memory_file_index_fts(rowid,terms) VALUES(?,?)').run(Number(row.rowid), memorySearchTokens(chunk.searchText, true).map(token).join(' '))
        }
        db.exec("INSERT INTO memory_file_index_fts(memory_file_index_fts) VALUES('integrity-check')")
        db.prepare("DELETE FROM memory_file_index_meta WHERE key='fts-dirty'").run()
      })
      return true
    } catch { return false }
  }
  lexicalReady = initializeFts()
  const snapshots = () => db.prepare('SELECT payload FROM memory_file_index_nodes ORDER BY workspace,id').all().map(row => JSON.parse(String(row.payload)) as MemoryFileSnapshot)
  const snapshot = (workspace: string, id: string) => {
    const row = db.prepare('SELECT payload FROM memory_file_index_nodes WHERE workspace=? AND id=?').get(workspace, id)
    return row ? JSON.parse(String(row.payload)) as MemoryFileSnapshot : null
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
    return file.chunks.map((chunk, ordinal) => ({ ...chunk, file: identity(file), ref: {workspace: file.workspace, fileId: file.id, ordinal, revision: file.revision, usageVersion: file.usageVersion, policyToken: file.policyToken} }))
  }
  const allChunks = () => snapshots().flatMap(passages)
  function chunks(authorized: readonly MemoryFileIdentity[]): MemoryFilePassage[] {
    const allowed = new Map(authorized.map(file => [JSON.stringify([file.workspace,file.id]), file]))
    return snapshots().filter(file => { const a = allowed.get(JSON.stringify([file.workspace,file.id])); return a && a.path === file.path && same(a,file) }).flatMap(passages)
  }
  function erase(file: MemoryFileSnapshot) {
    const rows = db.prepare('SELECT rowid FROM memory_file_index_chunks WHERE workspace=? AND file_id=?').all(file.workspace,file.id)
    if (lexicalReady) try {
      for (const row of rows) db.prepare('DELETE FROM memory_file_index_fts WHERE rowid=?').run(Number(row.rowid))
    } catch { lexicalReady = false; setMeta('fts-dirty','1'); db.exec('DROP TABLE IF EXISTS memory_file_index_fts') }
    if (!lexicalReady) { setMeta('fts-dirty','1'); db.exec('DROP TABLE IF EXISTS memory_file_index_fts') }
    for (const chunk of passages(file)) db.prepare('DELETE FROM memory_file_index_vectors WHERE ref=?').run(key(chunk.ref))
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
      const old = snapshot(file.workspace,file.id)
      if (old ? !expected || !same(old,expected) : expected !== null) return false
      if (file.sources.some(ref => db.prepare('SELECT 1 FROM memory_file_index_withdrawn WHERE source=?').get(ref.id))) return false
      if (old && JSON.stringify(old) === JSON.stringify(file)) return true
      if (old) erase(old)
      db.prepare('INSERT INTO memory_file_index_nodes VALUES(?,?,?,?)').run(file.workspace,file.id,file.path,JSON.stringify(file))
      for (const chunk of passages(file)) {
        const row = db.prepare('INSERT INTO memory_file_index_chunks(workspace,file_id,ordinal,payload) VALUES(?,?,?,?)').run(file.workspace,file.id,chunk.ref.ordinal,JSON.stringify(chunk))
        if (lexicalReady) try { db.prepare('INSERT INTO memory_file_index_fts(rowid,terms) VALUES(?,?)').run(row.lastInsertRowid,memorySearchTokens(chunk.searchText,true).map(token).join(' ')) } catch { lexicalReady = false; setMeta('fts-dirty','1') }
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
  function lexical(query: string, authorized: readonly MemoryFileIdentity[], limit: number): {hits: MemoryFileHit[],mode:'fts'|'fallback'} {
    const candidates = chunks(authorized), terms = [...new Set(memorySearchTokens(query,false))]
    if (!terms.length || !limitOf(limit)) return {hits:[],mode:lexicalReady?'fts':'fallback'}
    if (lexicalReady) try {
      const allowed = new Map(candidates.map(chunk => [key(chunk.ref),chunk]))
      // No SQL LIMIT before authorization: inaccessible records cannot exhaust the requested quota.
      const rows = db.prepare('SELECT c.payload,bm25(memory_file_index_fts) AS rank FROM memory_file_index_fts JOIN memory_file_index_chunks c ON c.rowid=memory_file_index_fts.rowid WHERE memory_file_index_fts MATCH ? ORDER BY rank,c.rowid').all(terms.map(token).join(' OR '))
      const hits: MemoryFileHit[] = []
      for (const row of rows) {
        const stored = JSON.parse(String(row.payload)) as MemoryFilePassage, chunk = allowed.get(key(stored.ref))
        if (chunk) hits.push({...chunk,score:-Number(row.rank)})
        if (hits.length === limit) break
      }
      return {hits,mode:'fts'}
    } catch { lexicalReady = false; setMeta('fts-dirty','1') }
    return {hits:fallback(query,candidates).slice(0,limitOf(limit)),mode:'fallback'}
  }
  function validSpace(space: MemoryVectorSpace) { if (!space.fingerprint || !Number.isSafeInteger(space.dimensions) || space.dimensions < 1) throw new Error('invalid-vector-space') }
  function beginVectors(space: MemoryVectorSpace) {
    validSpace(space)
    return transaction(db, () => {
      const state = vectorState()
      if (state.space?.fingerprint === space.fingerprint && state.space.dimensions === space.dimensions) return state.generation
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
  const validVector = (vector: Float32Array, dimensions: number) => vector.length === dimensions && [...vector].every(Number.isFinite) && vector.some(v => v !== 0)
  const covered = (ref: MemoryFileChunkRef, state: MemoryVectorState) => { const rows = vectors(ref,state); return rows.length > 0 && rows.every(v => validVector(v,state.space!.dimensions)) }
  function stageVectors(generation: number, records: readonly {ref: MemoryFileChunkRef,vectors:readonly Float32Array[]}[]) {
    return transaction(db, () => {
      const state = vectorState()
      if (generation !== state.generation || !state.space) return 0
      const current = new Set(allChunks().map(chunk => key(chunk.ref)))
      let count = 0
      for (const record of records) {
        if (!current.has(key(record.ref))) continue
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
  function vector(query: Float32Array, space: MemoryVectorSpace, authorized: readonly MemoryFileIdentity[], limit: number) {
    const state = vectorState()
    if (!state.active || state.space?.fingerprint !== space.fingerprint || state.space.dimensions !== space.dimensions || !validVector(query,space.dimensions)) return null
    const norm = Math.sqrt(query.reduce((sum,v) => sum+v*v,0))
    return chunks(authorized).flatMap(chunk => {
      const scores = vectors(chunk.ref,state).filter(v => validVector(v,space.dimensions)).map(v => v.reduce((sum,value,i) => sum+value*query[i]!,0)/(norm*Math.sqrt(v.reduce((sum,value) => sum+value*value,0))))
      return scores.length ? [{...chunk,score:Math.max(...scores)}] : []
    }).sort((a,b) => b.score-a.score || key(a.ref).localeCompare(key(b.ref))).slice(0,limitOf(limit))
  }
  return {
    accept, snapshot, chunks, lexical, beginVectors, vectorState, stageVectors, finishVectors, vector,
    files: workspaces => snapshots().filter(file => workspaces.includes(file.workspace)).map(identity),
    remove(file) { return transaction(db, () => { const old=snapshot(file.workspace,file.id); if (!old || old.path !== file.path || !same(old,file)) return false; erase(old); return true }) },
    missingVectors(generation) { const state=vectorState(); return state.generation !== generation || !state.space ? [] : allChunks().filter(chunk => !covered(chunk.ref,state)) },
    reindex() { lexicalReady=initializeFts(true); const state=vectorState(); transaction(db, () => { db.exec('DELETE FROM memory_file_index_vectors'); dirty(); saveState({...state,generation:state.generation+1,active:false}) }); return {lexical:lexicalReady,vectorGeneration:state.generation+1} },
    withdraw(sourceId) { transaction(db, () => { db.prepare('INSERT OR IGNORE INTO memory_file_index_withdrawn VALUES(?)').run(sourceId); for (const file of snapshots()) if (file.sources.some(ref => ref.id === sourceId)) erase(file); dirty() }) },
    recover, pendingCleanup: () => meta('erase-pending') ? 1 : 0,
  }
}
