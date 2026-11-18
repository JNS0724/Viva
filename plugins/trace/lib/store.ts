import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { Step } from './steps.ts'
import type { ModelCallDetail, ModelCallSummary, ModelRequest } from '../../../src/shared/trace.ts'

/**
 * trace.db: the steps and model requests of every turn, written by the trace plugin inside dsh and read by the app.
 * The steps contract remains compatible with version 1; version 2 adds full model requests for the detail view.
 */
export const CONTRACT_VERSION = 2
const MAX_STEPS = 100_000
const MAX_CALLS = 20_000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS steps (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    call_id TEXT,
    name TEXT,
    args TEXT,
    text TEXT,
    status TEXT,
    result TEXT,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE IF NOT EXISTS calls (
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    step INTEGER NOT NULL,
    at INTEGER NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    duration_ms INTEGER,
    request_json TEXT,
    PRIMARY KEY (session_id, turn, step)
  );
  CREATE TABLE IF NOT EXISTS request_erasure_holds (effect TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(effect,session_id));
  CREATE INDEX IF NOT EXISTS request_erasure_sessions ON request_erasure_holds(session_id);
  CREATE TABLE IF NOT EXISTS request_erasure_done (effect TEXT PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS hold_erased_request BEFORE INSERT ON calls
    WHEN EXISTS(SELECT 1 FROM request_erasure_holds WHERE session_id = NEW.session_id)
    BEGIN SELECT RAISE(IGNORE); END;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

export function traceStepDigest(step: Step) {
  const payload = step.kind === 'thought' ? [step.text] : [step.callId, step.name, step.args]
  return createHash('sha256').update(JSON.stringify([step.kind, step.seq, step.at, payload])).digest('hex')
}

interface StepRow {
  session_id: string, seq: number, at: number, kind: string, call_id: string | null, name: string | null,
  args: string | null, text: string | null, status: string | null, result: string | null
}
interface CallRow {
  session_id: string, turn: number, step: number, at: number, status: ModelCallSummary['status'], provider: string, model: string,
  attempts: number, input_tokens: number | null, output_tokens: number | null, duration_ms: number | null, request_json: string | null
}

const toStep = (row: StepRow): Step => (row.kind === 'thought'
  ? { seq: row.seq, at: row.at, kind: 'thought', text: row.text ?? '' }
  : { seq: row.seq, at: row.at, kind: 'tool', callId: row.call_id ?? '', name: row.name ?? '', args: JSON.parse(row.args ?? '{}'), status: row.status ?? '',
      ...(row.result ? { result: JSON.parse(row.result) } : {}) })
const toCall = (row: CallRow): ModelCallSummary => ({
  sessionId: row.session_id, turn: row.turn, step: row.step, at: row.at, status: row.status,
  provider: row.provider, model: row.model, attempts: row.attempts,
  inputTokens: row.input_tokens, outputTokens: row.output_tokens, durationMs: row.duration_ms,
})
function toDetail(row: CallRow): ModelCallDetail {
  let request: ModelRequest | null = null
  if (row.request_json) {
    try { request = JSON.parse(row.request_json) as ModelRequest } catch { request = null }
  }
  return { call: toCall(row), request }
}

export function openTraceDb({ file }: { file: string }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try { return bindTraceDb(db) }
  catch (error) { db.close(); throw error }
}

function bindTraceDb(db: DatabaseSync) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 3000;')
  db.exec(SCHEMA)
  if (!(db.prepare('PRAGMA table_info(steps)').all() as Array<{ name: string }>).some(column => column.name === 'result')) {
    db.exec('ALTER TABLE steps ADD COLUMN result TEXT')
  }
  const sql = {
    upsert: db.prepare(`INSERT INTO steps (session_id, seq, at, kind, call_id, name, args, text, status, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, seq) DO UPDATE SET status = excluded.status, result = excluded.result`),
    ofSession: db.prepare('SELECT * FROM steps WHERE session_id = ? AND at <= ? ORDER BY seq'),
    hasSession: db.prepare('SELECT 1 AS found FROM steps WHERE session_id = ? LIMIT 1'),
    newest: db.prepare('SELECT MAX(rowid) AS id FROM steps'),
    prune: db.prepare('DELETE FROM steps WHERE rowid <= ? - ?'),
    atPosition: db.prepare('SELECT * FROM steps WHERE session_id=? AND seq=?'),
    remove: db.prepare('DELETE FROM steps WHERE session_id=? AND seq=?'),
    upsertCall: db.prepare(`INSERT INTO calls (session_id, turn, step, at, status, provider, model, attempts, input_tokens, output_tokens, duration_ms, request_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, turn, step) DO UPDATE SET
        at=excluded.at, status=excluded.status, provider=excluded.provider, model=excluded.model, attempts=excluded.attempts,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, duration_ms=excluded.duration_ms,
        request_json=COALESCE(excluded.request_json, calls.request_json)`),
    callOf: db.prepare('SELECT * FROM calls WHERE session_id=? AND turn=? AND step=?'),
    callsOf: db.prepare('SELECT * FROM calls WHERE session_id=? AND at<=? ORDER BY at, turn, step'),
    hasCalls: db.prepare('SELECT 1 AS found FROM calls WHERE session_id=? LIMIT 1'),
    newestCall: db.prepare('SELECT MAX(rowid) AS id FROM calls'),
    pruneCalls: db.prepare('DELETE FROM calls WHERE rowid <= ? - ?'),
    eraseCalls: db.prepare('DELETE FROM calls WHERE session_id=?'),
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  }

  const found = Number(sql.meta.get('contract_version')?.value ?? 0)
  if (found > CONTRACT_VERSION) throw new Error(`trace.db 由更新的版本（约定 ${found}）写入，当前只支持到 ${CONTRACT_VERSION}`)
  if (found < CONTRACT_VERSION) sql.setMeta.run('contract_version', String(CONTRACT_VERSION))

  function recordSteps(sessionId: string, steps: readonly Step[]) {
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const step of steps) {
        const tool = step.kind === 'tool'
        sql.upsert.run(String(sessionId), step.seq, step.at, step.kind, tool ? step.callId : null, tool ? step.name : null,
          tool ? JSON.stringify(step.args ?? {}) : null, tool ? null : step.text, tool ? step.status : null, tool ? JSON.stringify(step.result ?? null) : null)
      }
      sql.prune.run(Number(sql.newest.get()?.id ?? 0), MAX_STEPS)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  function recordCall(call: ModelCallSummary, request?: ModelRequest) {
    const id = String(call.sessionId)
    sql.upsertCall.run(id, call.turn, call.step, call.at, call.status, call.provider, call.model, call.attempts,
      call.inputTokens, call.outputTokens, call.durationMs, request ? JSON.stringify(request) : null)
    sql.pruneCalls.run(Number(sql.newestCall.get()?.id ?? 0), MAX_CALLS)
  }

  function checkpointErasure() {
    db.exec('PRAGMA busy_timeout=0')
    try {
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      return checkpoint?.busy === 0 && checkpoint.log === checkpoint.checkpointed
    } finally { db.exec('PRAGMA busy_timeout=3000') }
  }

  // Live callbacks and retries use a separate connection. The trigger fences both
  // until the cold owner verifies the rewritten native inputs, including fork copies.
  function eraseSessionRequests(effect: string, sessions: readonly string[], verifiedCold = false) {
    if (db.prepare('SELECT 1 FROM request_erasure_done WHERE effect=?').get(effect)) return
    db.exec('BEGIN IMMEDIATE')
    try {
      const hold = db.prepare('INSERT OR IGNORE INTO request_erasure_holds VALUES (?,?)')
      for (const session of new Set(sessions)) {
        hold.run(effect, session)
        sql.eraseCalls.run(session)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    if (!checkpointErasure()) throw new Error('Model request erasure awaits a durable checkpoint')
    if (verifiedCold) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('DELETE FROM request_erasure_holds WHERE effect=?').run(effect)
        db.prepare('INSERT OR IGNORE INTO request_erasure_done VALUES (?)').run(effect)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }

  function eraseSteps(sessionId: string, positions: readonly { seq: number, digest: string }[]) {
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const { seq, digest } of positions) {
        const row = sql.atPosition.get(sessionId, seq) as unknown as StepRow | undefined
        if (row && traceStepDigest(toStep(row)) === digest) sql.remove.run(sessionId, seq)
      }
      // A request contains history as well as the step being replaced. Deleting the session's requests is the only
      // conservative erasure that cannot leave a later prompt carrying the erased content.
      if (positions.length) sql.eraseCalls.run(sessionId)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    if (!checkpointErasure()) return false
    if (!sql.meta.get('secure-erasure')) {
      db.exec('VACUUM')
      sql.setMeta.run('secure-erasure', '1')
      return checkpointErasure()
    }
    return true
  }

  return {
    recordSteps, recordCall, eraseSteps, eraseSessionRequests,
    stepsOf: (sessionId: string, until = Number.MAX_SAFE_INTEGER): Step[] => (sql.ofSession.all(String(sessionId), until) as unknown as StepRow[]).map(toStep),
    callOf: (sessionId: string, turn: number, step: number): ModelCallDetail | null => {
      const row = sql.callOf.get(String(sessionId), turn, step) as unknown as CallRow | undefined
      return row ? toDetail(row) : null
    },
    callsOf: (sessionId: string, until = Number.MAX_SAFE_INTEGER): ModelCallSummary[] =>
      (sql.callsOf.all(String(sessionId), until) as unknown as CallRow[]).map(toCall),
    hasSession: (sessionId: string) => Boolean(sql.hasSession.get(String(sessionId)) || sql.hasCalls.get(String(sessionId))),
    close: () => db.close(),
  }
}
