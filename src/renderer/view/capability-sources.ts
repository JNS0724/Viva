import { t } from '../../shared/i18n/translate.ts'
import type { SourceView } from '../capability-types.ts'
import { shownSource } from '../capabilities-state.ts'
import { sourceStanding, sourcesOf } from '../sources-state.ts'
import { h } from './dom.ts'
import { whenText } from './proposal-card.ts'

/**
 * 能力 · 消息源 (view/capabilities.ts): the user's message sources, each with how often it checks and how it stands,
 * and the one picked: what it reads (one tool, read only), its pace, what is worth a reminder, the last check, and
 * 暂停 / 删除. New ones, and changes to one, come from the conversation; 添加消息源 starts that there.
 */

/**
 * When the next check is due: as the plugin last said, or, before it has said since the app started, a pace after the
 * last check (or after it was turned on).
 */
export const nextCheck = (source: SourceView) => source.status.nextAt ?? (source.lastCheckedAt ?? source.createdAt) + source.everyMinutes * 60_000

/** A source's standing as a tone and words: paused, its last check failed, or on (its pace and last check). */
function standingText(source: SourceView, now: number, { next }: { next: boolean }) {
  const standing = sourceStanding(source)
  if (standing.kind === 'paused') return { tone: 'idle', text: t('sources.paused') }
  if (standing.kind === 'failed') return { tone: 'off', text: t('sources.failed', { reason: standing.reason }) }
  if (next) return { tone: 'ok', text: t('sources.next', { when: whenText(nextCheck(source), now) }) }
  const every = t('sources.every', { minutes: source.everyMinutes })
  return { tone: 'ok', text: source.lastCheckedAt === null ? every : `${every} · ${t('sources.last', { when: whenText(source.lastCheckedAt, now) })}` }
}

export function sourcesSide(state: State, handlers: Handlers, now = Date.now()): Node[] {
  const sources = sourcesOf(state)
  const shown = shownSource(state)
  const add = h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t('sources.add'), onClick: () => handlers.addSource() })
  if (!sources.length) return [h('div', { class: 'empty cap-sources-empty' }, h('p', { text: t('sources.empty') }), add)]
  return [
    h('div', { class: 'cap-tools' }, add),
    ...sources.map((source) => {
      const standing = standingText(source, now, { next: false })
      return h('button', {
        class: 'tp-row cap-row', type: 'button', 'data-name': source.name, 'aria-current': source.id === shown?.id ? 'page' : null,
        onClick: () => handlers.selectCapability(source.id),
      }, h('span', { class: 'tp-name', text: source.name }), h('span', { class: 'ext-status', 'data-tone': standing.tone, text: standing.text }))
    }),
    h('p', { class: 'help cap-hint', text: t('sources.hint') }),
  ]
}

/** The last check: when, and how many new messages it found and pushed (known since the app started). */
function lastCheck(source: SourceView, now: number) {
  if (source.lastCheckedAt === null) return t('sources.not.checked')
  const when = whenText(source.lastCheckedAt, now)
  return source.status.checkedAt === null ? when : t('sources.last.check', { when, fresh: source.status.fresh, pushed: source.status.pushed })
}

export function sourceMain(state: State, handlers: Handlers, now = Date.now()): HTMLElement {
  const source = shownSource(state)
  if (!source) return h('div', { class: 'tp-main tp-empty' })
  const busy = Boolean(state.sources.busy)
  const status = standingText(source, now, { next: true })
  return h('div', { class: 'tp-main' },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: source.name }),
      h('span', { class: 'ext-status cap-standing', 'data-tone': status.tone, title: status.text, text: status.text })),
    h('div', { class: 'tp-scroll' },
      h('div', { class: 'ext-item cap-card', 'data-name': source.name },
        h('dl', { class: 'cap-facts' },
          h('dt', { text: t('sources.reads') }), h('dd', {}, h('span', { class: 'mono', text: source.tool }), h('span', { class: 'muted', text: t('sources.read.only') })),
          h('dt', { text: t('sources.pace') }), h('dd', { text: t('sources.pace.text', { minutes: source.everyMinutes }) }),
          h('dt', { text: t('sources.judge') }), h('dd', { text: source.judge }),
          h('dt', { text: t('sources.last.label') }), h('dd', { text: lastCheck(source, now) })),
        h('div', { class: 'ext-actions settings-actions' },
          h('button', {
            class: 'btn btn-outline btn-small', type: 'button', disabled: busy,
            text: source.paused ? t('sources.resume') : t('sources.pause'),
            onClick: () => handlers.pauseSource(source.id, !source.paused),
          }),
          h('button', {
            class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: t('extensions.delete'),
            'aria-label': t('sources.delete.named', { name: source.name }), onClick: () => handlers.deleteSource(source.id),
          }))),
      h('p', { class: 'help', text: t('sources.how') })))
}
