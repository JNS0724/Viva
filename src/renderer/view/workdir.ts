import { t } from '../../shared/i18n/translate.ts'
import { DEFAULT_DIR_NAME, workDirMenu, workspaceName } from '../selectors.ts'
import { isBusy } from '../state.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'

/**
 * The working directory under the input (single-conversation design): a chip with the folder in use, its menu
 * (the folders used lately, the system's folder dialog, the folder in Finder or Explorer), and the question
 * asked the first time a folder is used. Keys are the platform's: ⌘O on macOS, Ctrl+O elsewhere.
 */
/** A folder in the menu (selectors.ts workDirMenu). */
type MenuEntry = ReturnType<typeof workDirMenu>[number]

const keyFor = (platform: string) => (platform === 'darwin' ? '⌘O' : 'Ctrl+O')
const revealLabel = (platform: string) => (platform === 'darwin' ? t("workdir.show.current.folder.in.finder") : t("workdir.show.current.folder.in.file.explorer"))

function renderChip(button: HTMLButtonElement, state: State) {
  const { workDir } = state
  const busy = isBusy(state) || state.switching
  const name = workDir.isDefault ? DEFAULT_DIR_NAME : workspaceName(workDir.current || state.info.cwd)
  button.replaceChildren(
    h('span', { class: 'workdir-ico', 'aria-hidden': 'true', text: '📁' }),
    h('span', { class: 'workdir-name', text: workDir.switching ? t("workdir.switching") : name }),
    // The same chevron as the model's button beside it (model-picker.js).
    icon('chevron', 14))
  button.disabled = workDir.switching || busy
  button.title = busy ? t("workdir.cannot.change.the.working.directory.while.the") : t("workdir.working.directory", { value1: workDir.current || state.info.cwd })
  button.setAttribute('aria-expanded', String(workDir.menu))
}

function renderMenu(container: HTMLElement, state: State, handlers: Handlers, platform: string) {
  if (!state.workDir.menu) return container.replaceChildren()
  const item = (entry: MenuEntry) => h('button', {
    class: `workdir-item${entry.current ? ' is-current' : ''}`, type: 'button', role: 'menuitem', title: entry.dir,
    'aria-current': entry.current ? 'true' : null, onClick: () => (entry.current ? handlers.closeWorkDirMenu() : handlers.pickWorkDir(entry.dir)),
  },
  h('span', { class: 'workdir-check', 'aria-hidden': 'true', text: entry.current ? '✓' : '' }),
  h('span', { class: 'workdir-item-name', text: entry.name }),
  h('span', { class: 'workdir-item-path mono', text: entry.isDefault ? t("files-panel.default") : entry.dir }))
  const [current, ...others] = workDirMenu(state.workDir)
  container.replaceChildren(h('div', { class: 'workdir-menu', role: 'menu', 'aria-label': t("workdir.working.directory.2") },
    h('div', { class: 'workdir-head', text: t("workdir.working.directory.2") }),
    current ? item(current) : null,
    others.length ? h('div', { class: 'workdir-head', text: t("workdir.recent") }) : null,
    others.map(item),
    h('div', { class: 'workdir-sep', role: 'separator' }),
    h('button', { class: 'workdir-item', type: 'button', role: 'menuitem', onClick: () => handlers.chooseWorkDir() },
      h('span', { class: 'workdir-check' }), h('span', { class: 'workdir-item-name', text: t("workdir.choose.folder") }), h('kbd', { text: keyFor(platform) })),
    h('button', { class: 'workdir-item', type: 'button', role: 'menuitem', onClick: () => handlers.revealWorkDir() },
      h('span', { class: 'workdir-check' }), h('span', { class: 'workdir-item-name', text: revealLabel(platform) }))))
}

function renderConfirm(root: HTMLElement, state: State, handlers: Handlers) {
  const dir = state.workDir.confirm
  if (!dir) return root.replaceChildren()
  root.replaceChildren(h('div', { class: 'workdir-scrim', onClick: () => handlers.cancelWorkDir() }),
    h('div', { class: 'workdir-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t("workdir.work.in.this.folder") },
      h('div', { class: 'workdir-sheet-title', text: t("workdir.work.in.this.folder") }),
      h('div', { class: 'workdir-sheet-path mono', text: dir }),
      h('p', { class: 'workdir-sheet-text', text: t("workdir.viva.will.read.files.and.run.commands") }),
      h('p', { class: 'workdir-sheet-text', text: t("workdir.your.conversation.continues.viva.remembers.what.you") }),
      h('div', { class: 'workdir-sheet-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', text: t("extensions.cancel"), onClick: () => handlers.cancelWorkDir() }),
        h('button', { class: 'btn btn-accent', type: 'button', text: t("workdir.work.here"), onClick: () => handlers.confirmWorkDir() }))))
  root.querySelector<HTMLElement>('.btn-accent')?.focus()
}

/** @param platform 'darwin' | 'win32' | 'linux' */
export function renderWorkDir(dom: { context: HTMLButtonElement, workdirMenu: HTMLElement, workdirConfirm: HTMLElement }, state: State, handlers: Handlers, platform: string) {
  renderChip(dom.context, state)
  renderMenu(dom.workdirMenu, state, handlers, platform)
  renderConfirm(dom.workdirConfirm, state, handlers)
}
