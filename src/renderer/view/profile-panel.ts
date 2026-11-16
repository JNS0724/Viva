import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { PROFILE_FIELDS } from '../../shared/profile-fields.ts'
import { formatListTime } from '../selectors.ts'
import { formatDate } from '../../shared/i18n/format.ts'
import { timelinePlace } from '../timeline-search.ts'
import { h, keepingInput, label } from './dom.ts'
import { icon } from './icons.ts'
import { memoryFilesSection } from './memory-files-panel.ts'
import type { MemoryChangeRecord, MemorySummaryView } from '../../shared/ipc-results.ts'

/** The 关于你 page's part of the state (personal-state.ts). */
type MemoryPage = State['memory']
/** A field of the profile the user fills in (shared/profile-fields.ts). */
type ProfileField = { key: string, label: string, hint: string }
/** A memory as the page lists it (main/memory-store.ts). */
type MemoryRow = {
  id: number, revision: number, scope?: { kind: 'user' | 'conversation' | 'task' | 'project' },
  evidence?: ReadonlyArray<{ link?: string | null }>, state?: string, retention?: string, text: string, kind: string, source: string, createdAt: number, keywords?: readonly string[],
  invalidAt?: number, supersededBy?: number | null, invalidatedBy?: string | null,
  validFrom?: number | null, validTo?: number | null,
  pendingRelation?: boolean,
  links?: ReadonlyArray<MemoryLink>,
}
type MemoryInterval = { from: number | null, to: number | null }
type MemoryLink = { id: number, kind: string, incoming: boolean, changeId?: number, windows?: readonly MemoryInterval[] }
type IntroItem = { key: string, label: string, hint: string, multiline: boolean }

let KIND_LABEL: Readonly<Record<string, string>> = { fact: t("profile-panel.fact"), preference: t("profile-panel.preference"), person: t("profile-panel.person"), project: t("profile-panel.project"), role: t("profile-panel.role") }
let SOURCE_LABEL: Readonly<Record<string, string>> = { user: t("profile-panel.added.by.you"), agent: t("profile-panel.remembered.by.assistant") }
let INTRO_ITEMS: readonly IntroItem[] = [
  { key: 'role', label: t("profile-panel.your.work"), hint: t("profile-panel.for.example.backend.lead.for.payments.responsible"), multiline: false },
  { key: 'projects', label: t("profile-panel.current.projects"), hint: t("profile-panel.for.example.q.reconciliation.system.redesign"), multiline: false },
  { key: 'preferences', label: t("profile-panel.preferences.and.habits"), hint: t("profile-panel.for.example.lead.with.the.conclusion.compare"), multiline: false },
  { key: 'sources', label: t("profile-panel.websites.read.once.by.the.assistant"), hint: t("profile-panel.one.url.per.line.such.as.an"), multiline: true },
]

function fieldEditor(field: ProfileField, entry: { value: string } | undefined, memory: MemoryPage, handlers: Handlers) {
  const input = h('textarea', {
    class: 'field profile-input', name: `field-${field.key}`, 'data-version': field.key, rows: 3,
    'aria-label': field.label, placeholder: field.hint, maxlength: 1000,
  })
  input.value = entry?.value ?? ''
  return h('form', {
    class: 'profile-edit',
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.saveField(field.key, input.value)
    },
  },
  input,
  h('div', { class: 'profile-edit-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: memory.busy, text: t("extensions.save") }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t("extensions.cancel"), onClick: () => handlers.editField(null) })))
}

function fieldCard(field: ProfileField, memory: MemoryPage, handlers: Handlers) {
  const entry = memory.profile[field.key]
  const editing = memory.editing === field.key
  return h('div', { class: 'profile-field', 'data-filled': String(Boolean(entry)), 'data-field': field.key },
    h('div', { class: 'profile-field-head' },
      label(field.label),
      editing ? null : h('button', {
        class: 'link-btn', type: 'button', text: entry ? t("extensions.edit") : t("profile-panel.fill.in"), 'aria-label': t("profile-panel.edit", { label: field.label }),
        onClick: () => handlers.editField(field.key),
      })),
    editing
      ? fieldEditor(field, entry, memory, handlers)
      : h('p', { class: 'profile-value', text: entry?.value ?? field.hint }))
}

/** Once there is something to say: it goes along with each conversation, so it is shown here too. */
const habitsRow = (habits: { text?: string, samples?: number }) => (habits.text
  ? h('p', { class: 'help', text: t("profile-panel.usage.habits.based.on.your.last.questions", { samples: habits.samples ?? 0, text: habits.text }) })
  : null)

function memoryMeta(memory: MemoryRow, now: number) {
  const keywords = memory.keywords?.length ? t("profile-panel.keywords", { value1: memory.keywords.join('、') }) : ''
  const scope = memory.scope ? t(`profile-panel.memory.scope.${memory.scope.kind}`) : ''
  return [t('profile-panel.memory.revision', { id: memory.id }), scope, KIND_LABEL[memory.kind], SOURCE_LABEL[memory.source], formatListTime(memory.createdAt, now), keywords].filter(Boolean).join(' · ')
}

function memorySource(memory: MemoryRow, handlers: Handlers) {
  const source = memory.evidence?.find(edge => edge.link)?.link
  return source ? h('button', { class: 'link-btn', type: 'button', text: t('profile-panel.memory.source'),
    onClick: () => { handlers.closeProfile(); handlers.openLink(source) } }) : null
}

function memoryDelete(memory: MemoryRow, handlers: Handlers, disabled = false) {
  return h('button', { class: 'link-btn', type: 'button', 'data-tone': 'danger', disabled,
    text: t('extensions.delete'), 'aria-label': t('profile-panel.delete.memory', { text: memory.text }),
    onClick: () => handlers.deleteMemory(memory) })
}

function memoryItem(memory: MemoryRow, editRevision: number | null, handlers: Handlers, now: number) {
  const editing = editRevision !== null
  const editor = h('input', { class: 'field', name: `memory-${memory.id}`, value: memory.text, maxlength: 500, 'aria-label': t('extensions.edit') })
  const form = editing ? h('form', { class: 'profile-edit', onSubmit: (event: SubmitEvent) => {
    event.preventDefault()
    handlers.editMemory({ id: memory.id, revision: editRevision }, editor.value)
  } }, editor, h('button', { class: 'btn btn-outline btn-small', type: 'submit', text: t('extensions.save') })) : null
  return h('li', { class: 'memory-item', 'data-source': memory.source },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-text', text: memory.text }),
      h('span', { class: 'memory-meta mono', text: memoryMeta(memory, now) }),
      form,
      h('div', { class: 'memory-actions' },
        memorySource(memory, handlers),
        h('button', { class: 'link-btn', type: 'button', 'aria-expanded': String(editing), text: t(editing ? 'extensions.cancel' : 'extensions.edit'),
          onClick: () => handlers.editMemoryEntry(editing ? null : { id: memory.id, revision: memory.revision }) }),
        h('button', { class: 'link-btn', type: 'button', text: t('profile-panel.forget.memory'), onClick: () => handlers.forgetMemory(memory) }),
        memoryDelete(memory, handlers))))
}

function invalidReason(memory: MemoryRow, now: number) {
  if (memory.retention === 'forgotten') return t('profile-panel.forgotten.at.your.request', { when: formatListTime(memory.invalidAt ?? now, now) })
  if (memory.state === 'disputed') return t('profile-panel.memory.disputed')
  if (memory.pendingRelation) return t('profile-panel.memory.pending.relation')
  const boundary = memory.validTo ?? memory.invalidAt ?? now
  const when = formatDate(boundary, { dateStyle: 'medium' })
  if (memory.validFrom != null && memory.validFrom > now) return t('profile-panel.memory.starts', { when: formatDate(memory.validFrom, { dateStyle: 'medium' }) })
  const replacing = memory.links?.find(link => link.incoming && link.kind === 'corrects')
  if (replacing) return t('profile-panel.memory.corrected', { id: replacing.id })
  if (memory.state === 'superseded' || memory.validTo != null && memory.validTo <= now) return t('profile-panel.memory.ended', { when })
  if (memory.state === 'retracted') return t('profile-panel.memory.retracted')
  if (memory.supersededBy) return t("profile-panel.replaced.by.a.newer.memory", { when: when })
  return memory.invalidatedBy === 'user' ? t("profile-panel.forgotten.at.your.request", { when: when }) : t("profile-panel.considered.outdated.by.the.assistant", { when: when })
}

function invalidItem(memory: MemoryRow, handlers: Handlers, now: number) {
  const withdrawn = memory.retention === 'forgotten' || memory.state === 'retracted'
  return h('li', { class: 'memory-item', 'data-invalid': String(withdrawn) },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-text', text: memory.text }),
      h('span', { class: 'memory-meta mono', text: invalidReason(memory, now) }),
      h('div', { class: 'memory-actions' },
        memorySource(memory, handlers),
        memory.retention === 'forgotten' && (memory.state === 'active' || memory.state === 'superseded') ? h('button', {
          class: 'btn btn-outline btn-small', type: 'button', text: t('profile-panel.restore'), 'aria-label': t('profile-panel.restore.memory', { text: memory.text }),
          onClick: () => handlers.reviveMemory(memory),
        }) : null,
        memoryDelete(memory, handlers))))
}

const memoryTime = (time: number) => formatDate(time, { dateStyle: 'medium', timeStyle: 'short' })

function memoryPeriod({ from, to }: { from?: number | null, to?: number | null }) {
  if (from != null && to != null) return t('profile-panel.memory.conflict.period', { from: memoryTime(from), to: memoryTime(to) })
  if (from != null) return t('profile-panel.memory.starts', { when: memoryTime(from) })
  if (to != null) return t('profile-panel.memory.ended', { when: memoryTime(to) })
  return ''
}

function conflictPair(first: MemoryRow, second: MemoryRow, changeId: number, interval: MemoryInterval, memory: MemoryPage, handlers: Handlers, now: number) {
  const key = `${changeId}-${first.revision}-${second.revision}-${interval.from}-${interval.to}`
  const period = memoryPeriod(interval)
  const editing = memory.conflictEditor === key
  const choices = [[first, second], [second, first]] as const
  const option = ([selected, other]: typeof choices[number]) =>
    h('li', { class: 'memory-item', 'data-memory-id': selected.id },
      h('div', { class: 'memory-copy' },
        h('span', { class: 'memory-text', text: selected.text }),
        h('span', { class: 'memory-meta mono', text: memoryMeta(selected, now) }),
        h('div', { class: 'memory-actions' },
          memorySource(selected, handlers),
          h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: memory.changeBusy,
            'aria-label': t('profile-panel.memory.resolve.label', { id: selected.id }), text: t('profile-panel.memory.resolve'),
            onClick: () => handlers.resolveMemoryConflictPair(selected, other, { kind: 'keep-first' }, changeId, interval) }),
          memoryDelete(selected, handlers, memory.changeBusy))))
  const replacement = h('input', { class: 'field', name: `conflict-${key}`, maxlength: 500, required: true,
    'aria-label': t('profile-panel.memory.conflict.replacement'), placeholder: t('profile-panel.memory.conflict.replacement') })
  const form = editing ? h('form', { class: 'profile-edit', onSubmit: (event: SubmitEvent) => {
    event.preventDefault()
    const text = replacement.value.trim()
    if (text) handlers.resolveMemoryConflictPair(first, second, { kind: 'replace', text }, changeId, interval)
  } }, replacement,
  h('div', { class: 'profile-edit-actions' },
    h('button', { class: 'btn btn-outline btn-small', type: 'submit', disabled: memory.changeBusy, text: t('extensions.save') }))) : null
  return h('li', { class: 'memory-item', 'data-memory-conflict': key },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-text', text: t('profile-panel.memory.disputed') }),
      period ? h('span', { class: 'memory-meta mono', text: period }) : null,
      h('ul', { class: 'memory-list' }, choices.map(option)),
      h('div', { class: 'profile-edit-actions' },
        h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: memory.changeBusy,
          text: t('profile-panel.memory.conflict.both'), onClick: () => handlers.resolveMemoryConflictPair(first, second, { kind: 'keep-both' }, changeId, interval) }),
        h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: memory.changeBusy,
          text: t('profile-panel.memory.conflict.neither'), onClick: () => handlers.resolveMemoryConflictPair(first, second, { kind: 'discard-both' }, changeId, interval) }),
        h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: memory.changeBusy, 'aria-expanded': String(editing),
          text: t(editing ? 'extensions.cancel' : 'profile-panel.memory.conflict.replacement'),
          onClick: () => handlers.editMemoryConflict(editing ? null : key) })),
      form))
}

/** Review disputes and memories that fall outside the current selection. */
function invalidSection(memory: MemoryPage, handlers: Handlers, now: number) {
  const rows = new Map<number, MemoryRow>(memory.invalidItems.map((item: MemoryRow) => [item.id, item]))
  const paired = new Set<number>()
  const conflicts: HTMLElement[] = []
  for (const first of rows.values()) {
    if (first.state !== 'disputed') continue
    for (const link of first.links ?? []) {
      if (link.kind !== 'conflict' || link.changeId === undefined || first.id >= link.id) continue
      const second = rows.get(link.id)
      if (second?.state !== 'disputed' || !link.windows?.length) continue
      paired.add(first.id).add(second.id)
      for (const interval of link.windows) conflicts.push(conflictPair(first, second, link.changeId, interval, memory, handlers, now))
    }
  }
  return h('div', { class: 'memory-invalid' },
    h('button', {
      class: 'link-btn', type: 'button', name: 'memory-invalid', 'aria-expanded': String(memory.invalidOpen), 'aria-controls': 'memory-invalid-list',
      text: memory.invalidOpen ? t('profile-panel.hide.inactive.memories') : memory.invalid > 0
        ? t('profile-panel.inactive', { invalid: memory.invalid }) : t('profile-panel.memory.other'),
      onClick: handlers.toggleInvalid,
    }),
    h('ul', { class: 'memory-list', id: 'memory-invalid-list', hidden: !memory.invalidOpen || rows.size === 0 },
      [...conflicts, ...[...rows.values()].filter(item => !paired.has(item.id)).map(item => invalidItem(item, handlers, now))]),
    memory.invalidOpen && memory.invalidLoaded && rows.size === 0 ? h('p', { class: 'help', text: t('profile-panel.memory.other.empty') }) : null)
}

function memoryChangeItem(change: MemoryChangeRecord, busy: boolean, handlers: Handlers) {
  const status = change.status === 'applied' ? '' : t(`profile-panel.memory.changes.${change.status}`)
  const period = memoryPeriod(change)
  const boundary = change.effectiveAt == null ? '' : t(change.kind === 'end' ? 'profile-panel.memory.ended' : 'profile-panel.memory.starts',
    { when: memoryTime(change.effectiveAt) })
  const scope = change.scope ? t(`profile-panel.memory.scope.${change.scope.kind}`) : ''
  const meta = [t(`profile-panel.memory.changes.${change.kind}`), scope, memoryTime(change.createdAt), period || boundary, status].filter(Boolean).join(' · ')
  const detail = (title: string, text: string | null) => text == null ? null : h('div', { class: 'memory-copy' },
    label(title), h('span', { class: 'memory-text', text }))
  return h('li', { class: 'memory-item', 'data-memory-change': change.id, 'data-status': change.status },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-meta mono', text: meta }),
      detail(t('profile-panel.memory.changes.before'), change.before),
      detail(t('profile-panel.memory.changes.after'), change.after),
      change.evidence.length ? h('div', { class: 'memory-copy' },
        change.evidence.some(edge => edge.text) ? label(t('profile-panel.memory.changes.evidence')) : null,
        change.evidence.filter(edge => edge.text).map(edge => h('span', { class: 'memory-text', text: edge.text })),
        [...new Set(change.evidence.flatMap(edge => edge.link ? [edge.link] : []))].map(link =>
          h('button', { class: 'link-btn', type: 'button', text: t('profile-panel.memory.source'),
            onClick: () => { handlers.closeProfile(); handlers.openLink(link) } }))) : null),
    change.status === 'applied' ? h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: busy,
      text: t('profile-panel.memory.changes.undo'), onClick: () => handlers.undoMemoryChange(change) }) : null)
}

function memoryChangesSection(memory: MemoryPage, handlers: Handlers) {
  return h('div', { class: 'memory-invalid' },
    h('button', { class: 'link-btn', type: 'button', name: 'memory-changes', 'aria-expanded': String(memory.changesOpen),
      'aria-controls': 'memory-changes-list',
      text: t('profile-panel.memory.changes'), onClick: handlers.toggleMemoryChanges }),
    h('ul', { class: 'memory-list', id: 'memory-changes-list', hidden: !memory.changesOpen || !memory.changes.length },
      memory.changes.map(change => memoryChangeItem(change, memory.changeBusy, handlers))),
    memory.changesOpen && memory.changesLoaded && memory.changes.length === 0
      ? h('p', { class: 'help', text: t('profile-panel.memory.changes.empty') }) : null)
}

function memoriesSection(memory: MemoryPage, handlers: Handlers, now: number) {
  const addInput = h('input', {
    class: 'field', name: 'memory-new', 'data-version': String(memory.lastAdded ?? ''), maxlength: 500,
    placeholder: t("profile-panel.what.should.the.assistant.remember.for.example"), 'aria-label': t("profile-panel.add.a.memory"),
  })
  const search = h('input', {
    class: 'field', name: 'memory-search', type: 'search', value: memory.query, placeholder: t("profile-panel.search.memories"), 'aria-label': t("profile-panel.search.memories.2"),
    onInput: () => handlers.searchMemories(search.value),
  })
  const searching = memory.query.trim() !== ''
  const empty = searching
    ? t("profile-panel.no.memories.contain", { value1: memory.query.trim() })
    : t("profile-panel.no.memories.yet.the.assistant.remembers.important")
  return h('section', { class: 'profile-section' },
    h('div', { class: 'row-between' }, h('h3', { class: 'profile-heading', text: t("profile-panel.memories", { total: memory.total }) }), search),
    h('form', {
      class: 'field-row',
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault()
        if (await handlers.addMemory(addInput.value)) addInput.value = ''
      },
    }, addInput, h('button', { class: 'btn btn-outline btn-field', type: 'submit', disabled: memory.busy, text: t("models.add") })),
    memory.items.length
      ? h('ul', { class: 'memory-list' }, memory.items.map((item: MemoryRow) =>
        memoryItem(item, memory.editingMemory?.id === item.id ? memory.editingMemory.revision : null, handlers, now)))
      : h('p', { class: 'empty', text: empty }),
    memory.cleanupPending > 0 ? h('p', { class: 'help', role: 'status',
      text: t('profile-panel.memory.cleanup.pending', { count: memory.cleanupPending }) }) : null,
    invalidSection(memory, handlers, now),
    memoryChangesSection(memory, handlers),
    h('div', { class: 'memory-invalid' },
      h('button', { class: 'link-btn', type: 'button', name: 'memory-rebuild-indexes', disabled: memory.rebuildingIndexes,
        text: t(memory.rebuildingIndexes ? 'profile-panel.memory.index.rebuilding' : 'profile-panel.memory.index.rebuild'),
        onClick: handlers.rebuildMemoryIndexes })))
}

function summarySection(scope: 'user' | 'project', summary: MemorySummaryView | null, handlers: Handlers) {
  if (!summary?.items.length) return null
  return h('section', { class: 'profile-section', 'aria-labelledby': `profile-summary-${scope}`, 'data-profile-summary': scope },
    h('h3', { class: 'profile-heading', id: `profile-summary-${scope}`, text: t(`profile-panel.summary.${scope}`) }),
    summary.generated ? null : h('p', { class: 'help', text: t('profile-panel.summary.fallback') }),
    h('ul', { class: 'memory-list' }, summary.items.map(({ id, text, source }) => {
      const link = source?.link
      return h('li', { class: 'memory-item', 'data-memory-id': id },
        h('div', { class: 'memory-copy' },
          h('span', { class: 'memory-text', text }),
          h('span', { class: 'memory-meta', text: t('profile-panel.memory.revision', { id }) }),
          source?.text && source.text !== text ? h('p', { class: 'help', text: source.text }) : null),
        link && timelinePlace(link) ? h('button', { class: 'link-btn', type: 'button', text: t('profile-panel.memory.source'),
          'aria-label': t('profile-panel.summary.source', { id }), onClick: () => { handlers.closeProfile(); handlers.openLink(link) } }) : null)
    })))
}

function memoryLoadError(memory: MemoryPage, handlers: Handlers) {
  return memory.loadError ? h('div', { class: 'profile-section' },
    h('p', { class: 'form-error', role: 'alert', text: memory.loadError }),
    h('div', { class: 'memory-actions' }, h('button', { class: 'link-btn', type: 'button',
      text: t('memory-files.retry'), onClick: handlers.loadMemory }))) : null
}

function profileView(memory: MemoryPage, handlers: Handlers, now: number): View[] {
  return [
    h('h2', { class: 'settings-title', id: 'profile-title', text: t("profile-panel.about.you") }),
    h('p', { class: 'help', text: t(memory.fileMode ? 'memory-files.intro' : 'profile-panel.everything.the.assistant.knows.about.you.is') }),
    memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
    h('section', { class: 'profile-section' },
      h('h3', { class: 'profile-heading', text: t("profile-panel.your.profile") }),
      h('div', { class: 'profile-grid' }, PROFILE_FIELDS.map((field) => fieldCard(field, memory, handlers))),
      habitsRow(memory.habits)),
    memory.summaries ? summarySection('user', memory.summaries.user, handlers) : null,
    memory.summaries ? summarySection('project', memory.summaries.project, handlers) : null,
    memory.loadError ? memoryLoadError(memory, handlers)
      : !memory.loaded ? h('p', { class: 'help', role: 'status', text: t('memory-files.loading') })
      : memory.fileMode ? memoryFilesSection(memory, handlers) : memoriesSection(memory, handlers, now),
  ]
}

function introInput(item: IntroItem, value: string | undefined) {
  const props = { class: 'field', name: `intro-${item.key}`, placeholder: item.hint, 'aria-label': item.label }
  const input = item.multiline ? h('textarea', { ...props, rows: 3 }) : h('input', props)
  input.value = value ?? ''
  return h('label', { class: 'intro-item' }, label(item.label), input)
}

function introValues(form: HTMLFormElement) {
  const value = (key: string) => (form.elements.namedItem(`intro-${key}`) as HTMLInputElement | null)?.value ?? ''
  return { role: value('role'), projects: value('projects'), preferences: value('preferences'), sources: value('sources') }
}

function introView(memory: MemoryPage, handlers: Handlers): View[] {
  const current = (key: string) => memory.profile[key]?.value ?? ''
  const docs = memory.docs.length
    ? h('ul', { class: 'doc-chips' }, memory.docs.map((doc: { path: string, name: string }) => h('li', { class: 'chip', title: doc.path }, icon('file', 14), doc.name)))
    : null
  const form = h('form', {
    class: 'intro-form',
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.finishIntro(introValues(form), (form.elements.namedItem('intro-analyze') as HTMLInputElement).checked)
    },
  },
  ...INTRO_ITEMS.map((item) => introInput(item, current(item.key))),
  h('div', { class: 'intro-docs' },
    h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: memory.busy, onClick: handlers.addDocs }, t("profile-panel.add.reference.documents")),
    h('span', { class: 'help', text: t("profile-panel.copies.them.into.the.workspace.reference.folder") })),
  docs,
  h('label', { class: 'intro-check' },
    h('input', { type: 'checkbox', name: 'intro-analyze', checked: true }),
    h('span', { text: t("profile-panel.after.saving.ask.the.assistant.to.read") })),
  memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-accent', type: 'submit', disabled: memory.busy, text: memory.busy ? t("extensions.saving") : t("extensions.save") }),
    h('button', { class: 'btn btn-outline btn-field', type: 'button', text: t("home.maybe.later"), onClick: handlers.skipIntro })))
  return [
    h('h2', { class: 'settings-title', id: 'profile-title', text: t("profile-panel.let.me.get.to.know.you") }),
    h('p', { class: 'help', text: t("profile-panel.every.field.is.optional.edit.them.anytime") }),
    memoryLoadError(memory, handlers),
    form,
  ]
}

/** The 关于你 page (view/hub.js), or the intro form in its place. Rebuilt only when its slice changes; typed text survives. */
export function renderProfilePanel(container: HTMLElement, memory: MemoryPage, handlers: Handlers, now = Date.now()) {
  if (!memory.open) {
    container.replaceChildren()
    return
  }
  const shownView = container.querySelector<HTMLElement>('.profile')?.dataset.view ?? null
  const shownFiles = container.querySelector<HTMLElement>('[data-memory-files-view]')?.dataset.memoryFilesView
  keepingInput(container, () => container.replaceChildren(
    h('section', { class: 'settings profile', 'aria-labelledby': 'profile-title', 'data-view': memory.view },
      ...(memory.view === 'intro' ? introView(memory, handlers) : profileView(memory, handlers, now)).filter(Boolean))))
  if (shownView !== 'intro' && memory.view === 'intro') container.querySelector<HTMLElement>('[name="intro-role"]')?.focus()
  const nextFiles = container.querySelector<HTMLElement>('[data-memory-files-view]')?.dataset.memoryFilesView
  if (shownFiles && nextFiles && shownFiles !== nextFiles) {
    container.querySelector<HTMLElement>(nextFiles === 'detail' ? '[name="memory-file-back"]' : '[name="memory-files-search"]')?.focus()
  }
  container.querySelector<HTMLElement>('.profile-input')?.focus()
}

onLocaleChange(() => {
  KIND_LABEL = { fact: t("profile-panel.fact"), preference: t("profile-panel.preference"), person: t("profile-panel.person"), project: t("profile-panel.project"), role: t("profile-panel.role") }
  SOURCE_LABEL = { user: t("profile-panel.added.by.you"), agent: t("profile-panel.remembered.by.assistant") }
  INTRO_ITEMS = [
  { key: 'role', label: t("profile-panel.your.work"), hint: t("profile-panel.for.example.backend.lead.for.payments.responsible"), multiline: false },
  { key: 'projects', label: t("profile-panel.current.projects"), hint: t("profile-panel.for.example.q.reconciliation.system.redesign"), multiline: false },
  { key: 'preferences', label: t("profile-panel.preferences.and.habits"), hint: t("profile-panel.for.example.lead.with.the.conclusion.compare"), multiline: false },
  { key: 'sources', label: t("profile-panel.websites.read.once.by.the.assistant"), hint: t("profile-panel.one.url.per.line.such.as.an"), multiline: true },
]
})
