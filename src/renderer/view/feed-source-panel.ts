import { FEED_SOURCE_INTERVALS, type FeedSourceSchedule, type FeedSourceView } from '../../shared/feed-source.ts'
import { t } from '../../shared/i18n/translate.ts'
import type { PluginView } from '../capability-types.ts'
import { emptyFeedSourceDraft, feedSourceDraftOf, isSourceDraftDirty, scheduleFromDraft, type FeedSourceDraft } from '../feed-state.ts'
import { h, label } from './dom.ts'
import { whenText } from './proposal-card.ts'

/**
 * Plugin-backed data source configuration panels for 动态 (view/feed-page.ts): flat single-column
 * forms with an explicit schedule selector (interval / daily / weekly / cron) and a plain-language
 * rule field, kept visually quiet to match Viva's UI guidelines.
 */
const WEEKDAY_KEYS = Object.freeze([
  { day: 1, key: 'feed.source.weekday.1' },
  { day: 2, key: 'feed.source.weekday.2' },
  { day: 3, key: 'feed.source.weekday.3' },
  { day: 4, key: 'feed.source.weekday.4' },
  { day: 5, key: 'feed.source.weekday.5' },
  { day: 6, key: 'feed.source.weekday.6' },
  { day: 7, key: 'feed.source.weekday.7' },
] as const)

export function sourceFreqText(schedule: FeedSourceSchedule): string {
  if (schedule.kind === 'interval') {
    return schedule.minutes < 60
      ? t('feed.source.interval.minutes', { count: schedule.minutes })
      : t('feed.source.interval.hours', { count: schedule.minutes / 60 })
  }
  if (schedule.kind === 'daily') return `${t('feed.source.freq.daily')} ${schedule.time}`
  if (schedule.kind === 'weekly') return `${t('feed.source.freq.weekly')} ${schedule.time}`
  return schedule.expression
}

export function sourceLastSummary(source: FeedSourceView, now: number): string {
  if (source.lastStatus === 'plugin_unavailable') return source.lastMessage || t('feed.source.status.plugin.unavailable')
  if (source.lastRunAt === null || source.lastStatus === 'idle') return t('feed.source.last.idle')
  const when = whenText(source.lastRunAt, now)
  if (source.lastStatus === 'published') return t('feed.source.last.published', { when, count: source.lastPublishedCount })
  if (source.lastStatus === 'skipped') {
    return source.lastMessage
      ? t('feed.source.last.skipped.reason', { when, reason: source.lastMessage })
      : t('feed.source.last.skipped', { when })
  }
  return t('feed.source.last.failed', { when, reason: source.lastMessage || '' })
}

function frequencyField(draft: FeedSourceDraft, prefix: string, disabled: boolean, handlers: Handlers) {
  const set = (changes: Partial<FeedSourceDraft>) => handlers.updateFeedSourceDraft(changes)
  const kinds: Array<{ kind: FeedSourceSchedule['kind'], label: string }> = [
    { kind: 'interval', label: t('feed.source.freq.interval') },
    { kind: 'daily', label: t('feed.source.freq.daily') },
    { kind: 'weekly', label: t('feed.source.freq.weekly') },
    { kind: 'cron', label: t('feed.source.freq.cron') },
  ]
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('feed.source.frequency') },
    ...kinds.map((entry) => h('button', {
      type: 'button',
      disabled,
      'aria-pressed': String(draft.freqKind === entry.kind),
      text: entry.label,
      onClick: () => set({ freqKind: entry.kind }),
    })))

  let control: HTMLElement
  if (draft.freqKind === 'interval') {
    control = h('select', {
      class: 'field mono fs-freq-select',
      name: `${prefix}:interval`,
      disabled,
      'aria-label': t('feed.source.freq.interval'),
      onChange: (event: Event) => set({ intervalMin: Number((event.target as HTMLSelectElement).value) }),
    }, ...FEED_SOURCE_INTERVALS.map((minutes) => h('option', {
      value: String(minutes),
      selected: draft.intervalMin === minutes,
      text: minutes < 60
        ? t('feed.source.interval.minutes', { count: minutes })
        : t('feed.source.interval.hours', { count: minutes / 60 }),
    })))
  } else if (draft.freqKind === 'daily') {
    control = h('input', {
      class: 'field mono fs-freq-time',
      type: 'time',
      name: `${prefix}:time`,
      value: draft.time,
      disabled,
      'aria-label': t('feed.source.freq.daily'),
      onChange: (event: Event) => set({ time: (event.target as HTMLInputElement).value }),
    })
  } else if (draft.freqKind === 'weekly') {
    const toggleDay = (day: number) => {
      const next = new Set(draft.weekdays)
      if (next.has(day) && next.size > 1) next.delete(day)
      else next.add(day)
      set({ weekdays: [...next].sort((a, b) => a - b) })
    }
    control = h('div', { class: 'fs-weekly' },
      h('div', { class: 'fs-days', role: 'group', 'aria-label': t('feed.source.freq.weekly') },
        ...WEEKDAY_KEYS.map(({ day, key }) => h('button', {
          class: 'fs-day',
          type: 'button',
          disabled,
          'aria-pressed': String(draft.weekdays.includes(day)),
          text: t(key),
          onClick: () => toggleDay(day),
        }))),
      h('input', {
        class: 'field mono fs-freq-time',
        type: 'time',
        name: `${prefix}:time`,
        value: draft.time,
        disabled,
        'aria-label': t('feed.source.freq.weekly'),
        onChange: (event: Event) => set({ time: (event.target as HTMLInputElement).value }),
      }))
  } else {
    control = h('input', {
      class: 'field mono fs-freq-cron',
      type: 'text',
      name: `${prefix}:cron`,
      value: draft.cron,
      placeholder: t('feed.source.cron.placeholder'),
      disabled,
      'aria-label': t('feed.source.freq.cron'),
      onInput: (event: Event) => set({ cron: (event.target as HTMLInputElement).value }),
    })
  }

  return h('div', { class: 'fs-field' },
    label(t('feed.source.frequency')),
    h('div', { class: draft.freqKind === 'weekly' ? 'fs-freq-stack' : 'fs-freq-row' }, seg, control))
}

/** Right pane for adding a new plugin-backed data source. */
export function newSourceDetail(state: State, handlers: Handlers): HTMLElement {
  const plugins = (state.plugins?.plugins ?? []) as readonly PluginView[]
  const enabledPlugins = plugins.filter((plugin) => plugin.enabled)
  const draft = (state.feed.draft as FeedSourceDraft | null) ?? emptyFeedSourceDraft(enabledPlugins[0]?.name ?? '')
  const busy = Boolean(state.feed.busy)
  const selectedPlugin = plugins.find((plugin) => plugin.name === draft.pluginName) ?? null
  const canCreate = Boolean(!busy && draft.pluginName && draft.instruction.trim())

  const body = !enabledPlugins.length
    ? [
      h('div', { class: 'empty fs-empty' },
        h('p', { text: t('feed.source.plugin.none') }),
        h('button', { class: 'btn btn-accent btn-small', type: 'button', text: t('feed.source.plugin.open'), onClick: () => handlers.openPluginsForFeed() })),
    ]
    : [
      h('form', {
        class: 'fs-form',
        'data-version': 'new',
        onSubmit: (event: Event) => {
          event.preventDefault()
          if (!canCreate) return
          handlers.createFeedSource({
            pluginName: draft.pluginName,
            name: draft.name.trim() || undefined,
            instruction: draft.instruction.trim(),
            schedule: scheduleFromDraft(draft),
          })
        },
      },
      h('div', { class: 'fs-field' },
        label(t('feed.source.plugin')),
        h('select', {
          class: 'field mono',
          name: 'fs-new:plugin',
          disabled: busy,
          onChange: (event: Event) => handlers.updateFeedSourceDraft({ pluginName: (event.target as HTMLSelectElement).value }),
        }, ...plugins.map((plugin) => h('option', {
          value: plugin.name,
          selected: plugin.name === draft.pluginName,
          disabled: !plugin.enabled,
          text: plugin.enabled ? plugin.name : t('feed.source.plugin.disabled', { name: plugin.name }),
        }))),
        selectedPlugin?.description ? h('p', { class: 'help fs-hint', text: selectedPlugin.description }) : null),
      h('div', { class: 'fs-field' },
        label(t('feed.source.name')),
        h('input', {
          class: 'field fs-text-field',
          type: 'text',
          name: 'fs-new:name',
          value: draft.name,
          placeholder: t('feed.source.name.placeholder'),
          disabled: busy,
          onInput: (event: Event) => handlers.updateFeedSourceDraft({ name: (event.target as HTMLInputElement).value }),
        })),
      frequencyField(draft, 'fs-new', busy, handlers),
      h('div', { class: 'fs-field' },
        label(t('feed.source.rule')),
        h('textarea', {
          class: 'field fs-rule',
          name: 'fs-new:rule',
          rows: '5',
          value: draft.instruction,
          placeholder: t('feed.source.rule.placeholder'),
          disabled: busy,
          onInput: (event: Event) => handlers.updateFeedSourceDraft({ instruction: (event.target as HTMLTextAreaElement).value }),
        })),
      state.feed.error ? h('p', { class: 'form-error', role: 'alert', text: state.feed.error }) : null,
      h('div', { class: 'confirm-actions fu-actions' },
        h('button', { class: 'btn btn-accent', type: 'submit', disabled: !canCreate, text: t('feed.source.create') }),
        h('button', { class: 'btn btn-text', type: 'button', disabled: busy, text: t('feed.source.cancel'), onClick: () => handlers.cancelNewFeedSource() }))),
    ]

  return h('div', { class: 'tp-main fu-main' },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: t('feed.source.add.title') })),
    h('div', { class: 'tp-scroll fu-scroll' }, ...body))
}

/** Right pane for viewing, editing, pausing, deleting, or running an existing plugin data source. */
export function sourceDetail(source: FeedSourceView, state: State, handlers: Handlers, now: number): HTMLElement {
  const currentDraft = state.feed.draft as FeedSourceDraft | null
  const draft = currentDraft?.sourceId === source.id ? currentDraft : feedSourceDraftOf(source)
  const busy = Boolean(state.feed.busy)
  const running = state.feed.runningSourceId === source.id
  const paused = source.status === 'paused'
  const pluginErr = source.lastStatus === 'plugin_unavailable'
  const dirty = isSourceDraftDirty(draft, source)
  const canSave = Boolean(!busy && !running && dirty && draft.instruction.trim())

  const standing = pluginErr
    ? t('feed.source.status.plugin.unavailable')
    : paused
      ? `${source.pluginName} · ${t('feed.source.status.paused')}`
      : `${source.pluginName} · ${t('feed.schedule.next.at', { when: whenText(Date.parse(source.nextAt), now) })}`

  return h('div', { class: 'tp-main fu-main' },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: source.name }),
      h('span', { class: 'tp-status mono', 'data-tone': pluginErr ? 'error' : null, text: standing })),
    h('div', { class: 'tp-scroll fu-scroll' },
      h('form', {
        class: 'fs-form',
        'data-version': `${source.id}:${source.updatedAt}`,
        onSubmit: (event: Event) => {
          event.preventDefault()
          if (!canSave) return
          handlers.updateFeedSource(source.id, {
            name: draft.name.trim() || source.pluginName,
            instruction: draft.instruction.trim(),
            schedule: scheduleFromDraft(draft),
          })
        },
      },
      h('p', { class: 'fs-last', 'data-tone': pluginErr || source.lastStatus === 'failed' ? 'error' : null, text: sourceLastSummary(source, now) }),
      h('div', { class: 'fs-field' },
        label(t('feed.source.name')),
        h('input', {
          class: 'field fs-text-field',
          type: 'text',
          name: `fs:${source.id}:name`,
          value: draft.name,
          disabled: busy || running,
          onInput: (event: Event) => handlers.updateFeedSourceDraft({ name: (event.target as HTMLInputElement).value }),
        })),
      frequencyField(draft, `fs:${source.id}`, busy || running, handlers),
      h('div', { class: 'fs-field' },
        label(t('feed.source.rule')),
        h('textarea', {
          class: 'field fs-rule',
          name: `fs:${source.id}:rule`,
          rows: '5',
          value: draft.instruction,
          disabled: busy || running,
          onInput: (event: Event) => handlers.updateFeedSourceDraft({ instruction: (event.target as HTMLTextAreaElement).value }),
        })),
      state.feed.notice ? h('p', { class: 'form-notice', text: state.feed.notice }) : null,
      state.feed.error ? h('p', { class: 'form-error', role: 'alert', text: state.feed.error }) : null,
      h('div', { class: 'fs-actions' },
        h('div', { class: 'confirm-actions fu-actions' },
          h('button', { class: 'btn btn-accent', type: 'submit', disabled: !canSave, text: t('feed.source.save') }),
          h('button', {
            class: 'btn btn-secondary',
            type: 'button',
            disabled: busy || running,
            text: running ? t('feed.source.running') : t('feed.source.run'),
            onClick: () => handlers.runFeedSourceNow(source.id),
          }),
          h('button', {
            class: 'btn btn-text',
            type: 'button',
            disabled: busy || running,
            text: paused ? t('feed.source.resume') : t('feed.source.pause'),
            onClick: () => handlers.pauseFeedSource(source.id, !paused),
          })),
        h('button', {
          class: 'btn btn-text',
          type: 'button',
          disabled: busy || running,
          text: t('feed.source.delete'),
          onClick: () => handlers.deleteFeedSource(source.id),
        })))))
}
