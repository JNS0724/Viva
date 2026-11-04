/**
 * A store whose writes go through the event core (event-core.ts apply): each write and its event in one transaction
 * on the app database, numbered. Reads go straight through. Used for the follow-ups, the history and the background
 * tasks; memory, whose file is the memory plugin's, gets its event right after its own write commits.
 */

/** The event core's apply, as a store's writes need it. */
export type Apply = <T>(kind: string, data: Record<string, unknown>, write: () => T) => { value: T }

/** An id, a status, a kind or a time: recorded as it is. Anything else that is text is recorded only by its length. */
const PLAIN = /^[\w.:-]{1,64}$/

/**
 * What of a write's arguments its event records: ids, statuses, numbers and flags; text only by its length, lists
 * by their count, an object by its fields one level down. Never what the user or the model wrote.
 */
export function recorded(value: unknown): unknown {
  if (typeof value === 'string') return PLAIN.test(value) ? value : { chars: value.length }
  if (Array.isArray(value)) return { items: value.length }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'object' && item !== null ? '…' : recorded(item)]))
  }
  return value
}

/** `store` with each of `writes` recorded as `<prefix>.<name>`; the rest of it unchanged. */
export function journaled<S extends object>(store: S, prefix: string, writes: ReadonlyArray<keyof S & string>, apply: Apply): S {
  const wrapped = Object.fromEntries(writes.map((name) => {
    const write = store[name] as unknown as (...args: unknown[]) => unknown
    if (typeof write !== 'function') throw new Error(`${prefix}.${name} is no write of this store`)
    return [name, (...args: unknown[]) => apply(`${prefix}.${name}`, { args: args.map(recorded) }, () => write(...args)).value]
  }))
  return { ...store, ...wrapped }
}
