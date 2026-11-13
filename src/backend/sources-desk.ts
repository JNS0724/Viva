import { t } from '../shared/i18n/translate.ts'
import { sourcesToAppOf, type CheckedItem } from '../shared/sources-channel.ts'
import type { SourceStore, StoredSource } from './message-sources.ts'

/**
 * The app's side of viva-sources (plugins/sources, shared/sources-channel.ts): the sources go to the plugin when it
 * starts and again whenever they change; a source added or removed from the conversation is done here and answered;
 * each check's result comes back, its pushed messages go into 动态 and its keys are remembered.
 */

/** How a source stands since the app started, for 能力 · 消息源. */
export interface SourceStatus {
  /** When the last check ended, whether it went through or not. */
  checkedAt: number | null
  nextAt: number | null
  /** New messages in the last check that went through, and how many of them were pushed. */
  fresh: number
  pushed: number
  /** Why the last check failed; empty when it went through. */
  error: string
}

export const NO_SOURCE_STATUS: SourceStatus = Object.freeze({ checkedAt: null, nextAt: null, fresh: 0, pushed: 0, error: '' })

/** A source as the window shows it: what it reads and how often, and how it stands; no seen keys. */
export interface SourceView {
  id: string
  name: string
  tool: string
  judge: string
  everyMinutes: number
  paused: boolean
  createdAt: number
  lastCheckedAt: number | null
  status: SourceStatus
}

export const viewOf = (source: StoredSource, status: SourceStatus): SourceView => ({
  id: source.id,
  name: source.name,
  tool: source.tool,
  judge: source.judge,
  everyMinutes: source.everyMinutes,
  paused: source.paused,
  createdAt: source.createdAt,
  lastCheckedAt: source.lastCheckedAt,
  status,
})

/**
 * Third-party text as plain text in 动态's Markdown: every ASCII punctuation mark escaped (CommonMark lets each be,
 * and view/markdown.ts shows an escape as its character), so nothing in it becomes a link, an address or a heading,
 * and no line is indented into code.
 */
export const plainMarkdown = (text: string) => text.replace(/^[ \t]+/gm, '').replace(/([!-/:-@[-`{-~])/g, '\\$1')

/** An http(s) address as a Markdown link target, or null. */
function linkTarget(link: string): string | null {
  try {
    const url = new URL(link)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href.replaceAll('(', '%28').replaceAll(')', '%29') : null
  } catch {
    return null
  }
}

/** A pushed message as 动态 shows it: what it says, why it was worth a reminder, and a link to the original. */
export function sourceItemBody(item: Pick<CheckedItem, 'body' | 'reason' | 'link'>): string {
  const target = item.link ? linkTarget(item.link) : null
  return [
    plainMarkdown(item.body.trim()),
    item.reason ? t('main.sources.why', { reason: plainMarkdown(item.reason) }) : '',
    target ? `[${t('main.sources.open.original')}](${target})` : '',
  ].filter(Boolean).join('\n\n')
}

export function createSourcesDesk({ send, store, deliver, onChange, now = Date.now }: {
  send: (message: object) => void
  /** The store, once the app's personal data is open. */
  store: () => SourceStore | null
  /** A source's pushed messages, for 动态. */
  deliver: (source: StoredSource, items: CheckedItem[]) => void
  /** The sources or how they stand changed. */
  onChange: () => void
  now?: () => number
}) {
  const statuses = new Map<string, SourceStatus>()
  const push = () => send({ type: 'sources_set', version: 1, sources: store()?.list() ?? [] })
  const reply = (id: string, ok: boolean, text: string) => send({ type: 'source_reply', version: 1, id, ok, text })
  const statusOf = (id: string) => statuses.get(id) ?? NO_SOURCE_STATUS

  function changed() {
    push()
    onChange()
  }

  function request(id: string, run: (sources: SourceStore) => string) {
    const sources = store()
    if (!sources) return reply(id, false, t('main.sources.not.ready'))
    try {
      const text = run(sources)
      reply(id, true, text)
      return changed()
    } catch (err) {
      return reply(id, false, err instanceof Error ? err.message : String(err))
    }
  }

  function remove(sources: SourceStore, id: string) {
    const removed = sources.remove(id)
    if (!removed) throw new Error(t('main.sources.not.found'))
    statuses.delete(removed.id)
    return removed
  }

  function receive(raw: unknown) {
    const message = sourcesToAppOf(raw)
    if (!message) return undefined
    if (message.type === 'sources_ready') return push()
    if (message.type === 'source_request') {
      if (message.op === 'add') return request(message.id, (sources) => t('main.sources.added', { name: sources.add(message.draft, message.seen).name }))
      return request(message.id, (sources) => t('main.sources.removed', { name: remove(sources, message.sourceId).name }))
    }
    const sources = store()
    const source = sources?.list().find((item) => item.id === message.sourceId)
    if (!sources || !source) return undefined
    if (!message.ok) {
      statuses.set(source.id, { ...statusOf(source.id), checkedAt: now(), nextAt: message.nextAt, error: message.error || t('main.sources.check.failed') })
      return onChange()
    }
    // Remembered before delivering. If it cannot be (a full disk, a locked file), the reminders still go to 动态, which
    // keeps one item per source and key: the next check may judge them again, but nothing is pushed twice.
    let kept: StoredSource | null = source
    try {
      kept = sources.recordCheck(source.id, message.at, [...message.seen, ...message.items.map((item) => item.key)])
    } catch (err) {
      console.error('[sources] could not remember a check:', err instanceof Error ? err.message : String(err))
    }
    const pushed = message.items.filter((item) => item.push)
    statuses.set(source.id, { checkedAt: now(), nextAt: message.nextAt, fresh: message.items.length, pushed: pushed.length, error: '' })
    if (kept && pushed.length) {
      try {
        deliver(kept, pushed)
      } catch (err) {
        // Seen keys are kept first so nothing is pushed twice; one that could not be kept in 动态 is said here.
        console.error('[sources] could not put a reminder into 动态:', err instanceof Error ? err.message : String(err))
      }
    }
    return onChange()
  }

  return {
    receive,
    push,
    /** 暂停 / 恢复 from 能力 · 消息源. */
    setPaused(id: string, paused: boolean) {
      if (!store()?.setPaused(id, paused)) throw new Error(t('main.sources.not.found'))
      if (paused) statuses.set(id, { ...statusOf(id), nextAt: null })
      changed()
    },
    /** 删除 from 能力 · 消息源. */
    remove(id: string) {
      const sources = store()
      if (!sources) throw new Error(t('main.sources.not.ready'))
      remove(sources, id)
      changed()
    },
    views: (): SourceView[] => (store()?.list() ?? []).map((source) => viewOf(source, statusOf(source.id))),
  }
}
