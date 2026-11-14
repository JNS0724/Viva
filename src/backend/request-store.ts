import type { DatabaseSync } from 'node:sqlite'
import type { Action, Plan, Receipt } from '../shared/request-routing/protocol.ts'

/**
 * The main agent's requests, the decisions accepted for them and what became of each action
 * (docs/agent-routing-design.md §11), in the app database (app-db.ts), written only by the request runtime
 * (request-runtime.ts), each change with its event. A request keeps where it came from, never the user's words:
 * those stay in the session and the history.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS routing_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    conversation_id TEXT,
    cwd TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    failure TEXT,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS routing_requests_status ON routing_requests (status);
  CREATE TABLE IF NOT EXISTS routing_decisions (
    request_id TEXT PRIMARY KEY REFERENCES routing_requests (id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    decided_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS routing_actions (
    request_id TEXT NOT NULL REFERENCES routing_requests (id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    task_id TEXT,
    error TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (request_id, idx)
  );
  CREATE INDEX IF NOT EXISTS routing_actions_status ON routing_actions (status);
`

/** A question asked, or words said while the agent was answering. */
export type RequestKind = 'prompt' | 'interjection'
/** Received until decided; failed when it got no decision (failure says why). */
export type RequestStatus = 'received' | 'decided' | 'failed'
/**
 * pending: a task action accepted, not carried out yet; uncertain: the app stopped before its receipt was kept, so
 * whether it happened is not known (it is never sent again).
 */
export type ActionStatus = 'pending' | 'done' | 'failed' | 'uncertain'

export interface StoredRequest {
  id: string
  sessionId: string
  conversationId: string | null
  cwd: string | null
  kind: RequestKind
  status: RequestStatus
  failure: string | null
  receivedAt: number
}

type Row = { id: string, session_id: string, conversation_id: string | null, cwd: string | null, kind: string, status: string, failure: string | null, received_at: number }
const fromRow = (row: Row): StoredRequest => ({
  id: row.id, sessionId: row.session_id, conversationId: row.conversation_id, cwd: row.cwd,
  kind: row.kind as RequestKind, status: row.status as RequestStatus, failure: row.failure, receivedAt: Number(row.received_at),
})

/** Task actions wait for their receipt; the others (an answer, a question, leave for an app tool) are done once accepted. */
const initialStatus = (action: Action): ActionStatus => (action.kind === 'start' || action.kind === 'message' || action.kind === 'stop' ? 'pending' : 'done')

export function createRequestStore({ db }: { db: DatabaseSync }) {
  db.exec(SCHEMA)
  const insert = db.prepare(`INSERT INTO routing_requests (id, session_id, conversation_id, cwd, kind, status, received_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`)
  const byId = db.prepare('SELECT * FROM routing_requests WHERE id = ?')
  const setStatus = db.prepare('UPDATE routing_requests SET status = ?, failure = ?, updated_at = ? WHERE id = ? AND status = ?')
  const putDecision = db.prepare('INSERT INTO routing_decisions (request_id, plan, decided_at) VALUES (?, ?, ?)')
  const putAction = db.prepare('INSERT INTO routing_actions (request_id, idx, kind, status, updated_at) VALUES (?, ?, ?, ?, ?)')
  const settleAction = db.prepare("UPDATE routing_actions SET status = ?, task_id = ?, error = ?, updated_at = ? WHERE request_id = ? AND idx = ? AND status = 'pending'")
  const actionsOf = db.prepare('SELECT idx, kind, status, task_id, error FROM routing_actions WHERE request_id = ? ORDER BY idx')
  const undecided = db.prepare("SELECT id FROM routing_requests WHERE status = 'received' ORDER BY received_at")
  const undecidedOf = db.prepare("SELECT id FROM routing_requests WHERE status = 'received' AND session_id = ? ORDER BY received_at")
  const unsettled = db.prepare("SELECT COUNT(*) AS n FROM routing_actions WHERE status = 'pending'")
  const markUncertain = db.prepare("UPDATE routing_actions SET status = 'uncertain', updated_at = ? WHERE status = 'pending'")

  return {
    add(request: { id: string, sessionId: string, conversationId: string | null, cwd: string | null, kind: RequestKind, at: number }) {
      insert.run(request.id, request.sessionId, request.conversationId, request.cwd, request.kind, request.at, request.at)
    },
    get(id: string): StoredRequest | null {
      const row = byId.get(id) as Row | undefined
      return row ? fromRow(row) : null
    },
    /** Only a request still received takes a decision, with a row for each of its actions; false when it did not. */
    decide(id: string, plan: Plan, at: number): boolean {
      if (Number(setStatus.run('decided', null, at, id, 'received').changes) !== 1) return false
      putDecision.run(id, JSON.stringify(plan), at)
      plan.actions.forEach((action, idx) => putAction.run(id, idx, action.kind, initialStatus(action), at))
      return true
    },
    /** What became of a pending action; false when it was settled already. */
    settle(id: string, idx: number, receipt: Receipt, at: number): boolean {
      const status: ActionStatus = receipt.ok ? 'done' : 'failed'
      const taskId = receipt.ok ? receipt.taskId ?? null : null
      return Number(settleAction.run(status, taskId, receipt.ok ? null : receipt.error, at, id, idx).changes) === 1
    },
    actions: (id: string) => (actionsOf.all(id) as Array<{ idx: number, kind: string, status: string, task_id: string | null, error: string | null }>)
      .map(row => ({ idx: Number(row.idx), kind: row.kind as Action['kind'], status: row.status as ActionStatus, taskId: row.task_id, error: row.error })),
    /** Only a request still received can fail; false when it did not. */
    fail(id: string, failure: string, at: number): boolean {
      return Number(setStatus.run('failed', failure, at, id, 'received').changes) === 1
    },
    /** Requests still waiting for a decision: of one session, or all of them. */
    undecided: (sessionId?: string): string[] => ((sessionId === undefined ? undecided.all() : undecidedOf.all(sessionId)) as Array<{ id: string }>).map((row) => row.id),
    /** How many task actions wait for their receipt. */
    unsettled: (): number => Number((unsettled.get() as { n: number }).n),
    /** Every action still pending (the app stopped before its receipt): uncertain from now on. */
    markUncertain: (at: number) => Number(markUncertain.run(at).changes),
  }
}

export type RequestStore = ReturnType<typeof createRequestStore>
