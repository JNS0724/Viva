import { type Channel, type IpcRegistry, QUERY_CHANNELS } from '../main/ipc-contract.ts'
import type { SignalOf } from './event-core.ts'

/**
 * What the user does in a page, as signals (docs/backend-split-design.md §6.1, `user.*`). The backend's channels are
 * registered through this: a command channel's listener runs as the route of its `user.command` signal, once the
 * signal is recorded; a query (ipc-contract.ts QUERY_CHANNELS), and a channel that is a signal of its own already,
 * go straight to their listener.
 */
export type CommandSignal = SignalOf<'user.command'>

/** agent:prompt is `chat.said` (compose.ts), so not a command as well. */
const OWN_SIGNALS: ReadonlySet<Channel> = new Set<Channel>(['agent:prompt'])

type Listener = (event: unknown, ...args: unknown[]) => unknown

export const isCommand = (channel: Channel): boolean => !QUERY_CHANNELS.has(channel) && !OWN_SIGNALS.has(channel)

export function commandIpc(ipc: IpcRegistry, signal: (input: CommandSignal) => unknown): { ipc: IpcRegistry, route: (input: CommandSignal) => unknown } {
  const listeners = new Map<Channel, Listener>()

  function register(kind: 'handle' | 'on', channel: Channel, listener: Listener) {
    const raw = ipc[kind] as (channel: Channel, listener: Listener) => void
    if (!isCommand(channel)) {
      raw(channel, listener)
      return
    }
    if (listeners.has(channel)) throw new Error(`${channel} is registered twice`)
    listeners.set(channel, listener)
    raw(channel, (event, ...args) => signal({ kind: 'user.command', channel, args, event }))
  }

  function route(input: CommandSignal): unknown {
    const listener = listeners.get(input.channel)
    if (!listener) throw new Error(`no listener for ${input.channel}`)
    return listener(input.event, ...input.args)
  }

  const registry = {
    handle: (channel: Channel, listener: Listener) => register('handle', channel, listener),
    on: (channel: Channel, listener: Listener) => register('on', channel, listener),
  } as IpcRegistry
  return { ipc: registry, route }
}
