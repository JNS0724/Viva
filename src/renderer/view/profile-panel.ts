import { t } from '../../shared/i18n/translate.ts'
import { h, keepingInput } from './dom.ts'
import { deferMemoryFileEditorRender, memoryFilesSection, memoryLoadError } from './memory-files-panel.ts'

/** The 关于你 page's part of the state (personal-state.ts). */
type MemoryPage = State['memory']

/** Once there is something to say: it goes along with each conversation, so it is shown here too. */
const habitsRow = (habits: { text?: string, samples?: number }) => (habits.text
  ? h('p', { class: 'help', text: t("profile-panel.usage.habits.based.on.your.last.questions", { samples: habits.samples ?? 0, text: habits.text }) })
  : null)

function profileView(memory: MemoryPage, handlers: Handlers): View[] {
  return [
    h('h2', { class: 'settings-title', id: 'profile-title', text: t("profile-panel.about.you") }),
    h('p', { class: 'help', text: t('memory-files.intro') }),
    memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
    habitsRow(memory.habits),
    memoryLoadError(memory, handlers),
    memoryFilesSection(memory, handlers),
  ]
}

/** The 关于你 page (view/hub.ts). Rebuilt only when its slice changes; typed text survives. */
export function renderProfilePanel(container: HTMLElement, memory: MemoryPage, handlers: Handlers) {
  if (!memory.open) {
    container.replaceChildren()
    return
  }
  const editor = memory.files.editor
  if (editor && deferMemoryFileEditorRender(container, editor, () => renderProfilePanel(container, memory, handlers))) return
  const shownFiles = container.querySelector<HTMLElement>('[data-memory-files-view]')?.dataset.memoryFilesView
  const shownForget = container.querySelector<HTMLElement>('[data-memory-file-forget]')?.dataset.memoryFileForget
  keepingInput(container, () => container.replaceChildren(
    h('section', { class: 'settings profile', 'aria-labelledby': 'profile-title', 'data-view': 'profile' },
      ...profileView(memory, handlers).filter(Boolean))))
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
}
