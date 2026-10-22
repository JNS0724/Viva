import { formatSize } from '../selectors.ts'
import { h } from './dom.ts'
import { picture } from './pictures.ts'

/**
 * The desktop island's input (desk.js): what the user asks from any app, with the shortcut or by dropping
 * files on the island. The text field is made once and kept, so what is typed survives the island's
 * changes of shape; the rest is drawn from the view:
 *   { form: 'input', busy?: { text: string }, steering?: boolean, files: { path, name, size }[], images?: { id, size }[], error?: string }
 * steering: the agent is working, so what is asked goes into its turn (app.js steer); images: pictures pasted,
 * shown like the files, with the picture for an icon.
 * and, while files are dragged over the island, { form: 'drop', count }.
 */
export const INPUT_FORMS = new Set(['input', 'drop'])
const PLACEHOLDER = '问 Viva…'
const PLACEHOLDER_FILES = '要它做什么？直接按「总结」也行'
const PLACEHOLDER_STEER = '插话：补充或修改要求…'
const PLACEHOLDER_IMAGES = '想问这张图什么？'
const SUMMARIZE = '总结'
const TARGET = '发到当前对话'
const TARGET_STEER = '助手正在工作，下一步就会读到'

export function createIslandInput({ send, dismiss, removeFile, removeImage = () => {}, paste = null }: {
  send: (text: string) => void, dismiss: () => void, removeFile: (path: string) => void,
  removeImage?: (id: string) => void, paste?: ((event: ClipboardEvent) => void) | null,
}) {
  const field = h('textarea', { class: 'isl-field', rows: '1', 'aria-label': PLACEHOLDER, spellcheck: 'false' })
  const enter = h('span', { class: 'isl-kbd', 'aria-hidden': 'true', text: '↵' })
  const entry = h('div', { class: 'isl-entry' }, field, enter)

  const ready = () => enter.classList.toggle('hot', field.value.trim() !== '')
  field.addEventListener('input', ready)
  if (paste) field.addEventListener('paste', paste)
  field.addEventListener('keydown', (event) => {
    // While an input method is composing, Enter picks the characters; it does not send.
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const text = field.value.trim()
      if (text || pictures) send(text)
    }
  })
  /** Pictures waiting to go: with them the words may be left out. */
  let pictures = 0

  /** The field as the view wants it: open for typing, or showing why it is not. */
  function sync(view: IslandShown) {
    pictures = view.images?.length ?? 0
    field.disabled = Boolean(view.busy)
    field.placeholder = view.busy?.text ?? (view.steering ? PLACEHOLDER_STEER : view.files.length ? PLACEHOLDER_FILES : pictures ? PLACEHOLDER_IMAGES : PLACEHOLDER)
    enter.hidden = Boolean(view.busy)
    ready()
  }

  const hint = (...parts: View[]) => h('div', { class: 'isl-hint' }, ...parts)
  const fileChip = (file: { path: string, name: string, size: number }) => h('span', { class: 'isl-file', title: file.path },
    h('span', { class: 'doc-ico', 'aria-hidden': 'true' }),
    h('span', { class: 'isl-file-name', text: file.name }),
    h('small', { text: formatSize(file.size) }),
    h('button', { type: 'button', class: 'isl-file-x', 'aria-label': `去掉 ${file.name}`, text: '×', onClick: () => removeFile(file.path) }))
  const imageChip = (image: { id: string, size: number }, i: number) => h('span', { class: 'isl-file isl-image' },
    picture(image.id, { cls: 'isl-file-thumb' }),
    h('span', { class: 'isl-file-name', text: `图片 ${i + 1}` }),
    h('small', { text: formatSize(image.size) }),
    h('button', { type: 'button', class: 'isl-file-x', 'aria-label': `去掉图片 ${i + 1}`, text: '×', onClick: () => removeImage(image.id) }))

  /** What unfolds below the field. */
  function panel(view: IslandShown): View[] {
    if (view.form === 'drop') {
      return [h('div', { class: 'isl-drop' },
        h('b', { text: '松手，交给 Viva' }),
        h('span', { text: `${view.count > 1 ? `${view.count} 个文件` : '文件'} · 只交给助手文件路径，不复制` }))]
    }
    const error = view.error ? h('div', { class: 'isl-error', role: 'alert', text: view.error }) : null
    if (view.busy) return [hint(h('span', { class: 'isl-push', text: 'Esc 收起' })), error]
    const target = view.steering ? TARGET_STEER : TARGET
    const images = view.images ?? []
    if (images.length && !view.files.length) {
      return [h('div', { class: 'isl-files' }, images.map(imageChip)), hint(target, h('span', { class: 'isl-push', text: 'Enter 发送 · Esc 收起' })), error]
    }
    if (view.files.length) {
      return [
        h('div', { class: 'isl-files' }, images.map(imageChip), view.files.map(fileChip)),
        h('div', { class: 'isl-actions' },
          h('button', { type: 'button', class: 'isl-btn isl-btn-blue', text: SUMMARIZE, onClick: () => send(SUMMARIZE) }),
          hint(target)),
        error,
      ]
    }
    return [hint(target, h('span', { class: 'isl-push', text: 'Shift+Enter 换行 · Esc 收起' })), error]
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
