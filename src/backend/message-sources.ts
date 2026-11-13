import crypto from 'node:crypto'
import fs from 'node:fs'
import { t } from '../shared/i18n/translate.ts'
import { MAX_SEEN, MAX_SOURCES, specOf, type SourceDraft, type SourceSpec } from '../shared/sources-channel.ts'

/**
 * The user's 消息源 (docs/system-design.md §12.2, shared/sources-channel.ts), kept in message-sources.json beside
 * mcp-servers.json: what each reads and how, as the user confirmed it in the conversation, with the keys of the
 * messages already seen (so a restart neither reminds twice nor re-judges). Each change is written whole, atomically.
 * A source is the user's consent to read that one tool; nothing else is ever called for it.
 */
export type StoredSource = SourceSpec & { seen: string[] }

const FILE_VERSION = 1

export interface SourceStore {
  list(): StoredSource[]
  /** A new source, enabled; its seen keys are the messages already there when it was confirmed. */
  add(draft: SourceDraft, seen: readonly string[]): StoredSource
  remove(id: string): StoredSource | null
  setPaused(id: string, paused: boolean): StoredSource | null
  /** A check went through: when it started, and the keys it saw. */
  recordCheck(id: string, at: number, keys: readonly string[]): StoredSource | null
}

/** The newest `MAX_SEEN` of what was seen before and now, each once, oldest first. */
export function mergeSeen(before: readonly string[], now: readonly string[]): string[] {
  const fresh = [...new Set(now)]
  const kept = before.filter((key) => !fresh.includes(key))
  return [...kept, ...fresh].slice(-MAX_SEEN)
}

export function createSourceStore({ file, onError = () => {}, now = Date.now, newId = () => `src-${crypto.randomBytes(4).toString('hex')}` }: {
  file: string
  onError?: (err: Error) => void
  now?: () => number
  newId?: () => string
}): SourceStore {
  let sources: StoredSource[] = read()

  function read(): StoredSource[] {
    if (!fs.existsSync(file)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown, sources?: unknown }
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.sources)) throw new Error(`unknown layout in ${file}`)
      return parsed.sources.flatMap((item: unknown) => {
        const spec = specOf(item)
        if (!spec) {
          onError(new Error('a message source in the file is malformed and was left out'))
          return []
        }
        const seen = (item as { seen?: unknown }).seen
        return [{ ...spec, seen: Array.isArray(seen) ? seen.filter((key): key is string => typeof key === 'string').slice(-MAX_SEEN) : [] }]
      })
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)))
      return []
    }
  }

  function write(next: StoredSource[]) {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, sources: next }), { mode: 0o600 })
    fs.renameSync(tmp, file)
    sources = next
  }

  function change(id: string, update: (source: StoredSource) => StoredSource): StoredSource | null {
    const found = sources.find((source) => source.id === id)
    if (!found) return null
    const next = update(found)
    write(sources.map((source) => (source.id === id ? next : source)))
    return next
  }

  return {
    list: () => sources.map((source) => ({ ...source, seen: [...source.seen] })),
    add(draft, seen) {
      if (sources.length >= MAX_SOURCES) throw new Error(t('main.sources.too.many', { max: MAX_SOURCES }))
      if (sources.some((source) => source.name === draft.name)) throw new Error(t('main.sources.name.taken', { name: draft.name }))
      const source: StoredSource = { ...draft, id: newId(), paused: false, createdAt: now(), lastCheckedAt: null, seen: mergeSeen([], seen) }
      write([...sources, source])
      return source
    },
    remove(id) {
      const found = sources.find((source) => source.id === id) ?? null
      if (found) write(sources.filter((source) => source.id !== id))
      return found
    },
    setPaused: (id, paused) => change(id, (source) => ({ ...source, paused })),
    recordCheck: (id, at, keys) => change(id, (source) => ({ ...source, lastCheckedAt: at, seen: mergeSeen(source.seen, keys) })),
  }
}
