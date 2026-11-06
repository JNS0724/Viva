import type { HostCapabilities, Secrets } from './host.ts'
import type { Answer, HostCall, HostMethod, Mirror, StartMessage } from './wire.ts'

/**
 * HostCapabilities for a backend in its own process (docs/system-design.md §3): what it reads
 * without waiting comes from the launch message and the mirror the shell keeps in step; what it asks of the
 * desktop goes out as host calls over SSE, a dialog's or a path's answer coming back by id. The latest calls are
 * kept, numbered (`n`), so a shell that listens (at launch, or again after its stream ended) gets every call after
 * the last it ran, in order: those made while none listened, and those written to a stream that was ending.
 */
/** The latest calls kept for a shell that listens again; more, and the oldest go. */
const MAX_KEPT_CALLS = 10_000
/** How long a shown notification's click is waited for (main.ts keeps the notification as long). */
const CALLBACK_KEEP_MS = 60 * 60 * 1000

type Listener = (call: HostCall) => void
type Pending = { resolve: (value: unknown) => void, reject: (err: Error) => void }

export function createRemoteHost({ start, secrets, onDropped = () => {} }: {
  start: Pick<StartMessage, 'paths' | 'packaged' | 'automation' | 'locale' | 'mirror'>
  secrets: Secrets
  /** A call no shell had was let go, the first of them (its number), while none listened. */
  onDropped?: (n: number) => void
}) {
  let mirror: Mirror = start.mirror
  const listeners = new Set<Listener>()
  /** The latest calls made, oldest first; and the number of the last one handed to a shell listening. */
  const kept: HostCall[] = []
  let handed = 0
  /** Calls no shell had are being let go (said once, till a shell listens). */
  let dropping = false
  const pending = new Map<number, Pending>()
  const callbacks = new Map<number, (...args: unknown[]) => void>()
  let lastId = 0
  let sent = 0

  function send(unnumbered: Omit<HostCall, 'n'>) {
    sent += 1
    const call: HostCall = { ...unnumbered, n: sent }
    // Kept in place: this runs for every piece streamed, and a copy of all that is kept each time would be the cost.
    kept.push(call)
    if (kept.length > MAX_KEPT_CALLS) {
      const [gone] = kept.splice(0, kept.length - MAX_KEPT_CALLS)
      // One no shell had goes: lost for good (a shell listening again sees the gap in the numbers). Said once a while.
      if (gone.n > handed && !dropping) { dropping = true; onDropped(gone.n) }
    }
    if (listeners.size === 0) return
    handed = call.n
    for (const listener of listeners) listener(call)
  }

  const tell = (method: HostMethod, ...args: unknown[]) => send({ id: null, method, args })

  function ask<T>(method: HostMethod, ...args: unknown[]): Promise<T> {
    const id = ++lastId
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      send({ id, method, args })
    })
  }

  /** A function the shell calls back later (a notification's click), by id. */
  function keep(callback: (...args: unknown[]) => void): number {
    const id = ++lastId
    callbacks.set(id, callback)
    setTimeout(() => callbacks.delete(id), CALLBACK_KEEP_MS).unref?.()
    return id
  }

  const host: HostCapabilities = {
    paths: start.paths,
    packaged: start.packaged,
    automation: start.automation,
    locale: () => start.locale,
    secrets,
    dialogs: {
      chooseFolder: (options) => ask('dialogs.chooseFolder', options),
      chooseFiles: (options) => ask('dialogs.chooseFiles', options),
      saveFile: (options) => ask('dialogs.saveFile', options),
    },
    shell: {
      openExternal: (url) => ask('shell.openExternal', url),
      openPath: (dir) => ask('shell.openPath', dir),
      showItemInFolder: (file) => tell('shell.showItemInFolder', file),
      trash: (file) => ask('shell.trash', file),
    },
    notify: (notice, opened) => tell('notify', notice, keep((afterMs) => opened?.(Number(afterMs)))),
    power: { idleSeconds: () => mirror.idleSeconds },
    window: {
      send: (event) => tell('window.send', event),
      broadcastLanguage: (state) => tell('window.broadcastLanguage', state),
      inFront: () => mirror.inFront,
      setPending: (count) => tell('window.setPending', count),
      refreshNative: () => tell('window.refreshNative'),
    },
    loginItem: { set: (on) => tell('loginItem.set', on) },
    shellSettings: () => mirror.shellSettings,
  }

  return {
    host,
    /**
     * A shell listening (the SSE stream): it gets the calls kept after the last it ran (`after`; none at its first
     * listen), in order, then each as it is made.
     */
    listen(listener: Listener, after = 0): () => void {
      for (const call of kept.filter((one) => one.n > after)) listener(call)
      if (kept.length) handed = Math.max(handed, kept[kept.length - 1].n)
      dropping = false
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** The shell's answer to a call with an id. */
    answer(id: number, answer: Answer): boolean {
      const waiter = pending.get(id)
      if (!waiter) return false
      pending.delete(id)
      if (answer.ok) waiter.resolve(answer.value)
      else waiter.reject(new Error(answer.error))
      return true
    },
    callback(id: number, args: unknown[]): boolean {
      const callback = callbacks.get(id)
      if (!callback) return false
      callbacks.delete(id)
      callback(...args)
      return true
    },
    /** What of the desktop changed (the window came to the front, the user's idle time, the shortcut). */
    mirror(update: Partial<Mirror>) {
      mirror = { ...mirror, ...update }
    },
    /** The number of the last host call made (wire.ts Answer mark). */
    mark: (): number => sent,
    /** Every call still waiting for the shell fails: it has gone. */
    abandon(reason: string) {
      for (const waiter of pending.values()) waiter.reject(new Error(reason))
      pending.clear()
    },
  }
}

export type RemoteHost = ReturnType<typeof createRemoteHost>
