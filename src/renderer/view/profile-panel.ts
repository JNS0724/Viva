import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { PROFILE_FIELDS } from '../../shared/profile-fields.ts'
import { h, keepingInput, label } from './dom.ts'
import { icon } from './icons.ts'
import type { MemoryFileProfileItem } from '../../memory/contracts/file-management.ts'
import { deferMemoryFileEditorRender, memoryFilesSection, memoryLoadError } from './memory-files-panel.ts'

/** The 关于你 page's part of the state (personal-state.ts). */
type MemoryPage = State['memory']
/** A field of the profile the user fills in (shared/profile-fields.ts). */
type ProfileField = { key: string, label: string, hint: string }
type IntroItem = { key: string, label: string, hint: string, multiline: boolean }

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

function fileSummarySection(scope: 'user' | 'project', items: readonly MemoryFileProfileItem[] | null, handlers: Handlers) {
  if (!items?.length) return null
  return h('section', { class: 'profile-section', 'aria-labelledby': `profile-summary-${scope}`, 'data-profile-summary': scope },
    h('h3', { class: 'profile-heading', id: `profile-summary-${scope}`, text: t(`profile-panel.summary.${scope}`) }),
    h('ul', { class: 'memory-list' }, items.map(({ identity, text }, index) => {
      const id = `profile-memory-${scope}-${index}`
      return h('li', { class: 'memory-item' },
        h('div', { class: 'memory-copy' }, h('span', { class: 'memory-text', id, text })),
        h('div', { class: 'memory-actions' }, h('button', { class: 'link-btn', type: 'button',
          'aria-describedby': id, text: t('memory-files.profile.sources'), onClick: () => handlers.showMemoryFile({ identity }) })))
    })))
}

function profileView(memory: MemoryPage, handlers: Handlers): View[] {
  const fileProfile = !memory.loadError && !memory.files.selection && !memory.files.editor ? memory.fileProfile : null
  return [
    h('h2', { class: 'settings-title', id: 'profile-title', text: t("profile-panel.about.you") }),
    h('p', { class: 'help', text: t('memory-files.intro') }),
    memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
    h('section', { class: 'profile-section' },
      h('h3', { class: 'profile-heading', text: t("profile-panel.your.profile") }),
      h('div', { class: 'profile-grid' }, PROFILE_FIELDS.map((field) => fieldCard(field, memory, handlers))),
      habitsRow(memory.habits)),
    fileProfile ? fileSummarySection('user', fileProfile.user, handlers) : null,
    fileProfile ? fileSummarySection('project', fileProfile.project, handlers) : null,
    memoryFilesSection(memory, handlers),
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

const editingShown = new WeakMap<HTMLElement, string | null>()

/** The 关于你 page (view/hub.ts), or the intro form in its place. Rebuilt only when its slice changes; typed text survives. */
export function renderProfilePanel(container: HTMLElement, memory: MemoryPage, handlers: Handlers) {
  if (!memory.open) {
    editingShown.delete(container)
    container.replaceChildren()
    return
  }
  const editor = memory.view === 'profile' ? memory.files.editor : null
  if (editor && deferMemoryFileEditorRender(container, editor, () => renderProfilePanel(container, memory, handlers))) return
  const previousEditing = editingShown.get(container) ?? null
  const nextEditing = memory.view === 'profile' ? memory.editing : null
  editingShown.set(container, nextEditing)
  const shownView = container.querySelector<HTMLElement>('.profile')?.dataset.view ?? null
  const shownFiles = container.querySelector<HTMLElement>('[data-memory-files-view]')?.dataset.memoryFilesView
  const shownForget = container.querySelector<HTMLElement>('[data-memory-file-forget]')?.dataset.memoryFileForget
  keepingInput(container, () => container.replaceChildren(
    h('section', { class: 'settings profile', 'aria-labelledby': 'profile-title', 'data-view': memory.view },
      ...(memory.view === 'intro' ? introView(memory, handlers) : profileView(memory, handlers)).filter(Boolean))))
  if (shownView !== 'intro' && memory.view === 'intro') container.querySelector<HTMLElement>('[name="intro-role"]')?.focus()
  const nextFiles = container.querySelector<HTMLElement>('[data-memory-files-view]')?.dataset.memoryFilesView
  const nextForget = container.querySelector<HTMLElement>('[data-memory-file-forget]')?.dataset.memoryFileForget
  if (shownForget !== nextForget) {
    const target = nextForget ? '[name="memory-file-forget-cancel"]' : '[name="memory-file-forget"]'
    container.querySelector<HTMLElement>(target)?.focus()
  }
  if (shownFiles && nextFiles && shownFiles !== nextFiles) {
    const target = nextFiles === 'create' || nextFiles === 'edit' ? '[name="memory-file-draft-title"]'
      : nextFiles === 'list' ? shownFiles === 'create' ? '[name="memory-file-create"]' : '[name="memory-files-search"]'
        : '[name="memory-file-back"]'
    const edit = nextFiles === 'detail' && shownFiles === 'edit'
      ? container.querySelector<HTMLElement>('[name="memory-file-edit"]:enabled') : null
    const focus = edit ?? container.querySelector<HTMLElement>(target)
    focus?.focus()
  }
  if (nextEditing !== null && nextEditing !== previousEditing) container.querySelector<HTMLElement>('.profile-input')?.focus()
}

onLocaleChange(() => {
  INTRO_ITEMS = [
    { key: 'role', label: t("profile-panel.your.work"), hint: t("profile-panel.for.example.backend.lead.for.payments.responsible"), multiline: false },
    { key: 'projects', label: t("profile-panel.current.projects"), hint: t("profile-panel.for.example.q.reconciliation.system.redesign"), multiline: false },
    { key: 'preferences', label: t("profile-panel.preferences.and.habits"), hint: t("profile-panel.for.example.lead.with.the.conclusion.compare"), multiline: false },
    { key: 'sources', label: t("profile-panel.websites.read.once.by.the.assistant"), hint: t("profile-panel.one.url.per.line.such.as.an"), multiline: true },
  ]
})
