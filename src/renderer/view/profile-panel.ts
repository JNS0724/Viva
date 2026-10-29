import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { PROFILE_FIELDS } from '../../shared/profile-fields.ts'
import { formatListTime } from '../selectors.ts'
import { h, keepingInput, label } from './dom.ts'
import { icon } from './icons.ts'

/** The 关于你 page's part of the state (personal-state.ts). */
type MemoryPage = State['memory']
/** A field of the profile the user fills in (shared/profile-fields.ts). */
type ProfileField = { key: string, label: string, hint: string }
/** A memory as the page lists it (main/memory-store.ts). */
type MemoryRow = {
  id: number, text: string, kind: string, source: string, createdAt: number, keywords?: readonly string[],
  invalidAt?: number, supersededBy?: number | null, invalidatedBy?: string | null,
}
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

/** Read-only: it is rebuilt from the memories, so changing a memory is how it changes. */
function synthesisSection(memory: MemoryPage, now: number) {
  const synthesis = memory.synthesis
  return h('section', { class: 'profile-section' },
    h('div', { class: 'row-between' },
      h('h3', { class: 'profile-heading', text: t("profile-panel.profile.prepared.by.the.assistant") }),
      synthesis ? h('span', { class: 'memory-meta mono', text: t("profile-panel.updated", { value1: formatListTime(synthesis.createdAt, now) }) }) : null),
    synthesis
      ? h('p', { class: 'profile-synthesis', text: synthesis.text })
      : h('p', { class: 'empty', text: t("profile-panel.once.the.assistant.remembers.things.about.you") }),
    h('p', { class: 'help', text: t("profile-panel.compiled.from.the.memories.below.edit.a") }))
}

function memoryMeta(memory: MemoryRow, now: number) {
  const keywords = memory.keywords?.length ? t("profile-panel.keywords", { value1: memory.keywords.join('、') }) : ''
  return [KIND_LABEL[memory.kind], SOURCE_LABEL[memory.source], formatListTime(memory.createdAt, now), keywords].filter(Boolean).join(' · ')
}

function memoryItem(memory: MemoryRow, handlers: Handlers, now: number) {
  return h('li', { class: 'memory-item', 'data-source': memory.source },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-text', text: memory.text }),
      h('span', { class: 'memory-meta mono', text: memoryMeta(memory, now) })),
    h('button', {
      class: 'icon-btn memory-delete', type: 'button', 'aria-label': t("profile-panel.delete.memory", { text: memory.text }), title: t("extensions.delete"),
      onClick: () => handlers.deleteMemory(memory),
    }, icon('close', 14)))
}

function invalidReason(memory: MemoryRow, now: number) {
  const when = formatListTime(memory.invalidAt ?? 0, now)
  if (memory.supersededBy) return t("profile-panel.replaced.by.a.newer.memory", { when: when })
  return memory.invalidatedBy === 'user' ? t("profile-panel.forgotten.at.your.request", { when: when }) : t("profile-panel.considered.outdated.by.the.assistant", { when: when })
}

function invalidItem(memory: MemoryRow, handlers: Handlers, now: number) {
  return h('li', { class: 'memory-item', 'data-invalid': 'true' },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-text', text: memory.text }),
      h('span', { class: 'memory-meta mono', text: invalidReason(memory, now) })),
    h('button', {
      class: 'btn btn-outline btn-small', type: 'button', text: t("profile-panel.restore"), 'aria-label': t("profile-panel.restore.memory", { text: memory.text }),
      onClick: () => handlers.reviveMemory(memory),
    }))
}

/** Memories that stopped counting stay here, so an update the user disagrees with can be undone. */
function invalidSection(memory: MemoryPage, handlers: Handlers, now: number) {
  if (memory.invalid === 0 && !memory.invalidOpen) return null
  return h('div', { class: 'memory-invalid' },
    h('button', {
      class: 'link-btn', type: 'button', 'aria-expanded': String(memory.invalidOpen),
      text: memory.invalidOpen ? t("profile-panel.hide.inactive.memories") : t("profile-panel.inactive", { invalid: memory.invalid }), onClick: handlers.toggleInvalid,
    }),
    memory.invalidOpen && memory.invalidItems.length
      ? h('ul', { class: 'memory-list' }, memory.invalidItems.map((item: MemoryRow) => invalidItem(item, handlers, now)))
      : null)
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
      ? h('ul', { class: 'memory-list' }, memory.items.map((item: MemoryRow) => memoryItem(item, handlers, now)))
      : h('p', { class: 'empty', text: empty }),
    invalidSection(memory, handlers, now))
}

function profileView(memory: MemoryPage, handlers: Handlers, now: number): View[] {
  return [
    h('h2', { class: 'settings-title', id: 'profile-title', text: t("profile-panel.about.you") }),
    h('p', { class: 'help', text: t("profile-panel.everything.the.assistant.knows.about.you.is") }),
    memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
    h('section', { class: 'profile-section' },
      h('h3', { class: 'profile-heading', text: t("profile-panel.your.profile") }),
      h('div', { class: 'profile-grid' }, PROFILE_FIELDS.map((field) => fieldCard(field, memory, handlers))),
      habitsRow(memory.habits)),
    synthesisSection(memory, now),
    memoriesSection(memory, handlers, now),
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
  keepingInput(container, () => container.replaceChildren(
    h('section', { class: 'settings profile', 'aria-labelledby': 'profile-title', 'data-view': memory.view },
      ...(memory.view === 'intro' ? introView(memory, handlers) : profileView(memory, handlers, now)).filter(Boolean))))
  if (shownView !== 'intro' && memory.view === 'intro') container.querySelector<HTMLElement>('[name="intro-role"]')?.focus()
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
