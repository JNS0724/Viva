/**
 * The deterministic half of a source (no model): a tool's result decoded, the messages in it found by the paths the
 * user confirmed, each with a stable key. Everything here is pure.
 */
import crypto from 'node:crypto'
import { MAX_BODY, MAX_KEY, MAX_SEEN, MAX_TITLE, type Decode, type Json, type SourceError, type SourceMap } from '../../../src/shared/sources-channel.ts'

/** One message as 动态 and the judging model see it. */
export interface Message { key: string, title: string, body: string, link: string, time: string }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The first text block of an MCP result, if it has one. */
function textBlock(value: unknown): string | null {
  if (!record(value) || !Array.isArray(value.content)) return null
  const block = value.content.find((item: unknown) => record(item) && item.type === 'text' && typeof item.text === 'string') as { text: string } | undefined
  return block?.text ?? null
}

function parsedJson(text: string | null): unknown {
  if (text === null) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** MCP's result shape: content blocks, each with its type. A plugin's own `{ content: [...] }` is a value. */
const isMcpResult = (value: unknown): boolean =>
  record(value) && Array.isArray(value.content) && value.content.length > 0
  && value.content.every((block) => record(block) && typeof block.type === 'string')

/**
 * How a result is best read: MCP's structuredContent, MCP text that is JSON, or a plugin's value as it is. Null for
 * text that is not JSON (a digest written for people): the first version does not read those.
 */
export function guessDecode(value: unknown): Decode | null {
  if (record(value) && record(value.structuredContent)) return 'structured'
  if (isMcpResult(value)) return parsedJson(textBlock(value)) === undefined ? null : 'json-text'
  return value !== null && typeof value === 'object' ? 'value' : null
}

export function decodeResult(decode: Decode, value: unknown): unknown {
  if (decode === 'structured') return record(value) ? value.structuredContent : undefined
  if (decode === 'json-text') return parsedJson(textBlock(value))
  return value
}

/** `$` or `$.a.b` into a value; undefined where it finds nothing. */
export function at(value: unknown, path: string): unknown {
  if (path === '$') return value
  return path.slice(2).split('.').reduce<unknown>((node, key) => (record(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined), value)
}

const textOf = (value: unknown): string => {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * A key as remembered: trimmed, without the angle brackets mail ids come in; one longer than MAX_KEY by its hash, so
 * two that share a beginning stay apart. A message without one is known by its title and time.
 */
export function normalizeKey(raw: unknown, title: string, time: string): string {
  const text = textOf(raw).trim().replace(/^<(.*)>$/, '$1').trim()
  if (text) return text.length <= MAX_KEY ? text : `k:${crypto.createHash('sha256').update(text).digest('hex')}`
  return `h:${crypto.createHash('sha256').update(`${title}\n${time}`).digest('hex').slice(0, 32)}`
}

const linkOf = (value: unknown): string => {
  const text = textOf(value).trim()
  return /^https?:\/\//i.test(text) ? text : ''
}

export type Found = { ok: true, messages: Message[] } | { ok: false, problem: SourceError }

/**
 * The messages in a decoded result. Strict (a source being confirmed): every message must have its key and title
 * where the paths say. Otherwise a message without a title is left out and one without a key is known by its text.
 * A list longer than MAX_SEEN is refused: what a source lists must fit in the keys it remembers, or old messages
 * would come back as new.
 */
export function messagesOf(spec: { items: string, map: SourceMap }, decoded: unknown, { strict = false } = {}): Found {
  const list = at(decoded, spec.items)
  if (!Array.isArray(list)) return { ok: false, problem: { code: 'not-a-list', detail: spec.items } }
  if (list.length > MAX_SEEN) return { ok: false, problem: { code: 'too-many', detail: String(list.length) } }
  const messages: Message[] = []
  for (const item of list) {
    const title = textOf(at(item, spec.map.title)).trim().slice(0, MAX_TITLE)
    const rawKey = at(item, spec.map.key)
    if (strict && (!title || textOf(rawKey).trim() === '')) {
      return { ok: false, problem: { code: 'missing-field', detail: title ? spec.map.key : spec.map.title } }
    }
    if (!title) continue
    const time = spec.map.time ? textOf(at(item, spec.map.time)).trim() : ''
    messages.push({
      key: normalizeKey(rawKey, title, time),
      title,
      body: spec.map.body ? textOf(at(item, spec.map.body)).trim().slice(0, MAX_BODY) : '',
      link: spec.map.link ? linkOf(at(item, spec.map.link)) : '',
      time,
    })
  }
  // Confirming, a key must tell messages apart: one that does not (a sender, a thread) would hide every later message
  // that shares it.
  if (strict && new Set(messages.map((message) => message.key)).size < messages.length) {
    return { ok: false, problem: { code: 'duplicate-key', detail: spec.map.key } }
  }
  return { ok: true, messages }
}

/** A source's arguments for one check: `{last}` in any string becomes the previous check's time. */
export function fill(args: Record<string, Json>, last: string): Record<string, Json> {
  const walk = (value: Json): Json => {
    if (typeof value === 'string') return value.replaceAll('{last}', last)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    return value
  }
  return walk(args) as Record<string, Json>
}
