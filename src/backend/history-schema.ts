import { operationId } from '../memory/contracts/memory-contract.ts'
import { t } from '../shared/i18n/translate.ts'
/** Validation shared by the history database and the IPC boundary. */
import { checkImages, type ImageRef } from '../shared/images.ts'

export const MAX_TEXT_CHARS = 200_000
/** Trusted backend assistant writes may exceed the user-input IPC bound while remaining finite. */
export const MAX_ASSISTANT_TEXT_CHARS = 2_000_000
const MAX_STOP_REASON_CHARS = 40
const MAX_TITLE_CHARS = 80
const AUTO_TITLE_CHARS = 20
const ROLES = new Set(['user', 'assistant', 'note'])
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/

/** Permanent schema validation error; callers must not infinitely retry invalid payloads ahead of valid writes. */
export class HistoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoryValidationError'
  }
}

/** What a finished answer took: time, tool calls, thoughts, and why it stopped. */
export interface Receipt { ms: number, tools: number, thoughts: number, stopReason: string }

/** A message as it is kept. */
export type StoredMessage = { role: 'user' | 'assistant' | 'note', text: string, receipt: Receipt | null, images?: ImageRef[], sourceId?: string, key?: string,
  /** Trusted read metadata only; normalizeMessages deliberately ignores caller claims. */
  delivery?: 'pending' | 'not-sent' }

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

function normalizeReceipt(receipt: any): Receipt | null {
  if (receipt === null || receipt === undefined) return null
  const { ms, tools, thoughts, stopReason } = receipt
  if (!(Number.isFinite(ms) && ms >= 0) || !isCount(tools) || !isCount(thoughts)
    || typeof stopReason !== 'string' || stopReason.length > MAX_STOP_REASON_CHARS) {
    throw new HistoryValidationError(t("main.history-schema.invalid.message.receipt"))
  }
  return { ms, tools, thoughts, stopReason }
}

export function normalizeMessage(message: any, { maxTextChars = MAX_TEXT_CHARS }: { maxTextChars?: number } = {}): StoredMessage {
  if (!ROLES.has(message?.role)) throw new HistoryValidationError(t("main.history-schema.invalid.message.role", { role: message?.role }))
  if (typeof message.text !== 'string' || message.text.length > maxTextChars) throw new HistoryValidationError(t("main.history-schema.invalid.message.text"))
  if (message.key !== undefined && (typeof message.key !== 'string' || !message.key || message.key.length > 1000)) throw new HistoryValidationError(t('main.history-schema.invalid.message.key'))
  const images = checkImages(message.images)
  if (!images) throw new HistoryValidationError(t("main.history-schema.invalid.message.images"))
  const sourceId = operationId.safeParse(message.sourceId)
  return {
    role: message.role, text: message.text, receipt: normalizeReceipt(message.receipt),
    ...(images.length ? { images } : {}), ...(message.key ? { key: message.key } : {}),
    ...(message.role === 'user' && sourceId.success ? { sourceId: sourceId.data } : {}),
  }
}

/** Keeps only what is persisted from a list of messages, or throws. */
export function normalizeMessages(input: unknown): StoredMessage[] {
  if (!Array.isArray(input)) throw new HistoryValidationError(t("main.history-schema.history.must.be.a.list.of.messages"))
  return input.map(message => normalizeMessage(message))
}

/** Conversation and session ids end up in file paths and queries, so only plain ids pass. */
export function assertId(id: unknown): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new HistoryValidationError(t("main.history-schema.invalid.conversation.id", { id: String(id) }))
  return id
}

/** A user-chosen title, trimmed. */
export function normalizeTitle(input: unknown): string {
  const title = typeof input === 'string' ? input.trim() : ''
  if (!title || title.length > MAX_TITLE_CHARS) throw new HistoryValidationError(t("main.history-schema.title.must.contain.characters", { MAX_TITLE_CHARS: MAX_TITLE_CHARS }))
  return title
}

/** Default title: the first question, on one line, cut to a readable length. */
export function autoTitle(messages: ReadonlyArray<{ role: string, text: string }>): string {
  const first = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? ''
  const chars = [...first]
  return chars.length > AUTO_TITLE_CHARS ? `${chars.slice(0, AUTO_TITLE_CHARS).join('')}…` : first
}
