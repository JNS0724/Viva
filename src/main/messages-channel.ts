import { t } from '../shared/i18n/translate.ts'
import type { ReadRequest } from './message-reader.ts'

/**
 * The app's side of the messages contract (version 1, plugins/messages/lib/channel.ts), held by acp-bridge.ts:
 * the model asks for the messages the sources brought in (viva_messages_read); the request is checked here, since
 * a model wrote it, and `read` (message-reader.ts, backed by the sources in main.ts) answers in words.
 */
const MAX_ID_CHARS = 100
const MAX_SOURCE_CHARS = 60
const MAX_QUERY_CHARS = 100
export const DEFAULT_HOURS = 72
export const MAX_HOURS = 720
export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 30

const optionalText = (value: unknown, max: number): string | null =>
  (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)

const wholeIn = (value: unknown, fallback: number, max: number): number =>
  (Number.isInteger(value) && (value as number) > 0 ? Math.min(value as number, max) : fallback)

/** The model's request, checked: what does not fit falls back to the defaults. */
export function readRequestOf(raw: any): ReadRequest {
  return {
    source: optionalText(raw?.source, MAX_SOURCE_CHARS),
    query: optionalText(raw?.query, MAX_QUERY_CHARS),
    sinceHours: wholeIn(raw?.since_hours, DEFAULT_HOURS, MAX_HOURS),
    limit: wholeIn(raw?.limit, DEFAULT_LIMIT, MAX_LIMIT),
  }
}

export function createMessagesDesk({ send, read }: {
  send: (message: object) => void
  /** Null when the app has no message sources at all (started without them). */
  read: ((request: ReadRequest) => Promise<string>) | null
}) {
  function receive(message: any) {
    if (message?.type !== 'messages_read') return
    const id = typeof message.id === 'string' && message.id.length <= MAX_ID_CHARS ? message.id : null
    if (!id) return
    const answer = (ok: boolean, text: string) => send({ type: 'messages_result', id, ok, text })
    if (!read) return answer(false, t('messages.unavailable'))
    read(readRequestOf(message.request))
      .then((text) => answer(true, text))
      .catch((err) => answer(false, t('messages.readError', { error: err instanceof Error ? err.message : String(err) })))
  }
  return { receive }
}
