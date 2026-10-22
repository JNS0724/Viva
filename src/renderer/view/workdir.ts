import { DEFAULT_DIR_NAME, workDirMenu, workspaceName } from '../selectors.ts'
import { isBusy } from '../state.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'

/**
 * The working directory under the input (single-conversation design): a chip with the folder in use, its menu
 * (the folders used lately, the system's folder dialog, the folder in Finder or Explorer), and the question
 * asked the first time a folder is used. Keys are the platform's: ⌘O on macOS, Ctrl+O elsewhere.
 */
const keyFor = (platform) => (platform === 'darwin' ? '⌘O' : 'Ctrl+O')
const revealLabel = (platform) => (platform === 'darwin' ? '在访达中显示当前目录' : '在资源管理器中显示当前目录')

function renderChip(button, state) {
  const { workDir } = state
  const busy = isBusy(state)
  const name = workDir.isDefault ? DEFAULT_DIR_NAME : workspaceName(workDir.current || state.info.cwd)
  button.replaceChildren(
    h('span', { class: 'workdir-ico', 'aria-hidden': 'true', text: '📁' }),
    h('span', { class: 'workdir-name', text: workDir.switching ? '正在切换…' : name }),
    // The same chevron as the model's button beside it (model-picker.js).
    icon('chevron', 14))
  button.disabled = workDir.switching || busy
  button.title = busy ? '助手工作时不能换工作目录' : `工作目录：${workDir.current || state.info.cwd}`
  button.setAttribute('aria-expanded', String(workDir.menu))
}

function renderMenu(container, state, handlers, platform) {
  if (!state.workDir.menu) return container.replaceChildren()
  const item = (entry) => h('button', {
    class: `workdir-item${entry.current ? ' is-current' : ''}`, type: 'button', role: 'menuitem', title: entry.dir,
    'aria-current': entry.current ? 'true' : null, onClick: () => (entry.current ? handlers.closeWorkDirMenu() : handlers.pickWorkDir(entry.dir)),
  },
  h('span', { class: 'workdir-check', 'aria-hidden': 'true', text: entry.current ? '✓' : '' }),
  h('span', { class: 'workdir-item-name', text: entry.name }),
  h('span', { class: 'workdir-item-path mono', text: entry.isDefault ? '默认' : entry.dir }))
  const [current, ...others] = workDirMenu(state.workDir)
  container.replaceChildren(h('div', { class: 'workdir-menu', role: 'menu', 'aria-label': '工作目录' },
    h('div', { class: 'workdir-head', text: '工作目录' }),
    current ? item(current) : null,
    others.length ? h('div', { class: 'workdir-head', text: '最近' }) : null,
    others.map(item),
    h('div', { class: 'workdir-sep', role: 'separator' }),
    h('button', { class: 'workdir-item', type: 'button', role: 'menuitem', onClick: () => handlers.chooseWorkDir() },
      h('span', { class: 'workdir-check' }), h('span', { class: 'workdir-item-name', text: '选择文件夹…' }), h('kbd', { text: keyFor(platform) })),
    h('button', { class: 'workdir-item', type: 'button', role: 'menuitem', onClick: () => handlers.revealWorkDir() },
      h('span', { class: 'workdir-check' }), h('span', { class: 'workdir-item-name', text: revealLabel(platform) }))))
}

function renderConfirm(root, state, handlers) {
  const dir = state.workDir.confirm
  if (!dir) return root.replaceChildren()
  root.replaceChildren(h('div', { class: 'workdir-scrim', onClick: () => handlers.cancelWorkDir() }),
    h('div', { class: 'workdir-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '在这个文件夹里工作？' },
      h('div', { class: 'workdir-sheet-title', text: '在这个文件夹里工作？' }),
      h('div', { class: 'workdir-sheet-path mono', text: dir }),
      h('p', { class: 'workdir-sheet-text', text: 'Viva 之后会在这里读文件、运行命令；写文件和运行有风险的命令之前，仍然会先问你。' }),
      h('p', { class: 'workdir-sheet-text', text: '对话不会中断，前面聊过的内容 Viva 都记得。' }),
      h('div', { class: 'workdir-sheet-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', text: '取消', onClick: () => handlers.cancelWorkDir() }),
        h('button', { class: 'btn btn-accent', type: 'button', text: '在这里工作', onClick: () => handlers.confirmWorkDir() }))))
  root.querySelector('.btn-accent')?.focus()
}

/**
 * @param {{ context: HTMLButtonElement, workdirMenu: HTMLElement, workdirConfirm: HTMLElement }} dom
 * @param {string} platform 'darwin' | 'win32' | 'linux'
 */
export function renderWorkDir(dom, state, handlers, platform) {
  renderChip(dom.context, state)
  renderMenu(dom.workdirMenu, state, handlers, platform)
  renderConfirm(dom.workdirConfirm, state, handlers)
}
