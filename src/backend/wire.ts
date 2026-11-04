import { z } from 'zod'
import type { Locale } from '../shared/i18n/locale.ts'
import type { ShellSettings } from './host.ts'

/**
 * What the shell and the backend process say to each other (docs/system-design.md §3).
 *
 * - Over the child's IPC channel, once: the shell's `start` (the token, the data key, what of the desktop the
 *   backend reads synchronously), and the backend's `ready` (its port, the channels it serves) or `failed`.
 * - Over loopback HTTP, every request with the token: `POST /rpc/<channel>` for the pages' channels,
 *   `POST /control/<op>` for the shell's own calls, `POST /blob` for bytes (passed on by id), `GET /image` for
 *   viva-image:// pictures, `POST /host/<id>` to answer the backend's requests.
 * - Over SSE, `GET /events?since=<seq>`: the stored events after that number (`stored`), then what the backend
 *   asks of the desktop (`host`: a call with an id waits for its answer, one without does not).
 */
export const TOKEN_HEADER = 'authorization'
export const bearer = (token: string): string => `Bearer ${token}`
/** The order the shell made its calls in, from 1 (rpc-server.ts inOrder). */
export const SEQ_HEADER = 'x-viva-seq'

/** What of the desktop the backend reads without waiting: kept in step by the shell (`POST /control/mirror`). */
export interface Mirror {
  inFront: boolean
  idleSeconds: number
  shellSettings: ShellSettings
}

const shellSettings = z.object({
  shortcut: z.object({ keys: z.string(), held: z.boolean() }).nullable(),
  openAtLogin: z.object({ available: z.boolean() }),
})
export const MIRROR = z.object({ inFront: z.boolean(), idleSeconds: z.number().nonnegative(), shellSettings })
export const START = z.object({
  type: z.literal('start'),
  token: z.string().min(32),
  /** base64 of the data key (src/shell/data-key.ts), or null when the keychain is not available. */
  dataKey: z.string().nullable(),
  paths: z.object({ userData: z.string(), documents: z.string(), home: z.string() }),
  packaged: z.boolean(),
  automation: z.boolean(),
  locale: z.string(),
  mirror: MIRROR,
})
export type StartMessage = z.infer<typeof START>

export type ChannelKind = 'handle' | 'on'
export interface ReadyMessage {
  type: 'ready'
  port: number
  channels: Array<{ channel: string, kind: ChannelKind }>
  /** The language the backend resolved at launch, for the shell's own words (the tray, dialogs). */
  locale: Locale
}
export interface FailedMessage { type: 'failed', message: string }

/** What the backend may ask of the desktop; each is a member of HostCapabilities (host.ts). */
export const HOST_METHODS = [
  'window.send', 'window.broadcastLanguage', 'window.setPending', 'window.refreshNative',
  'dialogs.chooseFolder', 'dialogs.chooseFiles', 'dialogs.saveFile',
  'shell.openExternal', 'shell.openPath', 'shell.showItemInFolder', 'shell.trash',
  'notify', 'loginItem.set',
] as const
export type HostMethod = (typeof HOST_METHODS)[number]
/** `n` numbers the calls in the order the backend made them (remote-host.ts), from 1. */
export interface HostCall { id: number | null, method: HostMethod, args: unknown[], n: number }
/**
 * `mark` on an answer from the backend: the last host call it had made when it answered. The shell runs the host calls
 * up to it first (backend-client.ts), so a page never has an answer before what the backend pushed ahead of it.
 */
export type Answer = { ok: true, value: unknown, mark?: number } | { ok: false, error: string, mark?: number }

/** Bytes in a JSON body: by id once uploaded (`$blob`), or inline in an answer (`$bytes`, base64). */
type BlobRef = { $blob: string }
type InlineBytes = { $bytes: string }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export const isBlobRef = (value: unknown): value is BlobRef => isRecord(value) && typeof value.$blob === 'string' && Object.keys(value).length === 1
const isInlineBytes = (value: unknown): value is InlineBytes => isRecord(value) && typeof value.$bytes === 'string' && Object.keys(value).length === 1
/**
 * `undefined` in a list (an argument the page left out): JSON would make it null, which an optional argument
 * refuses, while Electron's IPC kept it as it was.
 */
const UNDEFINED = Object.freeze({ $undefined: true })
const isUndefinedMark = (value: unknown): boolean => isRecord(value) && value.$undefined === true && Object.keys(value).length === 1
export const isBytes = (value: unknown): value is Uint8Array | ArrayBuffer => value instanceof Uint8Array || value instanceof ArrayBuffer

/** An answer with any bytes in it inline, as JSON can carry them. */
export function encodeValue(value: unknown): unknown {
  if (isBytes(value)) return { $bytes: Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('base64') }
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? UNDEFINED : encodeValue(item)))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]))
  return value
}

export function decodeValue(value: unknown): unknown {
  if (isInlineBytes(value)) return new Uint8Array(Buffer.from(value.$bytes, 'base64'))
  if (Array.isArray(value)) return value.map((item) => (isUndefinedMark(item) ? undefined : decodeValue(item)))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item)]))
  return value
}

/** One SSE message. JSON.stringify writes no line breaks, so the data is one line. */
export const sseMessage = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** Reads SSE from chunks as they come, handing on each whole message; comments (keep-alives) are skipped. */
export function sseReader(onMessage: (event: string, data: unknown) => void): (chunk: string) => void {
  let pending = ''
  return (chunk) => {
    pending += chunk
    let end = pending.indexOf('\n\n')
    while (end !== -1) {
      const block = pending.slice(0, end)
      pending = pending.slice(end + 2)
      end = pending.indexOf('\n\n')
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data.push(line.slice(6))
      }
      if (data.length) onMessage(event, JSON.parse(data.join('\n')))
    }
  }
}
