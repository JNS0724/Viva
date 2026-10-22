/** Validation shared by the history database, the legacy JSON import and the IPC boundary. */
import { checkImages, type ImageRef } from '../shared/images.ts'

const MAX_MESSAGES = 5000
const MAX_TEXT_CHARS = 200_000
const MAX_STOP_REASON_CHARS = 40
const MAX_TITLE_CHARS = 80
const AUTO_TITLE_CHARS = 20
const ROLES = new Set(['user', 'assistant', 'note'])
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/

/** What a finished answer took: time, tool calls, thoughts, and why it stopped. */
export interface Receipt { ms: number, tools: number, thoughts: number, stopReason: string }

/** A message as it is kept. */
export interface StoredMessage { role: 'user' | 'assistant' | 'note', text: string, receipt: Receipt | null, images?: ImageRef[] }

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

function normalizeReceipt(receipt: any): Receipt | null {
  if (receipt === null || receipt === undefined) return null
  const { ms, tools, thoughts, stopReason } = receipt
  if (!(Number.isFinite(ms) && ms >= 0) || !isCount(tools) || !isCount(thoughts)
    || typeof stopReason !== 'string' || stopReason.length > MAX_STOP_REASON_CHARS) {
    throw new Error('无效的消息 receipt')
  }
  return { ms, tools, thoughts, stopReason }
}

function normalizeMessage(message: any): StoredMessage {
  if (!ROLES.has(message?.role)) throw new Error(`无效的消息 role：${message?.role}`)
  if (typeof message.text !== 'string' || message.text.length > MAX_TEXT_CHARS) throw new Error('无效的消息 text')
  const images = checkImages(message.images)
  if (!images) throw new Error('无效的消息 images')
  return { role: message.role, text: message.text, receipt: normalizeReceipt(message.receipt), ...(images.length ? { images } : {}) }
}

/** Keeps only what is persisted from a list of messages (renderer state or a file), or throws. */
export function normalizeMessages(input: unknown): StoredMessage[] {
  if (!Array.isArray(input)) throw new Error('历史记录必须是消息列表')
  if (input.length > MAX_MESSAGES) throw new Error(`历史消息太多（上限 ${MAX_MESSAGES} 条）`)
  return input.map(normalizeMessage)
}

/** Conversation and session ids end up in file paths and queries, so only plain ids pass. */
export function assertId(id: unknown): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`无效的会话 id：${id}`)
  return id
}

/** A user-chosen title, trimmed. */
export function normalizeTitle(input: unknown): string {
  const title = typeof input === 'string' ? input.trim() : ''
  if (!title || title.length > MAX_TITLE_CHARS) throw new Error(`标题需要 1–${MAX_TITLE_CHARS} 个字`)
  return title
}

/** Default title: the first question, on one line, cut to a readable length. */
export function autoTitle(messages: ReadonlyArray<{ role: string, text: string }>): string {
  const first = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? ''
  const chars = [...first]
  return chars.length > AUTO_TITLE_CHARS ? `${chars.slice(0, AUTO_TITLE_CHARS).join('')}…` : first
}
