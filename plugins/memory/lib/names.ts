import { STOP_BIGRAMS } from './match.ts'

/**
 * Layer 2 of retrieval works on names, not words. The profile and the memories' keywords make a small
 * vocabulary of the people, projects and systems the user deals with; a memory is pushed only when the
 * question names one of them. An exact name says far more than two texts sharing a few characters.
 */

/** Profile fields that list names; the others are sentences. People and teams come from memories' keywords. */
const NAME_FIELDS = ['projects']
const NAME_SEPARATORS = /[\n、，,;；/|]+/
const MIN_NAME_CHARS = 2
const MAX_NAME_CHARS = 20
/** A long Han name ("对账系统重构") is also known by any four characters of it ("对账系统"). */
const ALIAS_CHARS = 4
/** Too general to say what a question is about, even when a model offers them as keywords. */
const GENERIC_NAMES = new Set(['项目', '系统', '工作', '问题', '事情', '用户', '今天', '明天', '公司', '同事', '文档'])

const isWordChar = (char) => /[a-z0-9]/i.test(char ?? '')

/** "张三（产品）" → "张三", "张三：直属上级" → "张三", "- Q4 对账系统重构" → "Q4 对账系统重构". */
const cleanName = (part) => part
  .replace(/[（(][^）)]*[）)]/g, ' ')
  .split(/[:：]/)[0]
  .replace(/^[-*•\s]+/, '')
  .replace(/\s+/g, ' ')
  .trim()

function isUsableName(name) {
  const length = [...name].length
  if (length < MIN_NAME_CHARS || length > MAX_NAME_CHARS) return false
  const key = name.toLowerCase()
  return !GENERIC_NAMES.has(key) && !STOP_BIGRAMS.has(key) && /[\p{L}\p{N}]/u.test(key)
}

/** The name itself, then the four-character windows of every Han run longer than four characters. */
function aliasesOf(key) {
  const windows: string[] = []
  for (const run of key.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run]
    if (chars.length <= ALIAS_CHARS) continue
    for (let i = 0; i + ALIAS_CHARS <= chars.length; i += 1) windows.push(chars.slice(i, i + ALIAS_CHARS).join(''))
  }
  return [key, ...windows.filter((window) => window !== key)]
}

/** Whether `needle` occurs in `haystack`; a Latin end must not run on into a longer word ("pr" ≠ "prompt"). */
function occurs(haystack, needle) {
  const startsWord = isWordChar(needle[0])
  const endsWord = isWordChar(needle[needle.length - 1])
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const startOk = !startsWord || !isWordChar(haystack[at - 1])
    const endOk = !endsWord || !isWordChar(haystack[at + needle.length])
    if (startOk && endOk) return true
  }
  return false
}

/**
 * @typedef {{ name: string, key: string, aliases: string[] }} NameEntry
 *   name as written, key lower-cased (its identity), aliases the strings searched for
 */

/** @returns {NameEntry | null} */
function entryOf(raw) {
  const name = cleanName(String(raw ?? ''))
  if (!isUsableName(name)) return null
  const key = name.toLowerCase()
  return { name, key, aliases: aliasesOf(key) }
}

/** Names listed in the profile ("张三、李四", one project a line). */
const profileNames = (profile) => NAME_FIELDS.flatMap((field) => (profile[field]?.value ?? '').split(NAME_SEPARATORS))

/**
 * @param {Record<string, { value: string }>} profile
 * @param {Array<{ keywords?: string[] }>} memories
 * @returns {NameEntry[]} one entry per name, first spelling wins
 */
export function buildLexicon(profile, memories) {
  const raw = [...profileNames(profile), ...memories.flatMap((memory) => memory.keywords ?? [])]
  const byKey = new Map()
  for (const entry of raw.map(entryOf)) {
    if (entry && !byKey.has(entry.key)) byKey.set(entry.key, entry)
  }
  return [...byKey.values()]
}

/** @returns {Map<string, string>} key → name, for the lexicon names that `text` mentions */
export function namesIn(text, lexicon) {
  const haystack = String(text ?? '').toLowerCase()
  return new Map(lexicon
    .filter((entry) => entry.aliases.some((alias) => occurs(haystack, alias)))
    .map((entry) => [entry.key, entry.name]))
}

/**
 * The names a memory is about: its keywords, plus the candidate names its text mentions (a memory the
 * user typed has no keywords, but "周报交给张三" is still about 张三).
 * @param {{ text: string, keywords?: string[] }} memory
 * @param {NameEntry[]} candidates the entries worth checking, usually the ones the question named
 * @returns {Set<string>} keys
 */
export function namesOfMemory(memory, candidates) {
  const own = (memory.keywords ?? []).map((keyword) => cleanName(keyword).toLowerCase())
  return new Set([...own, ...namesIn(memory.text, candidates).keys()])
}
