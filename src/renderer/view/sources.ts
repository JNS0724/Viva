import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { formatListTime, formatSize } from '../selectors.ts'
import { h, label } from './dom.ts'

/** The 消息源 part of the state (source-state.ts). */
type Sources = State['sources']
/** A field its viva-source.json declares (source-contract.ts ConfigField), with its key. */
type Field = { key: string, type: string, title: string, help?: string, required?: boolean, values?: readonly string[], default?: unknown }
/** A source as settings sees it (sources-ipc.ts sourceView): no secret values, only which are saved. */
type Source = {
  id: string, name: string, kind: string, reads: string, command: string, fields: readonly Field[], running: boolean,
  settings: { enabled: boolean, everyMinutes: number, values: Readonly<Record<string, unknown>>, savedSecrets: readonly string[], missing: readonly string[] },
  health: { lastOkAt: number | null, lastReceivedAt: number | null, lastError: string | null, lastErrorAt: number | null, failures: number, dropped: readonly string[], count: number },
  latest: ReadonlyArray<{ id: string, at: number, from: string, title: string }>,
}

/** A folder chosen to install (sources-ipc.ts pendingView). */
type Pending = { id: string, name: string, kind: string, reads: string, command: string, fields: readonly string[], from: string, files: number, bytes: number, replaces: boolean }

let KIND_LABEL: Readonly<Record<string, string>> = { mail: t("sources.email"), alert: t("sources.alerts"), chat: t("sources.messaging"), other: t("sources.other") }
let SOURCE_DOCS_HINT = t("sources.sources.deliver.new.email.alerts.and.messages")
  + t("sources.click.install.source.and.choose.a.folder")
let TRUST_WARNING = t("sources.source.programs.run.with.your.permissions.and")

const smallButton = (text: string, extra: Record<string, unknown>) => h('button', { class: 'btn btn-outline btn-small', type: 'button', text, ...extra })

/** One line on how the source is doing: off, failing, or when it last read and how much it has. */
function statusLine(source: Source) {
  const { settings, health } = source
  if (!settings.enabled) return { tone: 'off', text: settings.missing.length ? t("sources.disabled.still.needed", { value1: settings.missing.join('、') }) : t("sources.disabled") }
  if (source.running) return { tone: 'ok', text: t("sources.fetching") }
  if (health.lastError) return { tone: 'off', text: t("sources.error", { lastError: health.lastError, value2: health.failures > 1 ? t("sources.consecutive.failures.retrying.later", { failures: health.failures }) : '' }) }
  const last = health.lastOkAt ? t("sources.last", { value1: formatListTime(health.lastOkAt) }) : ''
  return { tone: 'ok', text: t("sources.every.minutes.messages.stored", { everyMinutes: settings.everyMinutes, last: last, count: health.count }) }
}

function latestList(source: Source) {
  if (!source.settings.enabled || !source.latest.length) return null
  return h('ul', { class: 'source-latest', 'aria-label': t("sources.recently.received.by", { name: source.name }) },
    source.latest.map((m) => h('li', null,
      h('span', { class: 'source-latest-time mono', text: formatListTime(m.at) }),
      m.from ? h('span', { class: 'source-latest-from', text: m.from }) : null,
      h('span', { class: 'source-latest-title ellipsis', title: m.title, text: m.title }))))
}

function sourceItem(source: Source, sources: Sources, handlers: Handlers) {
  const status = statusLine(source)
  const busy = sources.busy !== null
  return h('li', { class: 'ext-item source-item', 'data-id': source.id },
    h('div', { class: 'ext-copy' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name', text: source.name }),
        h('span', { class: 'badge', text: KIND_LABEL[source.kind] ?? source.kind }),
        h('span', { class: 'ext-status', 'data-tone': status.tone, text: status.text })),
      h('span', { class: 'ext-detail', text: t("sources.will.read", { reads: source.reads }) }),
      source.health.dropped.length ? h('span', { class: 'ext-detail', text: t("sources.malformed.messages.were.rejected.last.time", { length: source.health.dropped.length, value2: source.health.dropped[0] }) }) : null,
      latestList(source)),
    h('div', { class: 'ext-actions' },
      source.settings.enabled ? smallButton(sources.busy === source.id ? t("sources.fetching.2") : t("sources.fetch.now"), {
        disabled: busy || source.running, 'aria-label': t("sources.fetch.now.2", { name: source.name }), onClick: () => handlers.pollSourceNow(source.id),
      }) : null,
      smallButton(t("settings.settings"), { disabled: busy, 'aria-label': t("sources.configure.source", { name: source.name }), onClick: () => handlers.editSource(source.id) }),
      smallButton(t("extensions.remove"), { disabled: busy || source.running, 'aria-label': t("sources.remove.source", { name: source.name }), onClick: () => handlers.removeSource(source.id, source.name) }),
      h('input', {
        // Unnamed, so a re-render shows whether it is on rather than what was last clicked (a refused switch-on).
        type: 'checkbox', class: 'switch source-switch', checked: source.settings.enabled, disabled: busy, 'aria-label': t("sources.enable.source", { name: source.name }),
        onChange: (event: Event) => handlers.toggleSource(source.id, (event.target as HTMLInputElement).checked),
      })))
}

/** The input for one declared field; a secret shows whether it is saved and is never filled in. */
function fieldInput(field: Field, source: Source, version: string) {
  const name = `source-field-${field.key}`
  const value = source.settings.values[field.key] ?? field.default
  const common = { name, 'data-version': version, 'aria-label': field.title }
  switch (field.type) {
    case 'boolean':
      return h('input', { ...common, type: 'checkbox', class: 'switch', checked: value === true })
    case 'enum':
      return h('select', { ...common, class: 'field' },
        (field.values ?? []).map((option) => h('option', { value: option, selected: option === value, text: option })))
    case 'secret': {
      const saved = source.settings.savedSecrets.includes(field.key)
      return h('input', { ...common, type: 'password', class: 'field', autocomplete: 'off', spellcheck: 'false', placeholder: saved ? t("extensions.leave.unchanged.encrypted.enter.a.value.to") : '' })
    }
    case 'number':
      return h('input', { ...common, type: 'number', class: 'field', value: value === undefined ? '' : String(value) })
    default:
      return h('input', { ...common, type: 'text', class: 'field mono', autocomplete: 'off', spellcheck: 'false', value: value === undefined ? '' : String(value) })
  }
}

/** What the form holds, as the main process takes it: numbers as numbers, checkboxes as true or false. */
function formValues(form: HTMLFormElement, source: Source) {
  const data = new FormData(form)
  const values: Record<string, unknown> = {}
  for (const field of source.fields) {
    const raw = data.get(`source-field-${field.key}`)
    if (field.type === 'boolean') values[field.key] = raw === 'on'
    else if (typeof raw !== 'string') continue
    else if (field.type === 'number') values[field.key] = raw.trim() === '' ? undefined : Number(raw)
    else values[field.key] = raw
  }
  const every = Number(data.get('source-every'))
  return { everyMinutes: Number.isFinite(every) && every > 0 ? every : undefined, values }
}

const formRow = (title: string, field: HTMLElement, help?: string) =>
  h('div', { class: 'ext-edit-row' }, label(title), h('div', { class: 'source-field' }, field, help ? h('span', { class: 'help', text: help }) : null))

function checkLine(sources: Sources, source: Source) {
  const check = sources.check
  if (!check || check.id !== source.id) return null
  return check.ok
    ? h('p', { class: 'form-notice', role: 'status', text: t("sources.connection.successful") })
    : h('p', { class: 'form-error', role: 'alert', text: t("sources.could.not.connect", { problem: check.problem }) })
}

/** The source's settings in place: every field its viva-source.json declares, and how often to read. */
function editItem(source: Source, sources: Sources, handlers: Handlers) {
  const version = `${source.id}:${source.settings.savedSecrets.join(',')}`
  const busy = sources.busy !== null
  const form = h('form', {
    class: 'ext-edit', 'aria-label': t("sources.configure.source", { name: source.name }),
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.saveSource(source.id, formValues(event.currentTarget as HTMLFormElement, source))
    },
  },
  h('div', { class: 'ext-edit-head' }, h('span', { class: 'ext-name', text: t("sources.configure", { name: source.name }) })),
  source.fields.map((field) => formRow(field.required ? `${field.title} *` : field.title, fieldInput(field, source, version), field.help)),
  formRow(t("sources.fetch.interval"), h('input', {
    class: 'field', type: 'number', name: 'source-every', min: 1, max: 1440, step: 1, 'data-version': version,
    value: String(source.settings.everyMinutes), 'aria-label': t("sources.fetch.interval.minutes"),
  }), t("sources.minutes")),
  h('p', { class: 'ext-detail mono ellipsis', title: source.command, text: t("sources.runs", { command: source.command }) }),
  checkLine(sources, source),
  h('div', { class: 'ext-edit-foot' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: busy, text: sources.busy === source.id ? t("extensions.working") : t("extensions.save") }),
    smallButton(t("sources.test.connection"), { disabled: busy, onClick: () => handlers.checkSource(source.id, formValues(form, source)) }),
    smallButton(t("extensions.cancel"), { onClick: () => handlers.cancelSourceEdit() }),
    h('p', { class: 'help', text: t("sources.credentials.are.encrypted.on.this.computer.the") })))
  return h('li', { class: 'ext-item', 'data-id': source.id, 'data-editing': 'true' }, form)
}

/** The chosen folder, shown for a yes: who it is, what it runs and reads, what it will ask for. */
function pendingCard(pending: Pending, sources: Sources, handlers: Handlers) {
  const busy = sources.busy !== null
  const row = (title: string, text: string, mono = false) => h('div', { class: 'ext-edit-row' }, label(title), h('span', { class: mono ? 'ext-detail mono' : 'ext-detail', text }))
  return h('div', { class: 'ext-edit source-pending', role: 'group', 'aria-label': t("sources.install.source", { name: pending.name }) },
    h('div', { class: 'ext-edit-head' },
      h('span', { class: 'ext-name', text: pending.replaces ? t("sources.update", { name: pending.name }) : t("sources.install", { name: pending.name }) }),
      h('span', { class: 'badge', text: KIND_LABEL[pending.kind] ?? pending.kind })),
    row(t("followups.will.read"), pending.reads),
    row(t("sources.will.run"), pending.command, true),
    row(t("sources.required.fields"), pending.fields.length ? pending.fields.join('、') : t("sources.no.fields.required")),
    row(t("sources.from"), t("sources.files", { from: pending.from, files: pending.files, value3: formatSize(pending.bytes) }), true),
    h('p', { class: 'form-error', text: pending.replaces ? t("sources.this.replaces.the.installed.source.with.the", { TRUST_WARNING: TRUST_WARNING }) : TRUST_WARNING }),
    h('div', { class: 'ext-edit-foot' },
      h('button', { class: 'btn btn-accent btn-small', type: 'button', disabled: busy, text: pending.replaces ? t("sources.update.2") : t("sources.install.2"), onClick: () => handlers.installSource() }),
      smallButton(t("extensions.cancel"), { disabled: busy, onClick: () => handlers.cancelSourceInstall() })))
}

function brokenItem(broken: { name: string, problem: string }) {
  return h('li', { class: 'ext-item' }, h('div', { class: 'ext-copy' },
    h('div', { class: 'ext-title' }, h('span', { class: 'ext-name mono', text: broken.name }), h('span', { class: 'ext-status', 'data-tone': 'off', text: t("sources.unavailable") })),
    h('span', { class: 'ext-detail', text: broken.problem })))
}

/** The 消息源 part of settings: the sources in the sources folder, each switched on, set up and watched here. */
export function sourcesSection(sources: Sources, handlers: Handlers) {
  if (!sources.loaded) return h('section', { class: 'ext' }, label(t("sources.sources")), h('p', { class: 'help', text: t("extensions.loading") }))
  const item = (source: Source) => (sources.editing === source.id ? editItem(source, sources, handlers) : sourceItem(source, sources, handlers))
  return h('section', { class: 'ext', 'aria-label': t("sources.sources") },
    label(t("sources.sources")),
    h('p', { class: 'help source-hint', text: SOURCE_DOCS_HINT }),
    sources.pending ? pendingCard(sources.pending, sources, handlers) : null,
    sources.sources.length
      ? h('ul', { class: 'ext-list' }, sources.sources.map(item))
      : h('p', { class: 'help', text: t("sources.no.sources.yet") }),
    sources.broken.length ? h('ul', { class: 'ext-list', 'aria-label': t("sources.unavailable.sources") }, sources.broken.map(brokenItem)) : null,
    h('div', { class: 'source-folder' },
      h('span', { class: 'help mono ellipsis', title: sources.folder, text: sources.folder }),
      smallButton(t("sources.install.source.2"), { disabled: sources.busy !== null, onClick: () => handlers.chooseSource() }),
      smallButton(t("settings.open.folder"), { onClick: () => handlers.openSourcesFolder() }),
      smallButton(t("sources.refresh"), { disabled: sources.busy !== null, onClick: () => handlers.loadSources() })),
    sources.error ? h('p', { class: 'form-error', role: 'alert', text: sources.error }) : null,
    sources.notice ? h('p', { class: 'form-notice', role: 'status', text: sources.notice }) : null)
}

onLocaleChange(() => {
  KIND_LABEL = { mail: t("sources.email"), alert: t("sources.alerts"), chat: t("sources.messaging"), other: t("sources.other") }
  SOURCE_DOCS_HINT = t("sources.sources.deliver.new.email.alerts.and.messages")
  + t("sources.click.install.source.and.choose.a.folder")
  TRUST_WARNING = t("sources.source.programs.run.with.your.permissions.and")
})
