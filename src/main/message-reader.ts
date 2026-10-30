import { t } from '../shared/i18n/translate.ts'
import { onLocaleChange } from '../shared/i18n/locale.ts'
import type { SourceFolder } from './source-folders.ts'
import type { MessageSearch, SourceHealth, StoredMessage } from './sources-db.ts'

/**
 * What the conversation's viva_messages_read gets (plugins/messages): the switched-on sources read again first
 * when their last read is a while ago (waited for a few seconds at most, so the answer never hangs on a slow
 * mailbox), then the messages that match, newest first, as text for the model. Everything in them was written
 * by other people, so the text says first that it is data: what a mail asks for is not what the user asked.
 */
export const STALE_AFTER_MS = 60_000
export const REFRESH_WAIT_MS = 20_000
const HOUR_MS = 3_600_000
const TEXT_CHARS = 600
const TOTAL_CHARS = 12_000
const MAX_WORDS = 5

/** What the model asked for, checked (messages-channel.ts). */
export interface ReadRequest { source: string | null, query: string | null, sinceHours: number, limit: number }

export interface ReaderDeps {
  /** The installed sources that are switched on. */
  enabled: () => SourceFolder[]
  health: (id: string) => Pick<SourceHealth, 'lastOkAt' | 'lastError'>
  search: (search: MessageSearch) => StoredMessage[]
  /** Reads one source now; resolves once it has (or right away when it is already reading). */
  pollNow: (id: string) => Promise<void>
  now?: () => number
  refreshWaitMs?: number
}

export let NO_SOURCES = t('messages.none')
onLocaleChange(() => { NO_SOURCES = t('messages.none') })

const pad = (n: number) => String(n).padStart(2, '0')
function timeOf(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** The sources the request names (by id or name), or all switched on; null when it names none of them. */
function pick(enabled: SourceFolder[], source: string | null): SourceFolder[] | null {
  if (!source) return enabled
  const wanted = source.trim().toLowerCase()
  const named = enabled.filter(({ manifest }) => manifest.id.toLowerCase() === wanted || manifest.name.toLowerCase().includes(wanted))
  return named.length ? named : null
}

/** Reads again the sources not read lately; true when all were done before the wait ran out. */
async function refresh(ids: string[], deps: ReaderDeps, now: number): Promise<boolean> {
  const stale = ids.filter((id) => {
    const last = deps.health(id).lastOkAt
    return last === null || now - last > STALE_AFTER_MS
  })
  if (!stale.length) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), deps.refreshWaitMs ?? REFRESH_WAIT_MS) })
  // A failed read is noted in its health and said below; the messages read before are still there.
  const done = Promise.all(stale.map((id) => deps.pollNow(id).catch(() => undefined))).then(() => true as const)
  try {
    return await Promise.race([done, waited])
  } finally {
    clearTimeout(timer)
  }
}

function statusLine(folder: SourceFolder, health: Pick<SourceHealth, 'lastOkAt' | 'lastError'>, finished: boolean): string {
  const name = folder.manifest.name
  if (health.lastError) return t('messages.failed', { name, error: clip(health.lastError, 120) })
  if (health.lastOkAt === null) return t('messages.never', { name })
  return t('messages.updated', { name, pending: finished ? '' : t('messages.pending'), time: timeOf(health.lastOkAt) })
}

function messageLines(messages: StoredMessage[], names: Map<string, string>, several: boolean): string[] {
  let budget = TOTAL_CHARS
  const lines: string[] = []
  for (const [index, message] of messages.entries()) {
    const head = [timeOf(message.at), message.from, message.title || t('messages.untitled')].filter(Boolean).join(' · ')
    const source = several ? `【${names.get(message.source) ?? message.source}】` : ''
    const body = message.text ? `\n   ${clip(message.text.replace(/\s+/g, ' ').trim(), TEXT_CHARS)}` : ''
    const entry = `${index + 1}. ${source}${head}${body}`
    if (entry.length > budget) {
      lines.push(t('messages.more', { count: messages.length - index }))
      break
    }
    budget -= entry.length
    lines.push(entry)
  }
  return lines
}

export async function readMessages(request: ReadRequest, deps: ReaderDeps): Promise<string> {
  const now = deps.now ?? Date.now
  const enabled = deps.enabled()
  if (!enabled.length) return NO_SOURCES
  const picked = pick(enabled, request.source)
  if (!picked) return t('messages.unknown', { source: request.source ?? '', names: enabled.map(({ manifest }) => manifest.name).join(t('list.separator')) })

  const ids = picked.map(({ manifest }) => manifest.id)
  const finished = await refresh(ids, deps, now())
  const words = (request.query ?? '').split(/\s+/).filter(Boolean).slice(0, MAX_WORDS)
  const since = now() - request.sinceHours * HOUR_MS
  const messages = deps.search({ sources: ids, words, since, limit: request.limit })
  const status = picked.map((folder) => statusLine(folder, deps.health(folder.manifest.id), finished))
  const scope = t('messages.scope', { hours: request.sinceHours, query: words.length ? t('messages.query', { words: words.join(' ') }) : '' })
  if (!messages.length) return [...status, t('messages.empty', { scope })].join('\n')
  const names = new Map(picked.map(({ manifest }) => [manifest.id, manifest.name]))
  return [
    ...status,
    t('messages.count', { scope, count: messages.length, note: t('messages.data') }),
    '',
    ...messageLines(messages, names, picked.length > 1),
  ].join('\n')
}
