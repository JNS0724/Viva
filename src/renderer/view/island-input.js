import { formatSize } from '../selectors.js'
import { h } from './dom.js'

/**
 * The desktop island's input (desk.js): what the user asks from any app, with the shortcut or by dropping
 * files on the island. The text field is made once and kept, so what is typed survives the island's
 * changes of shape; the rest is drawn from the view:
 *   { form: 'input', busy?: { action?: string, text?: string }, files: { path, name, size }[], error?: string }
 * and, while files are dragged over the island, { form: 'drop', count }.
 */
export const INPUT_FORMS = new Set(['input', 'drop'])
const PLACEHOLDER = '问 Viva…'
const PLACEHOLDER_FILES = '要它做什么？直接按「总结」也行'
export const BUSY_TEXT = '正在忙，完成后再问'
const SUMMARIZE = '总结'
const TARGET = '发到当前对话'

/**
 * @param {{ send: (text: string) => void, dismiss: () => void, removeFile: (path: string) => void }} handlers
 */
export function createIslandInput({ send, dismiss, removeFile }) {
  const field = h('textarea', { class: 'isl-field', rows: '1', 'aria-label': PLACEHOLDER, spellcheck: 'false' })
  const enter = h('span', { class: 'isl-kbd', 'aria-hidden': 'true', text: '↵' })
  const entry = h('div', { class: 'isl-entry' }, field, enter)

  const ready = () => enter.classList.toggle('hot', field.value.trim() !== '')
  field.addEventListener('input', ready)
  field.addEventListener('keydown', (event) => {
    // While an input method is composing, Enter picks the characters; it does not send.
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const text = field.value.trim()
      if (text) send(text)
    }
  })

  /** The field as the view wants it: open for typing, or showing why it is not. */
  function sync(view) {
    field.disabled = Boolean(view.busy)
    field.placeholder = view.busy ? BUSY_TEXT : view.files.length ? PLACEHOLDER_FILES : PLACEHOLDER
    enter.hidden = Boolean(view.busy)
    ready()
  }

  const hint = (...parts) => h('div', { class: 'isl-hint' }, ...parts)
  const fileChip = (file) => h('span', { class: 'isl-file', title: file.path },
    h('span', { class: 'doc-ico', 'aria-hidden': 'true' }),
    h('span', { class: 'isl-file-name', text: file.name }),
    h('small', { text: formatSize(file.size) }),
    h('button', { type: 'button', class: 'isl-file-x', 'aria-label': `去掉 ${file.name}`, text: '×', onClick: () => removeFile(file.path) }))

  /** @returns {Node[]} what unfolds below the field */
  function panel(view) {
    if (view.form === 'drop') {
      return [h('div', { class: 'isl-drop' },
        h('b', { text: '松手，交给 Viva' }),
        h('span', { text: `${view.count > 1 ? `${view.count} 个文件` : '文件'} · 只交给助手文件路径，不复制` }))]
    }
    const error = view.error ? h('div', { class: 'isl-error', role: 'alert', text: view.error }) : null
    if (view.busy) {
      return [hint(view.busy.text ?? (view.busy.action || '正在工作'), h('span', { class: 'isl-push', text: 'Esc 收起' })), error]
    }
    if (view.files.length) {
      return [
        h('div', { class: 'isl-files' }, view.files.map(fileChip)),
        h('div', { class: 'isl-actions' },
          h('button', { type: 'button', class: 'isl-btn isl-btn-blue', text: SUMMARIZE, onClick: () => send(SUMMARIZE) }),
          hint(TARGET)),
        error,
      ]
    }
    return [hint(TARGET, h('span', { class: 'isl-push', text: 'Shift+Enter 换行 · Esc 收起' })), error]
  }

  return {
    entry,
    field,
    sync,
    panel,
    clear() {
      field.value = ''
      ready()
    },
  }
}
