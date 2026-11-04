/**
 * A store whose writes go through the event core (event-core.ts apply): each write and its event in one transaction
 * on the app database, numbered. Reads go straight through. Used for the follow-ups, the history and the background
 * tasks; memory, whose file is the memory plugin's, gets its event right after its own write commits.
 */

/** The event core's apply, as a store's writes need it. */
export type Apply = <T>(kind: string, data: Record<string, unknown>, write: () => T) => { value: T }

/**
 * An id (a UUID, `f-1a2b`, `task-3`): letters, digits and dashes with a digit among them, no shorter than six. It is
 * recorded as it is; any other text, a status or a word the user wrote, only by its length.
 */
const ID = /^(?=[\w-]*\d)[\w-]{6,64}$/

/**
 * What of a write's arguments its event records: ids, numbers and flags; other text only by its length, lists by
 * their count, an object by its fields one level down. Never what the user or the model wrote.
 */
export function recorded(value: unknown): unknown {
  if (typeof value === 'string') return ID.test(value) ? value : { chars: value.length }
  if (Array.isArray(value)) return { items: value.length }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'object' && item !== null ? '…' : recorded(item)]))
  }
  return value
}

/**
 * What a write returns when it changed nothing: `false` (it did not move, it was not kept), `0` (none removed) or
 * `null` (no such row). Such a write is no event.
 */
const isUnchanged = (value: unknown): boolean => value === false || value === 0 || value === null

/** Thrown inside apply so the event is not written; the write changed nothing, so nothing is undone. */
class Unchanged {
  readonly value: unknown
  constructor(value: unknown) {
    this.value = value
  }
}

/** `store` with each of `writes` recorded as `<prefix>.<name>`, unless it changed nothing; the rest of it unchanged. */
export function journaled<S extends object>(store: S, prefix: string, writes: ReadonlyArray<keyof S & string>, apply: Apply): S {
  const wrapped = Object.fromEntries(writes.map((name) => {
    const write = store[name] as unknown as (...args: unknown[]) => unknown
    if (typeof write !== 'function') throw new Error(`${prefix}.${name} is no write of this store`)
    const run = (...args: unknown[]) => {
      try {
        return apply(`${prefix}.${name}`, { args: args.map(recorded) }, () => {
          const value = write(...args)
          if (isUnchanged(value)) throw new Unchanged(value)
          return value
        }).value
      } catch (err) {
        if (err instanceof Unchanged) return err.value
        throw err
      }
    }
    return [name, run]
  }))
  return { ...store, ...wrapped }
}
