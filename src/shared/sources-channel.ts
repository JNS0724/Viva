/**
 * 消息源 between the app and viva-sources (plugins/sources): the app keeps the user's sources (message-sources.ts) and
 * sends the whole set whenever the plugin starts or the set changes; the plugin reads each one on its own timer with a
 * read-only tool the user confirmed, judges what is new with a model call without tools, and reports every check back
 * (docs/system-design.md §12.2). Adding or removing one from the conversation is a request the app answers.
 *
 * Everything a source brings in is third-party content: it only ever reaches a model as data, never a model with
 * tools, and the window shows it as text.
 */

/** A JSON value as a tool takes it. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** How a tool's result becomes data: the value as it is (a dsh plugin's tool), MCP's structuredContent, or MCP text holding JSON. */
export type Decode = 'value' | 'structured' | 'json-text'

/** Where each part of one message is, as `$.a.b` paths from the message; key and title always. */
export interface SourceMap { key: string, title: string, body: string | null, link: string | null, time: string | null }

/** What a source reads and how, as confirmed in the conversation; the app adds who and when. */
export interface SourceDraft {
  name: string
  /** The tool called, by its registered name (an MCP server's as mcp__server__tool). */
  tool: string
  /** Its arguments; `{last}` in a string becomes the previous check's time (ISO). */
  args: Record<string, Json>
  decode: Decode
  /** Where the messages are in the decoded result: `$` (it is the list) or `$.a.b`. */
  items: string
  map: SourceMap
  /** What is worth a reminder, in the user's words, for the judging model. */
  judge: string
  everyMinutes: number
  /** The model route that judges: the conversation's, when the source was added. */
  model: { provider: string, model: string }
}

export interface SourceSpec extends SourceDraft {
  id: string
  paused: boolean
  createdAt: number
  /** When the last check that went through started; null before the first. */
  lastCheckedAt: number | null
}

/** One new message after a check: its judgement, and what 动态 shows when it is pushed. */
export interface CheckedItem { key: string, title: string, body: string, link: string, push: boolean, reason: string }

export type AppToSources =
  | { type: 'sources_set', version: 1, sources: Array<SourceSpec & { seen: string[] }> }
  | { type: 'source_reply', version: 1, id: string, ok: boolean, text: string }

export type SourcesToApp =
  | { type: 'sources_ready', version: 1 }
  | { type: 'source_request', version: 1, id: string, op: 'add', draft: SourceDraft, seen: string[] }
  | { type: 'source_request', version: 1, id: string, op: 'remove', sourceId: string }
  | { type: 'source_checked', version: 1, sourceId: string, at: number, nextAt: number, ok: true, items: CheckedItem[], seen: string[] }
  | { type: 'source_checked', version: 1, sourceId: string, at: number, nextAt: number, ok: false, error: string }

export const MIN_EVERY_MINUTES = 5
export const MAX_EVERY_MINUTES = 240
export const DEFAULT_EVERY_MINUTES = 15
export const MAX_SOURCES = 20
/** Keys remembered per source, newest kept: enough to know any message a tool still lists. */
export const MAX_SEEN = 1000
/** Messages one check reports at most; more are taken as seen without a reminder. */
export const MAX_ITEMS_PER_CHECK = 30
export const MAX_KEY = 200
export const MAX_NAME = 40
export const MAX_TITLE = 200
export const MAX_BODY = 2000
export const MAX_JUDGE = 500
const MAX_TEXT = 4000
const MAX_TOOL = 128
const MAX_ARGS_JSON = 4000
const MAX_PATH = 200
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const PATH = /^\$(\.[^.\s]{1,64}){0,8}$/
const DECODES: ReadonlySet<string> = new Set(['value', 'structured', 'json-text'])

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max ? value : null)
const shortText = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')
const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

/** A path into a message or a result: `$` or `$.a.b`. */
export const isPath = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_PATH && PATH.test(value)
const pathOrNull = (value: unknown): string | null | undefined => (value === null ? null : isPath(value) ? value : undefined)

function jsonArgs(value: unknown): Record<string, Json> | null {
  if (!record(value)) return null
  try {
    const encoded = JSON.stringify(value)
    return encoded.length <= MAX_ARGS_JSON ? JSON.parse(encoded) as Record<string, Json> : null
  } catch {
    return null
  }
}

function mapOf(value: unknown): SourceMap | null {
  if (!record(value) || !isPath(value.key) || !isPath(value.title)) return null
  const body = pathOrNull(value.body ?? null)
  const link = pathOrNull(value.link ?? null)
  const at = pathOrNull(value.time ?? null)
  if (body === undefined || link === undefined || at === undefined) return null
  return { key: value.key, title: value.title, body, link, time: at }
}

/** A source as confirmed, checked wherever it arrives; null when any part is off. */
export function draftOf(value: unknown): SourceDraft | null {
  if (!record(value)) return null
  const name = text(value.name, MAX_NAME)?.trim()
  const tool = text(value.tool, MAX_TOOL)
  const args = jsonArgs(value.args)
  const map = mapOf(value.map)
  const judge = text(value.judge, MAX_JUDGE)?.trim()
  const every = value.everyMinutes
  const model = record(value.model) ? value.model : null
  if (!name || !tool || !args || !map || !judge) return null
  if (typeof value.decode !== 'string' || !DECODES.has(value.decode) || !isPath(value.items)) return null
  if (typeof every !== 'number' || !Number.isInteger(every) || every < MIN_EVERY_MINUTES || every > MAX_EVERY_MINUTES) return null
  const provider = text(model?.provider, 200)
  const modelName = text(model?.model, 200)
  if (!provider || !modelName) return null
  return { name, tool, args, decode: value.decode as Decode, items: value.items, map, judge, everyMinutes: every, model: { provider, model: modelName } }
}

export function specOf(value: unknown): SourceSpec | null {
  const draft = draftOf(value)
  if (!draft || !record(value) || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.paused !== 'boolean') return null
  const createdAt = time(value.createdAt)
  if (createdAt === null) return null
  if (value.lastCheckedAt === null) return { ...draft, id: value.id, paused: value.paused, createdAt, lastCheckedAt: null }
  const lastCheckedAt = time(value.lastCheckedAt)
  return lastCheckedAt === null ? null : { ...draft, id: value.id, paused: value.paused, createdAt, lastCheckedAt }
}

export const isSourceId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)

const keysOf = (value: unknown, max: number): string[] | null => (Array.isArray(value) && value.length <= max && value.every((key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY) ? [...value] : null)

function checkedItemOf(value: unknown): CheckedItem | null {
  if (!record(value) || typeof value.key !== 'string' || !value.key || value.key.length > MAX_KEY || typeof value.push !== 'boolean') return null
  const title = shortText(value.title, MAX_TITLE).trim()
  if (!title) return null
  return { key: value.key, title, body: shortText(value.body, MAX_BODY), link: shortText(value.link, MAX_TEXT), push: value.push, reason: shortText(value.reason, MAX_JUDGE) }
}

/** What the app sent, checked by the plugin; anything else is not for it. */
export function appToSourcesOf(message: unknown): AppToSources | null {
  if (!record(message) || message.version !== 1) return null
  if (message.type === 'source_reply') {
    if (typeof message.id !== 'string' || !REQUEST_ID.test(message.id) || typeof message.ok !== 'boolean') return null
    return { type: 'source_reply', version: 1, id: message.id, ok: message.ok, text: shortText(message.text, MAX_TEXT) }
  }
  if (message.type !== 'sources_set' || !Array.isArray(message.sources) || message.sources.length > MAX_SOURCES) return null
  const sources: Array<SourceSpec & { seen: string[] }> = []
  for (const item of message.sources) {
    const spec = specOf(item)
    const seen = record(item) ? keysOf(item.seen, MAX_SEEN) : null
    if (!spec || !seen) return null
    sources.push({ ...spec, seen })
  }
  return { type: 'sources_set', version: 1, sources }
}

/** What the plugin sent, checked by the app; anything else is not from it. */
export function sourcesToAppOf(message: unknown): SourcesToApp | null {
  if (!record(message) || message.version !== 1) return null
  if (message.type === 'sources_ready') return { type: 'sources_ready', version: 1 }
  if (message.type === 'source_request') {
    if (typeof message.id !== 'string' || !REQUEST_ID.test(message.id)) return null
    if (message.op === 'remove') return isSourceId(message.sourceId) ? { type: 'source_request', version: 1, id: message.id, op: 'remove', sourceId: message.sourceId } : null
    const draft = message.op === 'add' ? draftOf(message.draft) : null
    const seen = keysOf(message.seen, MAX_SEEN)
    return draft && seen ? { type: 'source_request', version: 1, id: message.id, op: 'add', draft, seen } : null
  }
  if (message.type !== 'source_checked' || !isSourceId(message.sourceId)) return null
  const at = time(message.at)
  const nextAt = time(message.nextAt)
  if (at === null || nextAt === null) return null
  const base = { type: 'source_checked', version: 1, sourceId: message.sourceId, at, nextAt } as const
  if (message.ok === false) return { ...base, ok: false, error: shortText(message.error, MAX_TEXT) }
  if (message.ok !== true || !Array.isArray(message.items) || message.items.length > MAX_ITEMS_PER_CHECK) return null
  const items: CheckedItem[] = []
  for (const raw of message.items) {
    const item = checkedItemOf(raw)
    if (!item) return null
    items.push(item)
  }
  const seen = keysOf(message.seen, MAX_SEEN)
  return seen ? { ...base, ok: true, items, seen } : null
}
