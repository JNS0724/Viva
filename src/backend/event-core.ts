import type { AppDb } from './app-db.ts'

/**
 * The backend's event core (docs/backend-split-design.md §6, D4, D7). Every input is a signal of a closed kind,
 * routed by code (a route for each kind, checked by the type system); every change of the backend's state goes
 * through `apply`, which writes it and its event in one transaction and numbers the event; every push to the shell
 * carries a number: a stored event its own, a transient push (streamed text, live task snapshots) the latest stored
 * one, marked transient. After a disconnect the shell asks for what came after the last number it saw (`since`).
 */
export type Signal =
  /** The user asked something in the conversation (agent:prompt). */
  | { kind: 'chat.said', text: string, images: readonly unknown[] }
  /** A turn of the user's, or a background task of theirs, ended (acp-bridge turn_end / task_end). */
  | { kind: 'agent.turn_ended' }
  | { kind: 'agent.task_ended' }
  /** The model proposed a follow-up (viva-followups), for a card the user decides on. */
  | { kind: 'agent.followup_proposed', event: { type: string, proposal: unknown, [field: string]: unknown } }
  /** A reminder's time came (followup-notifier's timer). */
  | { kind: 'clock.reminder_due' }
  /** Something was due for background preparation (prepare-scheduler's timer). */
  | { kind: 'clock.prepare_window' }
  /** The computer woke or was unlocked. */
  | { kind: 'system.woke' }
  /** The user came back to the computer after a while away (createGapWatch). */
  | { kind: 'system.user_returned' }
  /** The window came to the front. */
  | { kind: 'window.foreground' }

export type SignalKind = Signal['kind']
export type SignalOf<K extends SignalKind> = Extract<Signal, { kind: K }>
/** A route for every kind of signal; one missing fails the type check. */
export type Routes = { readonly [K in SignalKind]: (signal: SignalOf<K>) => unknown }

/** What the shell is pushed. */
export type Push = { type: string, seq: number, transient?: true, [field: string]: unknown }
export type StoredEvent = { seq: number, at: number, kind: string, data: Record<string, unknown> }

/** Signals worth no row of their own: they say nothing new about the backend's state and come often. */
const UNRECORDED: ReadonlySet<SignalKind> = new Set(['window.foreground'])
/** What of a signal is recorded: its kind and its shape, never what the user said or a model wrote. */
function signalData(signal: Signal): Record<string, unknown> {
  if (signal.kind === 'chat.said') return { chars: signal.text.length, images: signal.images.length }
  return {}
}

export function createEventCore({ app, publish, now = Date.now }: {
  app: AppDb
  /** Hands a push to the shell (host.window.send). */
  publish: (push: Push) => void
  now?: () => number
}) {
  const { db } = app
  const insert = db.prepare('INSERT INTO app_events (at, kind, data) VALUES (?, ?, ?)')
  const last = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM app_events')
  const after = db.prepare('SELECT seq, at, kind, data FROM app_events WHERE seq > ? ORDER BY seq LIMIT ?')
  let routes: Routes | null = null
  let depth = 0

  const lastSeq = (): number => Number((last.get() as { seq: number }).seq)

  /**
   * One change of the backend's state: `write` and the event's row in one transaction (a write that throws leaves
   * neither), then the push, numbered. Nested applies join the outer transaction.
   */
  function apply<T>(kind: string, data: Record<string, unknown>, write: () => T, push: Record<string, unknown> | null = null): { seq: number, value: T } {
    const outer = depth === 0
    if (outer) db.exec('BEGIN IMMEDIATE')
    depth += 1
    let value: T
    let seq: number
    try {
      value = write()
      seq = Number(insert.run(now(), kind, JSON.stringify(data)).lastInsertRowid)
      depth -= 1
      if (outer) db.exec('COMMIT')
    } catch (err) {
      depth -= 1
      if (outer) db.exec('ROLLBACK')
      throw err
    }
    if (push) publish({ ...push, type: String(push.type ?? kind), seq })
    return { seq, value }
  }

  /** A push that is no change of state (streamed text, a live snapshot): numbered with the latest stored event. */
  function transient(push: { type: string, [field: string]: unknown }) {
    publish({ ...push, seq: lastSeq(), transient: true })
  }

  /** The stored events after `seq`, oldest first, for a shell that missed them. */
  function since(seq: number, limit = 1000): StoredEvent[] {
    return (after.all(seq, limit) as Array<{ seq: number, at: number, kind: string, data: string }>)
      .map((row) => ({ seq: Number(row.seq), at: Number(row.at), kind: row.kind, data: JSON.parse(row.data) }))
  }

  /** The routes, set once the backend has what they call. */
  function route(table: Routes) {
    routes = table
  }

  /** One input: recorded (unless it says nothing new), then handed to its route; the route's answer comes back. */
  function signal<K extends SignalKind>(input: SignalOf<K>): unknown {
    if (!routes) throw new Error(`signal ${input.kind} before the routes were set`)
    const handler = routes[input.kind] as ((signal: SignalOf<K>) => unknown) | undefined
    if (!handler) throw new Error(`no route for signal ${String(input.kind)}`)
    if (!UNRECORDED.has(input.kind)) apply(`signal.${input.kind}`, signalData(input), () => undefined)
    return handler(input)
  }

  return { apply, transient, since, lastSeq, route, signal }
}

export type EventCore = ReturnType<typeof createEventCore>
