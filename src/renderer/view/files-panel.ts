import { MAX_ROWS, parseTable } from '../csv.ts'
import { touchedPaths } from '../files-state.ts'
import { formatSize } from '../selectors.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'
import { renderMarkdown } from './markdown.ts'

/**
 * The 文件 tab: the workspace as a tree above, the picked file below. Files the agent touched in this
 * conversation carry a dot. Read-only; the two buttons hand the file to the system.
 */
const REVEAL = '显示文件位置'
/** How close to its end the preview may be scrolled before the next page is read. */
const MORE_MARGIN_PX = 400

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

/** A picture a Markdown file names, when it is a file inside the workspace; anything else stays a link. */
function localImage(preview, handlers) {
  const base = preview.path.split('/').slice(0, -1)
  return (src, alt) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return null
    const parts = [...base]
    for (const part of decodeURI(src.split(/[?#]/)[0]).split('/')) {
      if (part === '..') {
        if (!parts.length) return null
        parts.pop()
      } else if (part && part !== '.') parts.push(part)
    }
    const img = h('img', { class: 'file-doc-image', alt: alt || src })
    handlers.fileImage(parts.join('/')).then((url) => { img.src = url }, () => img.replaceWith(`[图片：${alt || src}]`))
    return img
  }
}

/** The code as highlight.js marked it up in the main process (workspace-files.js): its text escaped, only hljs spans. */
function codeBlock(preview) {
  const code = h('code', { class: `hljs language-${preview.language}` })
  code.innerHTML = preview.html
  return h('pre', { class: 'file-text file-code' }, code)
}

function tableView(preview) {
  const { rows, more } = parseTable(preview.text, preview.name.toLowerCase().endsWith('.tsv') ? '\t' : ',')
  return h('div', { class: 'file-table-wrap' },
    h('table', { class: 'file-table' }, h('tbody', null, rows.map((row, i) => h('tr', null,
      h('th', { class: 'file-row-number', text: String(i + 1) }),
      row.map((value) => h('td', { text: value })))))),
    more ? h('p', { class: 'help', text: `表格只显示了前 ${MAX_ROWS} 行，另有 ${more} 行可以切到文本查看。` }) : null)
}

function tableToggle(files, handlers) {
  return h('div', { class: 'file-views', role: 'group', 'aria-label': '查看方式' },
    [['table', '表格'], ['text', '文本']].map(([mode, name]) => h('button', {
      type: 'button', class: 'file-view-btn', 'aria-pressed': String(files.view === mode), text: name, onClick: () => handlers.setTableView(mode),
    })))
}

function previewBody(files, handlers) {
  const { preview } = files
  if (preview.kind === 'markdown') return h('div', { class: 'file-doc' }, renderMarkdown(preview.text, { ...handlers, image: localImage(preview, handlers) }))
  if (preview.kind === 'code') return codeBlock(preview)
  if (preview.kind === 'csv' && files.view === 'table') return tableView(preview)
  if (preview.kind === 'text' || preview.kind === 'csv') return h('pre', { class: 'file-text', text: preview.text })
  if (preview.kind === 'image') return h('img', { class: 'file-image', src: preview.dataUrl, alt: preview.name })
  return h('p', { class: 'empty', text: '这个文件不能在这里预览，可以用它自己的应用打开。' })
}

/** 打开 opens with the default app; ▾ lists every app that can, then 显示文件位置. A program only has the latter. */
function openControl(preview, files, handlers) {
  const reveal = () => handlers.revealFile(preview.path)
  if (!preview.openable) return h('button', { type: 'button', class: 'btn btn-outline btn-small', text: REVEAL, onClick: reveal })
  // Undefined while the system is still asked (the first time, it reads every app's icon).
  const listed = files.apps[preview.path]
  const apps = listed ?? []
  const preferred = apps.find((app) => app.default) ?? apps[0] ?? null
  return h('div', { class: 'open-split' },
    h('button', {
      type: 'button', class: 'btn btn-outline btn-small open-main', title: preferred ? `用 ${preferred.name} 打开` : '用默认应用打开',
      onClick: () => handlers.openFile(preview.path, preferred?.id ?? null),
    }, preferred?.icon ? h('img', { class: 'app-icon', src: preferred.icon, alt: '' }) : null, '打开'),
    h('button', {
      type: 'button', class: 'btn btn-outline btn-small open-more', 'aria-label': '选择打开方式', 'aria-haspopup': 'menu', 'aria-expanded': String(files.menu),
      onClick: handlers.toggleOpenMenu,
    }, icon('chevron', 12)),
    files.menu ? h('div', { class: 'open-menu', role: 'menu' },
      listed ? null : h('span', { class: 'open-item open-pending', text: '正在查找可以打开它的应用…' }),
      apps.map((app) => h('button', { type: 'button', role: 'menuitem', class: 'open-item', onClick: () => handlers.openFile(preview.path, app.id) },
        app.icon ? h('img', { class: 'app-icon', src: app.icon, alt: '' }) : h('span', { class: 'app-icon' }),
        h('span', { class: 'open-name', text: app.name }),
        app.default ? h('span', { class: 'open-default', text: '默认' }) : null)),
      h('button', { type: 'button', role: 'menuitem', class: 'open-item open-reveal', onClick: reveal }, h('span', { class: 'app-icon' }), h('span', { class: 'open-name', text: REVEAL }))) : null)
}

/** The rest of a long text: read as the preview is scrolled to its end, or with the button. */
function moreRow(files, handlers) {
  if (files.preview.nextOffset == null) return null
  return h('button', { type: 'button', class: 'btn btn-outline btn-small file-more', disabled: files.loadingMore, text: files.loadingMore ? '读取中…' : '继续加载', onClick: handlers.loadMorePreview })
}

function previewPane(files, handlers) {
  const { preview } = files
  if (files.loading) return h('div', { class: 'file-preview' }, h('p', { class: 'empty', text: '读取中…' }))
  if (!preview) return h('div', { class: 'file-preview' }, h('p', { class: 'empty', text: '点一个文件，在这里看它的内容。' }))
  const pane = h('div', {
    class: 'file-preview', 'data-path': preview.path,
    onScroll: (event) => {
      const el = event.currentTarget
      if (el.scrollHeight - el.scrollTop - el.clientHeight < MORE_MARGIN_PX) handlers.loadMorePreview()
    },
  },
  h('div', { class: 'file-head' },
    h('div', { class: 'file-title' }, h('span', { class: 'file-title-name', text: preview.name }), h('span', { class: 'file-size', text: formatSize(preview.size) })),
    h('div', { class: 'file-actions' }, openControl(preview, files, handlers), preview.kind === 'csv' ? tableToggle(files, handlers) : null)),
  previewBody(files, handlers),
  moreRow(files, handlers))
  return pane
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
