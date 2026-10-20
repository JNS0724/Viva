import { touchedPaths } from '../files-state.js'
import { h } from './dom.js'
import { icon } from './icons.js'
import { renderMarkdown } from './markdown.js'

/**
 * The 文件 tab: the workspace as a tree above, the picked file below. Files the agent touched in this
 * conversation carry a dot. Read-only; the two buttons hand the file to the system.
 */
const KB = 1024
const REVEAL = { win32: '在资源管理器中显示', darwin: '在 Finder 中显示' }

function formatSize(bytes) {
  if (bytes < KB) return `${bytes} B`
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / KB / KB).toFixed(1)} MB`
}

/** The page's CSP allows no style attribute, so the indent goes in through the CSSOM. */
function indented(row, depth) {
  row.style.setProperty('--depth', String(depth))
  return row
}

function folderRow(entry, depth, files, handlers) {
  const open = files.expanded.includes(entry.path)
  return indented(h('button', {
    type: 'button', class: 'file-row', 'data-kind': 'folder', 'data-heavy': String(entry.heavy), 'aria-expanded': String(open),
    title: entry.path, onClick: () => handlers.toggleFolder(entry.path),
  }, h('span', { class: 'file-caret', 'data-open': String(open) }, icon('chevron', 12)), h('span', { class: 'file-name', text: entry.name })), depth)
}

function fileRow(entry, depth, files, touched, handlers) {
  return indented(h('button', {
    type: 'button', class: 'file-row', 'data-kind': 'file', 'aria-current': String(files.selected === entry.path),
    title: entry.path, onClick: () => handlers.selectFile(entry.path),
  },
  h('span', { class: 'file-caret' }),
  h('span', { class: 'file-name', text: entry.name }),
  touched.has(entry.path) ? h('span', { class: 'file-touched', title: '这次对话里动过', 'aria-label': '这次对话里动过' }) : null), depth)
}

/** Rows for one folder and, under each open subfolder, its rows; a folder not read yet shows nothing. */
function rows(path, depth, files, touched, handlers) {
  return (files.folders[path] ?? []).flatMap((entry) => (entry.kind === 'folder'
    ? [folderRow(entry, depth, files, handlers), ...(files.expanded.includes(entry.path) ? rows(entry.path, depth + 1, files, touched, handlers) : [])]
    : [fileRow(entry, depth, files, touched, handlers)]))
}

function previewBody(preview, handlers) {
  if (preview.kind === 'markdown') return h('div', { class: 'file-doc' }, renderMarkdown(preview.text, handlers))
  if (preview.kind === 'text') return h('pre', { class: 'file-text', text: preview.text })
  if (preview.kind === 'image') return h('img', { class: 'file-image', src: preview.dataUrl, alt: preview.name })
  return h('p', { class: 'empty', text: '这个文件不能在这里预览，可以用它自己的应用打开。' })
}

function previewPane(files, handlers) {
  const { preview } = files
  if (files.loading) return h('div', { class: 'file-preview' }, h('p', { class: 'empty', text: '读取中…' }))
  if (!preview) return h('div', { class: 'file-preview' }, h('p', { class: 'empty', text: '点一个文件，在这里看它的内容。' }))
  const platform = document.documentElement.dataset.platform
  return h('div', { class: 'file-preview' },
    h('div', { class: 'file-head' },
      h('div', { class: 'file-title' }, h('span', { class: 'file-title-name', text: preview.name }), h('span', { class: 'file-size', text: formatSize(preview.size) })),
      h('div', { class: 'file-actions' },
        h('button', { type: 'button', class: 'btn btn-outline btn-small', text: REVEAL[platform] ?? '在文件夹中显示', onClick: () => handlers.revealFile(preview.path) }),
        preview.openable ? h('button', { type: 'button', class: 'btn btn-outline btn-small', text: '打开', onClick: () => handlers.openFile(preview.path) }) : null)),
    preview.truncated ? h('p', { class: 'help', text: '文件较大，只显示了开头。' }) : null,
    previewBody(preview, handlers))
}

/** @returns {HTMLElement[]} */
export function filesView(state, handlers) {
  const { files } = state
  const top = files.folders['']
  return [h('div', { class: 'files' },
    files.error ? h('p', { class: 'form-error', role: 'alert', text: files.error }) : null,
    h('nav', { class: 'file-tree', 'aria-label': '工作区文件' },
      top === undefined ? h('p', { class: 'empty', text: '读取中…' })
        : top.length ? rows('', 0, files, touchedPaths(state), handlers)
          : h('p', { class: 'empty', text: '工作区里还没有文件。' })),
    previewPane(files, handlers))]
}
