import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fieldLabel, MAX_FIELD_CHARS, PROFILE_KEYS, RETIRED_FIELDS } from '../../../src/shared/profile-fields.ts'

/** role: who the user is (job, team, field); person / project: who and what they deal with. */
export const MEMORY_KINDS = Object.freeze(['fact', 'preference', 'person', 'project', 'role'])
/** The kinds a profile is made of: the synthesis summarises them, the fixed layer lists the newest. */
export const PROFILE_KINDS = Object.freeze(['role', 'person', 'project', 'preference'])
export const MAX_SYNTHESIS_CHARS = 1200
/** The version of the memory.db contract this code reads and writes (see docs/memory.md). */
export const CONTRACT_VERSION = 1
export const MEMORY_SOURCES = Object.freeze(['user', 'agent'])
export const ONBOARDING_STATES = Object.freeze(['pending', 'done', 'skipped'])
export const MAX_MEMORY_CHARS = 500
export const MAX_KEYWORDS = 6
export const MAX_KEYWORD_CHARS = 20
const MIN_KEYWORD_CHARS = 2
/** At most this many changes from one background extraction; more means the extractor misread the turn. */
export const MAX_EXTRACTED_CHANGES = 3
const MAX_MEMORIES = 5000
const LIST_LIMIT = 200
const MAX_QUERY_CHARS = 200
/** The injection log only feeds the view of what recent turns were told. */
const MAX_INJECTIONS = 1000
const MAX_HABITS_CHARS = 200
const MAX_SYNTHESES_KEPT = 20
/** Profile fields the agent used to append to, before it wrote memories instead, and the kind they become. */
const FIELD_KINDS: Readonly<Record<string, string>> = { role: 'role', department: 'role', domain: 'role', projects: 'project', people: 'person', preferences: 'preference' }

/** A memory as the app and the plugin hold it. */
export interface Memory {
  id: number
  text: string
  kind: string
  source: string
  keywords: string[]
  conversationId: string | null
  createdAt: number
  updatedAt: number
  /** Set when the memory stopped being true (replaced, or forgotten); null while it is valid. */
  invalidAt: number | null
  supersededBy: number | null
  invalidatedBy: string | null
}

/** A row of `memories`, as SCHEMA declares it (keywords one per line). */
interface MemoryRow {
  id: number, text: string, norm: string, kind: string, source: string, conversation_id: string | null,
  created_at: number, updated_at: number, keywords: string, invalid_at: number | null, superseded_by: number | null,
  invalidated_by: string | null
}

/** The filled profile fields, by field. */
export type Profile = Record<string, { value: string, source: string, updatedAt: number }>

/** What addMemory is given; text and keywords are checked before anything is kept. */
export interface NewMemory { text: unknown, kind?: string, source?: string, conversationId?: string | null, keywords?: unknown }

/** One background extraction: shown, the ids of the memories the extractor was given, the only ones it may invalidate. */
export interface Extraction {
  add: Array<{ text: string, kind?: string, keywords?: string[], replaces?: number | null }>
  invalidate: number[]
  shown: Set<number>
}

/** What a turn put in front of the model, as logged. */
export interface Injection { id: number, turn: number, at: number, fixed: string | null, pushed: Array<{ text: string, names: string[] }> }

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS profile (
    field TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    norm TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    invalid_at INTEGER,
    superseded_by INTEGER,
    invalidated_by TEXT
  );
  CREATE INDEX IF NOT EXISTS memories_recent ON memories (updated_at);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS injections (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    fixed TEXT,
    pushed TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS injections_recent ON injections (session_id, created_at);
  CREATE TABLE IF NOT EXISTS syntheses (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`

/**
 * Things that must never be kept or sent to the model: keys, passwords, codes, ID numbers.
 * Mentions of the topic ("密码每 90 天更换") are fine; only a value being handed over is refused.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /(密码|口令|password|passwd|pwd)\s*(是|为|[:：=])\s*\S/i,
  /(验证码|动态码|otp)\s*(是|为|[:：=])?\s*\d{4,}/i,
  /\b(token|secret|api[_ -]?key|access[_ -]?key)\s*[:：=]\s*\S{6,}/i,
  /\b\d{17}[\dXx]\b/,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/,
]

/** Document links carry long ids (a Google Docs id is 44 characters) that are not secrets. */
const withoutLinks = (text: string) => text.replace(/https?:\/\/\S+/gi, ' ')

export const looksSecret = (text: string): boolean => SECRET_PATTERNS.some((pattern) => pattern.test(withoutLinks(text)))

/** Same memory, different spacing or closing punctuation. */
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').replace(/[。.!！?？;；,，\s]+$/u, '').trim()

function cleanText(input: unknown, { max, what }: { max: number, what: string }): string {
  if (typeof input !== 'string') throw new Error(`${what}必须是文本`)
  const text = input.trim()
  if (!text) throw new Error(`${what}不能为空`)
  if (text.length > max) throw new Error(`${what}太长了（最多 ${max} 个字）`)
  if (looksSecret(text)) throw new Error('看起来包含密码、密钥或证件号，这类内容不会被记住')
  return text
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly unknown[]).includes(value)) throw new Error(`invalid ${what}: ${value}`)
  return value as T
}

function assertMemoryId(id: unknown): number {
  if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new Error(`invalid memory id: ${id}`)
  return id as number
}

/**
 * The names a memory is about ("张三", "对账系统"), so that mentioning one brings it back. Unusable
 * ones (too short, too long, secret-looking) are dropped rather than refusing the whole memory.
 */
function cleanKeywords(input: unknown): string[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('关键词必须是列表')
  const usable = input
    .map((keyword: unknown) => (typeof keyword === 'string' ? keyword.replace(/\s+/g, ' ').trim() : ''))
    .filter((keyword) => {
      const length = [...keyword].length
      return length >= MIN_KEYWORD_CHARS && length <= MAX_KEYWORD_CHARS && !looksSecret(keyword)
    })
  const seen = new Set<string>()
  return usable.filter((keyword) => {
    const key = keyword.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_KEYWORDS)
}

const splitKeywords = (text: string | null | undefined): string[] => (text ? text.split('\n') : [])
const joinKeywords = (keywords: readonly string[]) => keywords.join('\n')

/** Columns added after the first release; older databases get them on open. */
const LATER_COLUMNS = [
  ['keywords', "TEXT NOT NULL DEFAULT ''"],
  ['invalid_at', 'INTEGER'],
  ['superseded_by', 'INTEGER'],
  ['invalidated_by', 'TEXT'],
]

/** Adds missing columns; the other process may add one first, which is fine. */
function addLaterColumns(db: DatabaseSync) {
  const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map((column) => column.name))
  for (const [name, type] of LATER_COLUMNS.filter(([column]) => !columns.has(column))) {
    try {
      db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`)
    } catch (err: any) {
      if (!/duplicate column/i.test(err.message)) throw err
    }
  }
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)
/** "张三（上级）" → "张三", "李四：风控对接人" → "李四". */
const nameIn = (line: string) => line.replace(/[（(][^）)]*[）)]/g, ' ').split(/[:：]/)[0].replace(/^[-*•\s]+/, '').trim()
const clipTo = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text)

const toMemory = (row: MemoryRow): Memory => ({
  id: row.id,
  text: row.text,
  kind: row.kind,
  source: row.source,
  keywords: splitKeywords(row.keywords),
  conversationId: row.conversation_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  invalidAt: row.invalid_at ?? null,
  supersededBy: row.superseded_by ?? null,
  invalidatedBy: row.invalidated_by ?? null,
})

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * The user's profile and long-term memories, in one SQLite file next to the history.
 * Opened by the main process and by the memory MCP server (another process), so writes are short
 * transactions and WAL lets both read while one writes.
 */
export function openMemoryDb({ file, now = Date.now }: { file: string, now?: () => number }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 3000;')
  db.exec(SCHEMA)
  addLaterColumns(db)

  /** A row is a record of what its query selects; each function below says what it returns. */
  const sql: Record<string, { get: (...params: any[]) => any, all: (...params: any[]) => any[], run: (...params: any[]) => { changes: number | bigint, lastInsertRowid: number | bigint } }> = {
    profile: db.prepare('SELECT field, value, source, updated_at FROM profile'),
    field: db.prepare('SELECT value, source FROM profile WHERE field = ?'),
    setField: db.prepare(`INSERT INTO profile (field, value, source, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (field) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`),
    dropField: db.prepare('DELETE FROM profile WHERE field = ?'),
    byNorm: db.prepare('SELECT * FROM memories WHERE norm = ?'),
    byId: db.prepare('SELECT * FROM memories WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM memories'),
    countValid: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE invalid_at IS NULL'),
    countInvalid: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE invalid_at IS NOT NULL'),
    insert: db.prepare(`INSERT INTO memories (text, norm, kind, source, conversation_id, created_at, updated_at, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    insertWithId: db.prepare(`INSERT INTO memories (id, text, norm, kind, source, conversation_id, created_at, updated_at, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    touch: db.prepare(`UPDATE memories SET updated_at = ?, keywords = ?, invalid_at = NULL, superseded_by = NULL, invalidated_by = NULL
      WHERE id = ?`),
    invalidate: db.prepare('UPDATE memories SET invalid_at = ?, superseded_by = ?, invalidated_by = ? WHERE id = ? AND invalid_at IS NULL'),
    revive: db.prepare('UPDATE memories SET invalid_at = NULL, superseded_by = NULL, invalidated_by = NULL, updated_at = ? WHERE id = ?'),
    invalidList: db.prepare('SELECT * FROM memories WHERE invalid_at IS NOT NULL ORDER BY invalid_at DESC, id DESC LIMIT ?'),
    invalidatedSince: db.prepare(`SELECT * FROM memories WHERE invalid_at >= ? AND invalidated_by = 'agent' ORDER BY id`),
    update: db.prepare('UPDATE memories SET text = ?, norm = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM memories WHERE id = ?'),
    recent: db.prepare('SELECT * FROM memories WHERE invalid_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?'),
    matching: db.prepare(`SELECT * FROM memories WHERE invalid_at IS NULL AND text LIKE ? ESCAPE '\\'
      ORDER BY updated_at DESC, id DESC LIMIT ?`),
    all: db.prepare('SELECT * FROM memories WHERE invalid_at IS NULL'),
    ofKind: db.prepare('SELECT * FROM memories WHERE invalid_at IS NULL AND kind = ? ORDER BY updated_at DESC, id DESC LIMIT ?'),
    unclaimed: db.prepare(`SELECT * FROM memories WHERE source = 'agent' AND conversation_id IS NULL AND created_at >= ?
      ORDER BY id`),
    claim: db.prepare('UPDATE memories SET conversation_id = ? WHERE id = ?'),
    agentFields: db.prepare(`SELECT field, value FROM profile WHERE source = 'agent'`),
    profileKindsSince: db.prepare(`SELECT * FROM memories WHERE invalid_at IS NULL AND kind IN (${PROFILE_KINDS.map(() => '?').join(', ')})
      AND updated_at > ? ORDER BY updated_at DESC, id DESC LIMIT ?`),
    profileKinds: db.prepare(`SELECT * FROM memories WHERE invalid_at IS NULL AND kind IN (${PROFILE_KINDS.map(() => '?').join(', ')})
      ORDER BY updated_at DESC, id DESC LIMIT ?`),
    changesSince: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE updated_at > ? OR invalid_at > ?'),
    profileInvalidationsSince: db.prepare(`SELECT COUNT(*) AS n FROM memories
      WHERE invalid_at > ? AND kind IN (${PROFILE_KINDS.map(() => '?').join(', ')})`),
    latestSynthesis: db.prepare('SELECT * FROM syntheses ORDER BY id DESC LIMIT 1'),
    saveSynthesis: db.prepare('INSERT INTO syntheses (text, created_at) VALUES (?, ?)'),
    pruneSyntheses: db.prepare('DELETE FROM syntheses WHERE id <= ? - ?'),
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    sessionState: db.prepare('SELECT state FROM sessions WHERE session_id = ?'),
    saveSession: db.prepare(`INSERT INTO sessions (session_id, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`),
    logInjection: db.prepare('INSERT INTO injections (session_id, turn, created_at, fixed, pushed) VALUES (?, ?, ?, ?, ?)'),
    pruneInjections: db.prepare('DELETE FROM injections WHERE id <= ? - ?'),
    injectionsAfter: db.prepare('SELECT * FROM injections WHERE session_id = ? AND id > ? ORDER BY id'),
    lastInjection: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM injections'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  }

  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /** Filled fields only. */
  function getProfile(): Profile {
    return Object.fromEntries(sql.profile.all()
      .filter((row) => PROFILE_KEYS.includes(row.field))
      .map((row) => [row.field, { value: row.value, source: row.source, updatedAt: row.updated_at }]))
  }

  function writeField(key: string, value: string, source: string, at: number) {
    if (value) sql.setField.run(key, value, source, at)
    else sql.dropField.run(key)
  }

  /**
   * Replaces the given fields; an empty value clears one. Profile text may name people and projects,
   * so only key-shaped secrets are refused, not every mention.
   */
  function setProfile(changes: Record<string, unknown> | null | undefined, source = 'user'): Profile {
    assertOneOf(source, MEMORY_SOURCES, 'source')
    const entries = Object.entries(changes ?? {}).map(([key, value]) => {
      assertOneOf(key, PROFILE_KEYS, 'profile field')
      if (typeof value !== 'string') throw new Error('画像内容必须是文本')
      const text = value.trim()
      if (text.length > MAX_FIELD_CHARS) throw new Error(`内容太长了（最多 ${MAX_FIELD_CHARS} 个字）`)
      if (text && looksSecret(text)) throw new Error('看起来包含密码、密钥或证件号，这类内容不会被记住')
      return [key, text]
    })
    const at = now()
    transaction(() => entries.forEach(([key, text]) => writeField(key, text, source, at)))
    return getProfile()
  }

  /** Refuses a database a newer contract wrote, rather than misreading it; records the version otherwise. */
  function claimContract() {
    const found = Number(sql.meta.get('contract_version')?.value ?? 0)
    if (found > CONTRACT_VERSION) {
      db.close()
      throw new Error(`memory.db 由更新的版本（约定 ${found}）写入，当前只支持到 ${CONTRACT_VERSION}`)
    }
    if (found < CONTRACT_VERSION) sql.setMeta.run('contract_version', String(CONTRACT_VERSION))
  }

  /**
   * Once per database: what the agent had appended to profile fields becomes agent memories (one per
   * line), so it can be replaced like any other memory; the profile is then the user's alone.
   */
  function migrateAgentProfile() {
    if (sql.meta.get('profile_migrated')) return
    transaction(() => {
      if (sql.meta.get('profile_migrated')) return
      const at = now()
      for (const { field, value } of sql.agentFields.all()) {
        for (const line of lines(value)) {
          const text = clipTo(`${fieldLabel(field)}：${line}`, MAX_MEMORY_CHARS)
          if (!looksSecret(text) && !sql.byNorm.get(normalize(text))) {
            sql.insert.run(text, normalize(text), FIELD_KINDS[field] ?? 'fact', 'agent', 'profile-migration', at, at, '')
          }
        }
        sql.dropField.run(field)
      }
      sql.setMeta.run('profile_migrated', String(at))
    })
  }

  /**
   * Once per database: what the user wrote in fields the profile no longer has becomes their own memories,
   * one per line, a name field's name as the keyword. A private field (the email) is left where it was.
   */
  function migrateRetiredFields() {
    if (sql.meta.get('profile_trimmed')) return
    transaction(() => {
      if (sql.meta.get('profile_trimmed')) return
      const at = now()
      for (const field of RETIRED_FIELDS.filter((item) => !item.private)) {
        const row = sql.field.get(field.key)
        if (!row) continue
        for (const line of lines(row.value)) {
          const text = clipTo(`${field.label}：${line}`, MAX_MEMORY_CHARS)
          const keywords = field.names ? joinKeywords(cleanKeywords([nameIn(line)])) : ''
          if (!looksSecret(text) && !sql.byNorm.get(normalize(text))) {
            sql.insert.run(text, normalize(text), field.kind, 'user', 'profile-migration', at, at, keywords)
          }
        }
        sql.dropField.run(field.key)
      }
      sql.setMeta.run('profile_trimmed', String(at))
    })
  }

  /**
   * An existing equal memory is refreshed instead (made valid again if it had been invalidated), and gains
   * the new keywords.
   */
  function addMemory({ text: input, kind = 'fact', source = 'user', conversationId = null, keywords: keywordInput = [] }: NewMemory): { memory: Memory, created: boolean } {
    const text = cleanText(input, { max: MAX_MEMORY_CHARS, what: '记忆' })
    const keywords = cleanKeywords(keywordInput)
    assertOneOf(kind, MEMORY_KINDS, 'memory kind')
    assertOneOf(source, MEMORY_SOURCES, 'source')
    const norm = normalize(text)
    const at = now()
    return transaction(() => {
      const existing = sql.byNorm.get(norm)
      if (existing) {
        const merged = joinKeywords(cleanKeywords([...splitKeywords(existing.keywords), ...keywords]))
        sql.touch.run(at, merged, existing.id)
        return { memory: toMemory(sql.byId.get(existing.id)), created: false }
      }
      if (sql.count.get().n >= MAX_MEMORIES) throw new Error(`记忆已经有 ${MAX_MEMORIES} 条了，请先在「关于你」里清理一些`)
      const { lastInsertRowid } = sql.insert.run(text, norm, kind, source, conversationId, at, at, joinKeywords(keywords))
      return { memory: toMemory(sql.byId.get(lastInsertRowid)), created: true }
    })
  }

  function getMemory(id: unknown): Memory | null {
    const row = sql.byId.get(assertMemoryId(id))
    return row ? toMemory(row) : null
  }

  function updateMemory(id: unknown, input: unknown): Memory {
    const text = cleanText(input, { max: MAX_MEMORY_CHARS, what: '记忆' })
    const norm = normalize(text)
    return transaction(() => {
      const row = sql.byId.get(assertMemoryId(id))
      if (!row) throw new Error('找不到这条记忆，可能已被删除')
      const other = sql.byNorm.get(norm)
      if (other && other.id !== id) throw new Error('已经有一条相同的记忆了')
      sql.update.run(text, norm, now(), id)
      return toMemory(sql.byId.get(id))
    })
  }

  /** @returns the deleted memory, so it can be put back, or null if there was none */
  function deleteMemory(id: unknown): Memory | null {
    return transaction(() => {
      const row = sql.byId.get(assertMemoryId(id))
      if (!row) return null
      sql.remove.run(id)
      return toMemory(row)
    })
  }

  /** Puts back a memory returned by `deleteMemory` (undo), keeping its id and dates; it comes back from the window, so each field is checked. */
  function restoreMemory(input: Record<string, any> | null | undefined): Memory {
    const memory = input ?? {}
    const text = cleanText(memory.text, { max: MAX_MEMORY_CHARS, what: '记忆' })
    const norm = normalize(text)
    return transaction(() => {
      const existing = sql.byNorm.get(norm)
      if (existing) return toMemory(existing)
      const id = assertMemoryId(memory.id)
      const kind = assertOneOf(memory.kind, MEMORY_KINDS, 'memory kind')
      const source = assertOneOf(memory.source, MEMORY_SOURCES, 'source')
      const createdAt = Number(memory.createdAt) || now()
      const values = [
        text, norm, kind, source, memory.conversationId ?? null, createdAt, Number(memory.updatedAt) || createdAt,
        joinKeywords(cleanKeywords(memory.keywords)),
      ]
      if (sql.byId.get(id)) sql.insert.run(...values)
      else sql.insertWithId.run(id, ...values)
      const restored = sql.byNorm.get(norm)
      if (memory.invalidAt) sql.invalidate.run(Number(memory.invalidAt), memory.supersededBy ?? null, memory.invalidatedBy ?? 'user', restored.id)
      return toMemory(sql.byId.get(restored.id))
    })
  }

  /**
   * Valid memories, newest first; with a query, the ones containing it. `invalid` counts the
   * invalidated ones, which `listInvalid` returns.
   */
  function listMemories({ query = '', limit = LIST_LIMIT }: { query?: unknown, limit?: unknown } = {}): { items: Memory[], total: number, invalid: number } {
    if (typeof query !== 'string' || query.length > MAX_QUERY_CHARS) throw new Error('invalid memory query')
    const size = Math.min(Math.max(1, Number(limit) || LIST_LIMIT), LIST_LIMIT)
    const needle = query.trim()
    const rows = needle ? sql.matching.all(`%${escapeLike(needle)}%`, size) : sql.recent.all(size)
    return { items: rows.map(toMemory), total: sql.countValid.get().n, invalid: sql.countInvalid.get().n }
  }

  /** Invalidated memories, most recently invalidated first. */
  const listInvalid = (limit: unknown = LIST_LIMIT): Memory[] => sql.invalidList.all(Math.min(Math.max(1, Number(limit) || LIST_LIMIT), LIST_LIMIT)).map(toMemory)

  /**
   * Marks a memory as no longer true without deleting it. Only `by: 'user'` may invalidate what the
   * user wrote; the agent never overrides the user.
   * @returns the memory as it now is, or null when there is no such memory
   */
  function invalidateMemory(id: unknown, { by, supersededBy = null }: { by: unknown, supersededBy?: number | null }): Memory | null {
    assertOneOf(by, MEMORY_SOURCES, 'invalidated by')
    return transaction(() => {
      const row = sql.byId.get(assertMemoryId(id))
      if (!row) return null
      if (row.source === 'user' && by !== 'user') throw new Error(`#${id} 是用户自己写的，只有用户能让它失效`)
      sql.invalidate.run(now(), supersededBy, by, id)
      return toMemory(sql.byId.get(id))
    })
  }

  /** Makes an invalidated memory valid again (undo, or the user disagreeing with an update). */
  function reviveMemory(id: unknown): Memory {
    return transaction(() => {
      const row = sql.byId.get(assertMemoryId(id))
      if (!row) throw new Error('找不到这条记忆，可能已被删除')
      sql.revive.run(now(), id)
      return toMemory(sql.byId.get(id))
    })
  }

  /** What the agent invalidated since `since`, for the app to tell the user. */
  const invalidatedSince = (since: number): Memory[] => sql.invalidatedSince.all(since).map(toMemory)

  /** Adds an agent memory, or refreshes an equal one; @returns its id. */
  function upsertAgentMemory(item: Extraction['add'][number], at: number): number {
    const text = cleanText(item.text, { max: MAX_MEMORY_CHARS, what: '记忆' })
    const kind = assertOneOf(item.kind ?? 'fact', MEMORY_KINDS, 'memory kind')
    const norm = normalize(text)
    const existing = sql.byNorm.get(norm)
    if (existing) {
      sql.touch.run(at, joinKeywords(cleanKeywords([...splitKeywords(existing.keywords), ...(item.keywords ?? [])])), existing.id)
      return existing.id
    }
    return Number(sql.insert.run(text, norm, kind, 'agent', null, at, at, joinKeywords(cleanKeywords(item.keywords))).lastInsertRowid)
  }

  /**
   * Applies one background extraction, all or nothing: any change that would fail (a secret, an
   * unknown kind, a memory the extractor was not shown, one the user wrote) rolls the whole batch back.
   */
  function applyExtraction({ add, invalidate, shown }: Extraction): { added: Memory[], invalidated: number[] } {
    if (add.length + invalidate.length > MAX_EXTRACTED_CHANGES) throw new Error(`一次最多 ${MAX_EXTRACTED_CHANGES} 处改动`)
    const assertChangeable = (id: number) => {
      const row = sql.byId.get(assertMemoryId(id))
      if (!shown.has(id) || !row) throw new Error(`#${id} 不在可修改的范围里`)
      if (row.source === 'user') throw new Error(`#${id} 是用户自己写的，后台不能让它失效`)
    }
    return transaction(() => {
      const at = now()
      const invalidated: number[] = []
      const added = add.map((item) => {
        const id = upsertAgentMemory(item, at)
        if (item.replaces !== null && item.replaces !== undefined && item.replaces !== id) {
          assertChangeable(item.replaces)
          sql.invalidate.run(at, id, 'agent', item.replaces)
          invalidated.push(item.replaces)
        }
        return toMemory(sql.byId.get(id))
      })
      for (const id of invalidate) {
        assertChangeable(id)
        sql.invalidate.run(at, null, 'agent', id)
        invalidated.push(id)
      }
      if (sql.count.get().n > MAX_MEMORIES) throw new Error(`记忆已经有 ${MAX_MEMORIES} 条了`)
      return { added, invalidated }
    })
  }

  /** Valid profile-kind memories, newest first; with `since`, only those written or refreshed after it. */
  const profileMemories = ({ since = null, limit = LIST_LIMIT }: { since?: number | null, limit?: number } = {}): Memory[] => (since === null
    ? sql.profileKinds.all(...PROFILE_KINDS, limit)
    : sql.profileKindsSince.all(...PROFILE_KINDS, since, limit)).map(toMemory)

  /** The latest profile the agent synthesised from the memories, or null before the first. */
  function latestSynthesis(): { id: number, text: string, createdAt: number } | null {
    const row = sql.latestSynthesis.get()
    return row ? { id: row.id, text: row.text, createdAt: row.created_at } : null
  }

  /** How many memories were written, refreshed or invalidated after `since`. */
  const changesSince = (since: number): number => sql.changesSince.get(since, since).n
  /** Profile memories that stopped being true after `since`: the synthesis may now say something false. */
  const profileInvalidationsSince = (since: number): number => sql.profileInvalidationsSince.get(since, ...PROFILE_KINDS).n

  /** Keeps a new synthesis (and the last few before it). Checked like any memory text: no secrets, bounded. */
  function saveSynthesis(input: unknown) {
    const text = cleanText(input, { max: MAX_SYNTHESIS_CHARS, what: '画像' })
    return transaction(() => {
      const { lastInsertRowid } = sql.saveSynthesis.run(text, now())
      sql.pruneSyntheses.run(Number(lastInsertRowid), MAX_SYNTHESES_KEPT)
      return latestSynthesis()
    })
  }

  /** Every memory, for retrieval to score; the store holds a few thousand short lines at most. */
  const allMemories = (): Memory[] => sql.all.all().map(toMemory)
  const ofKind = (kind: string, limit: number): Memory[] => sql.ofKind.all(assertOneOf(kind, MEMORY_KINDS, 'memory kind'), limit).map(toMemory)

  /**
   * What the agent wrote since `since` (through the memory tools, in the other process): its new
   * memories are tied to `conversationId` so the profile page can say where they came from.
   */
  function claimChanges(since: number, conversationId: string): { memories: Memory[] } {
    return transaction(() => {
      const memories = sql.unclaimed.all(since).map(toMemory)
      for (const memory of memories) sql.claim.run(conversationId, memory.id)
      return { memories: memories.map((m) => ({ ...m, conversationId })) }
    })
  }

  /** A session's retrieval state as the plugin saved it, or null (new session, or unreadable). */
  function sessionState(sessionId: string): unknown {
    const row = sql.sessionState.get(String(sessionId))
    if (!row) return null
    try {
      return JSON.parse(row.state)
    } catch {
      return null
    }
  }

  const saveSessionState = (sessionId: string, state: unknown) => sql.saveSession.run(String(sessionId), JSON.stringify(state), now())

  /** Records what was put in front of the model on a turn, so the app can show it. */
  function logInjection({ sessionId, turn, fixed, pushed }: { sessionId: string } & Omit<Injection, 'id' | 'at'>) {
    const { lastInsertRowid } = sql.logInjection.run(String(sessionId), turn, now(), fixed, JSON.stringify(pushed))
    sql.pruneInjections.run(Number(lastInsertRowid), MAX_INJECTIONS)
  }

  /**
   * The session's injections logged after the one with id `afterId`: ids only grow, so a reader that
   * remembers the last id it saw gets each entry exactly once.
   */
  const injectionsAfter = (afterId: number, sessionId: string): Injection[] => sql.injectionsAfter.all(String(sessionId), afterId).map((row) => ({
    id: row.id, turn: row.turn, at: row.created_at, fixed: row.fixed, pushed: JSON.parse(row.pushed),
  }))
  const lastInjectionId = () => sql.lastInjection.get().id

  /** Work habits, read by the app from its own history; part of the fixed layer. */
  const habits = () => sql.meta.get('habits')?.value ?? ''
  const setHabits = (text: unknown) => sql.setMeta.run('habits', String(text ?? '').slice(0, MAX_HABITS_CHARS))

  /** Set by the plugin when dsh loads it, so the app can tell whether memory is working. */
  const pluginStartedAt = () => Number(sql.meta.get('plugin_started_at')?.value ?? 0)
  const markPluginStarted = () => sql.setMeta.run('plugin_started_at', String(now()))

  const onboarding = () => sql.meta.get('onboarding')?.value ?? 'pending'
  const setOnboarding = (status: unknown) => sql.setMeta.run('onboarding', assertOneOf(status, ONBOARDING_STATES, 'onboarding state'))

  migrateAgentProfile()
  migrateRetiredFields()
  claimContract()

  return {
    getProfile, setProfile, profileMemories, latestSynthesis, saveSynthesis, changesSince, profileInvalidationsSince,
    addMemory, getMemory, updateMemory, deleteMemory, restoreMemory, listMemories, allMemories, ofKind,
    listInvalid, invalidateMemory, reviveMemory, invalidatedSince, applyExtraction,
    claimChanges, onboarding, setOnboarding,
    sessionState, saveSessionState, logInjection, injectionsAfter, lastInjectionId,
    habits, setHabits, pluginStartedAt, markPluginStarted,
    close: () => db.close(),
  }
}
