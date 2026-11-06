import type { Channel } from '../shared/ipc-contract.ts'
import { type AppDb, transaction } from './app-db.ts'

/**
 * The backend's event core (docs/system-design.md §4). Every input is a signal of a closed kind,
 * routed by code (a route for each kind, checked by the type system); every change of the backend's state goes
 * through `apply`, which writes it and its event in one transaction and numbers the event; every push to the shell
 * carries a number: a stored event its own, a transient push (streamed text, live task snapshots) the latest stored
 * one, marked transient. After a disconnect the shell asks for what came after the last number it saw (`since`).
 */
/** What dsh reports of a background task (acp-bridge.ts): its kind, the task, and the rest as it came. */
export type DshTaskEvent = { type: string, taskId: string, [field: string]: unknown }

export type Signal =
  /** The user asked something in the conversation (agent:prompt). */
  | { kind: 'chat.said', text: string, images: readonly unknown[] }
  /** A turn of the user's ended (acp-bridge turn_end). */
  | { kind: 'agent.turn_ended' }
  /** A background task's turn ended (task_end), or it began or stopped waiting on the user (a permission or question). */
  | { kind: 'agent.task_ended', event: DshTaskEvent }
  | { kind: 'agent.task_waits', event: DshTaskEvent }
  /** The computer woke or was unlocked. */
  | { kind: 'system.woke' }
  /** The window came to the front. */
  | { kind: 'window.foreground' }
  /** The user did something in a page: a channel of ipc-contract.ts that is no query (commands.ts). */
  | { kind: 'user.command', channel: Channel, args: readonly unknown[], event: unknown }

export type SignalKind = Signal['kind']
export type SignalOf<K extends SignalKind> = Extract<Signal, { kind: K }>
/** A route for every kind of signal; one missing fails the type check. */
export type Routes = { readonly [K in SignalKind]: (signal: SignalOf<K>) => unknown }

/** What the shell is pushed. */
export type Push = { type: string, seq: number, transient?: true, [field: string]: unknown }
export type StoredEvent = { seq: number, at: number, kind: string, data: Record<string, unknown> }

/** The events kept: older ones go when the core opens. A shell that missed more than this reloads instead. */
export const EVENTS_KEPT = 100_000

/** Signals worth no row of their own: they say nothing new about the backend's state and come often. */
const UNRECORDED: ReadonlySet<SignalKind> = new Set(['window.foreground'])
/**
 * A value by its shape: numbers, flags and nulls as they are; text, lists, objects and bytes only by how long they
 * are. A command's arguments may hold a key (settings:save-key) or what the user wrote.
 */
function shapeOf(value: unknown): unknown {
  if (typeof value === 'string') return { chars: value.length }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return { bytes: value.byteLength }
  if (Array.isArray(value)) return { items: value.length }
  if (value && typeof value === 'object') return { fields: Object.keys(value).length }
  return value ?? null
}

/** What of a signal is recorded: its kind and its shape, never what the user said or a model wrote. */
function signalData(signal: Signal): Record<string, unknown> {
  if (signal.kind === 'chat.said') return { chars: signal.text.length, images: signal.images.length }
  if (signal.kind === 'user.command') return { channel: signal.channel, args: signal.args.map(shapeOf) }
  if (signal.kind === 'agent.task_ended' || signal.kind === 'agent.task_waits') return { type: signal.event.type, taskId: signal.event.taskId }
  return {}
}

export function createEventCore({ app, publish, now = Date.now, kept = EVENTS_KEPT }: {
  app: AppDb
  /** How many events are kept (EVENTS_KEPT). */
  kept?: number
  /** Hands a push to the shell (host.window.send). */
  publish: (push: Push) => void
  now?: () => number
}) {
  const { db } = app
  db.prepare('DELETE FROM app_events WHERE seq <= (SELECT MAX(seq) FROM app_events) - ?').run(kept)
  const insert = db.prepare('INSERT INTO app_events (at, kind, data) VALUES (?, ?, ?)')
  const last = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM app_events')
  const after = db.prepare('SELECT seq, at, kind, data FROM app_events WHERE seq > ? ORDER BY seq LIMIT ?')
  let routes: Routes | null = null

  const lastSeq = (): number => Number((last.get() as { seq: number }).seq)

  /**
   * One change of the backend's state: `write` and the event's row in one transaction (a write that throws leaves
   * neither), then the push, numbered. Nested applies join the outer transaction.
   */
  function apply<T>(kind: string, data: Record<string, unknown>, write: () => T, push: Record<string, unknown> | null = null): { seq: number, value: T } {
    const { seq, value } = transaction(db, () => {
      const written = write()
      return { seq: Number(insert.run(now(), kind, JSON.stringify(data)).lastInsertRowid), value: written }
    })
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
