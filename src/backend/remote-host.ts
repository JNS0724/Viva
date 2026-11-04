import type { Notice } from './notice-plan.ts'
import type { HostCapabilities, Secrets } from './host.ts'
import type { Answer, HostCall, HostMethod, Mirror, StartMessage } from './wire.ts'

/**
 * HostCapabilities for a backend in its own process (docs/backend-split-design.md D4, §12 P5): what it reads
 * without waiting comes from the launch message and the mirror the shell keeps in step; what it asks of the
 * desktop goes out as host calls over SSE, a dialog's or a path's answer coming back by id. Calls made before the
 * shell listens wait in order, so none is lost at launch.
 */
/** Calls kept while no shell listens; more means it is gone, and the oldest go. */
const MAX_WAITING_CALLS = 10_000
/** How long a shown notification's click is waited for (main.ts keeps the notification as long). */
const CALLBACK_KEEP_MS = 60 * 60 * 1000

type Listener = (call: HostCall) => void
type Pending = { resolve: (value: unknown) => void, reject: (err: Error) => void }

export function createRemoteHost({ start, secrets, onDropped = () => {} }: {
  start: Pick<StartMessage, 'paths' | 'packaged' | 'automation' | 'locale' | 'mirror'>
  secrets: Secrets
  onDropped?: (count: number) => void
}) {
  let mirror: Mirror = start.mirror
  const listeners = new Set<Listener>()
  const waiting: HostCall[] = []
  const pending = new Map<number, Pending>()
  const callbacks = new Map<number, (...args: unknown[]) => void>()
  let lastId = 0
  let sent = 0

  function send(unnumbered: Omit<HostCall, 'n'>) {
    sent += 1
    const call: HostCall = { ...unnumbered, n: sent }
    if (listeners.size === 0) {
      waiting.push(call)
      if (waiting.length > MAX_WAITING_CALLS) onDropped(waiting.splice(0, waiting.length - MAX_WAITING_CALLS).length)
      return
    }
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
    notify: (notice: Notice, opened) => tell('notify', notice, keep((afterMs) => opened(Number(afterMs)))),
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
    /** A shell listening (the SSE stream): it gets what waited first, in order. */
    listen(listener: Listener): () => void {
      listeners.add(listener)
      for (const call of waiting.splice(0)) listener(call)
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
