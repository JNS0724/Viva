/** Validation shared by the history database, the legacy JSON import and the IPC boundary. */
import { checkImages } from '../shared/images.ts'

const MAX_MESSAGES = 5000
const MAX_TEXT_CHARS = 200_000
const MAX_STOP_REASON_CHARS = 40
const MAX_TITLE_CHARS = 80
const AUTO_TITLE_CHARS = 20
const ROLES = new Set(['user', 'assistant', 'note'])
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/

const isCount = (value) => Number.isInteger(value) && value >= 0

function normalizeReceipt(receipt) {
  if (receipt === null || receipt === undefined) return null
  const { ms, tools, thoughts, stopReason } = receipt
  if (!(Number.isFinite(ms) && ms >= 0) || !isCount(tools) || !isCount(thoughts)
    || typeof stopReason !== 'string' || stopReason.length > MAX_STOP_REASON_CHARS) {
    throw new Error('无效的消息 receipt')
  }
  return { ms, tools, thoughts, stopReason }
}

function normalizeMessage(message) {
  if (!ROLES.has(message?.role)) throw new Error(`无效的消息 role：${message?.role}`)
  if (typeof message.text !== 'string' || message.text.length > MAX_TEXT_CHARS) throw new Error('无效的消息 text')
  const images = checkImages(message.images)
  if (!images) throw new Error('无效的消息 images')
  return { role: message.role, text: message.text, receipt: normalizeReceipt(message.receipt), ...(images.length ? { images } : {}) }
}

/**
 * Keeps only what is persisted from a list of messages (renderer state or a file), or throws.
 * @param {unknown} input
 * @returns {{ role: 'user' | 'assistant' | 'note', text: string, receipt: object | null, images?: { id: string }[] }[]}
 */
export function normalizeMessages(input) {
  if (!Array.isArray(input)) throw new Error('历史记录必须是消息列表')
  if (input.length > MAX_MESSAGES) throw new Error(`历史消息太多（上限 ${MAX_MESSAGES} 条）`)
  return input.map(normalizeMessage)
}

/** Conversation and session ids end up in file paths and queries, so only plain ids pass. */
export function assertId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`无效的会话 id：${id}`)
  return id
}

/** @returns {string} a user-chosen title, trimmed */
export function normalizeTitle(input) {
  const title = typeof input === 'string' ? input.trim() : ''
  if (!title || title.length > MAX_TITLE_CHARS) throw new Error(`标题需要 1–${MAX_TITLE_CHARS} 个字`)
  return title
}

/** Default title: the first question, on one line, cut to a readable length. */
export function autoTitle(messages) {
  const first = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? ''
  const chars = [...first]
  return chars.length > AUTO_TITLE_CHARS ? `${chars.slice(0, AUTO_TITLE_CHARS).join('')}…` : first
}
