import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
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
let REVEAL = t("files-panel.show.file.location")
/** How close to its end the preview may be scrolled before the next page is read. */
const MORE_MARGIN_PX = 400

/** The 文件 tab's part of the state (files-state.ts). */
type Files = State['files']
/** A file or folder as a folder lists it (workspace-files.ts). */
type Entry = { path: string, name: string, kind: string, heavy?: boolean }
/** The file shown below the tree (files:preview). */
type Preview = Untyped
/** An app that opens a file (files:apps). */
type App = { id: string, name: string, icon?: string, default?: boolean }

/** The page's CSP allows no style attribute, so the indent goes in through the CSSOM. */
function indented(row: HTMLElement, depth: number) {
  row.style.setProperty('--depth', String(depth))
  return row
}

function folderRow(entry: Entry, depth: number, files: Files, handlers: Handlers) {
  const open = files.expanded.includes(entry.path)
  return indented(h('button', {
    type: 'button', class: 'file-row', 'data-kind': 'folder', 'data-heavy': String(entry.heavy), 'aria-expanded': String(open),
    title: entry.path, onClick: () => handlers.toggleFolder(entry.path),
  }, h('span', { class: 'file-caret', 'data-open': String(open) }, icon('chevron', 12)), h('span', { class: 'file-name', text: entry.name })), depth)
}

function fileRow(entry: Entry, depth: number, files: Files, touched: Set<string>, handlers: Handlers) {
  return indented(h('button', {
    type: 'button', class: 'file-row', 'data-kind': 'file', 'aria-current': String(files.selected === entry.path),
    title: entry.path, onClick: () => handlers.selectFile(entry.path),
  },
  h('span', { class: 'file-caret' }),
  h('span', { class: 'file-name', text: entry.name }),
  touched.has(entry.path) ? h('span', { class: 'file-touched', title: t("files-panel.used.in.this.conversation"), 'aria-label': t("files-panel.used.in.this.conversation") }) : null), depth)
}

/** Rows for one folder and, under each open subfolder, its rows; a folder not read yet shows nothing. */
function rows(path: string, depth: number, files: Files, touched: Set<string>, handlers: Handlers): HTMLElement[] {
  return (files.folders[path] ?? []).flatMap((entry: Entry) => (entry.kind === 'folder'
    ? [folderRow(entry, depth, files, handlers), ...(files.expanded.includes(entry.path) ? rows(entry.path, depth + 1, files, touched, handlers) : [])]
    : [fileRow(entry, depth, files, touched, handlers)]))
}

/** A picture a Markdown file names, when it is a file inside the workspace; anything else stays a link. */
function localImage(preview: Preview, handlers: Handlers) {
  const base: string[] = preview.path.split('/').slice(0, -1)
  return (src: string, alt: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return null
    const parts = [...base]
    let decoded: string
    try {
      decoded = decodeURI(src.split(/[?#]/)[0])
    } catch {
      // A malformed image address must not stop the rest of the document from rendering.
      return null
    }
    for (const part of decoded.split('/')) {
      if (part === '..') {
        if (!parts.length) return null
        parts.pop()
      } else if (part && part !== '.') parts.push(part)
    }
    const img = h('img', { class: 'file-doc-image', alt: alt || src })
    handlers.fileImage(parts.join('/')).then((url: string) => { img.src = url }, () => img.replaceWith(t("files-panel.image", { value1: alt || src })))
    return img
  }
}

/** The code as highlight.js marked it up in the main process (workspace-files.js): its text escaped, only hljs spans. */
function codeBlock(preview: Preview) {
  const code = h('code', { class: `hljs language-${preview.language}` })
  code.innerHTML = preview.html
  return h('pre', { class: 'file-text file-code' }, code)
}

function tableView(preview: Preview) {
  const { rows, more } = parseTable(preview.text, preview.name.toLowerCase().endsWith('.tsv') ? '\t' : ',')
  return h('div', { class: 'file-table-wrap' },
    h('table', { class: 'file-table' }, h('tbody', null, rows.map((row, i) => h('tr', null,
      h('th', { class: 'file-row-number', text: String(i + 1) }),
      row.map((value) => h('td', { text: value })))))),
    more ? h('p', { class: 'help', text: t("files-panel.showing.the.first.rows.switch.to.text", { MAX_ROWS: MAX_ROWS, more: more }) }) : null)
}

function tableToggle(files: Files, handlers: Handlers) {
  return h('div', { class: 'file-views', role: 'group', 'aria-label': t("files-panel.view.as") },
    [['table', t("files-panel.table")], ['text', t("files-panel.text")]].map(([mode, name]) => h('button', {
      type: 'button', class: 'file-view-btn', 'aria-pressed': String(files.view === mode), text: name, onClick: () => handlers.setTableView(mode),
    })))
}

function previewBody(files: Files, handlers: Handlers) {
  const { preview } = files
  if (preview.kind === 'markdown') return h('div', { class: 'file-doc' }, renderMarkdown(preview.text, { openLink: handlers.openLink, ...handlers, image: localImage(preview, handlers) }))
  if (preview.kind === 'code') return codeBlock(preview)
  if (preview.kind === 'csv' && files.view === 'table') return tableView(preview)
  if (preview.kind === 'text' || preview.kind === 'csv') return h('pre', { class: 'file-text', text: preview.text })
  if (preview.kind === 'image') return h('img', { class: 'file-image', src: preview.dataUrl, alt: preview.name })
  return h('p', { class: 'empty', text: t("files-panel.this.file.cannot.be.previewed.here.open") })
}

/** 打开 opens with the default app; ▾ lists every app that can, then 显示文件位置. A program only has the latter. */
function openControl(preview: Preview, files: Files, handlers: Handlers) {
  const reveal = () => handlers.revealFile(preview.path)
  if (!preview.openable) return h('button', { type: 'button', class: 'btn btn-outline btn-small', text: REVEAL, onClick: reveal })
  // Undefined while the system is still asked (the first time, it reads every app's icon).
  const listed: App[] | undefined = files.apps[preview.path]
  const apps = listed ?? []
  const preferred = apps.find((app) => app.default) ?? apps[0] ?? null
  return h('div', { class: 'open-split' },
    h('button', {
      type: 'button', class: 'btn btn-outline btn-small open-main', title: preferred ? t("files-panel.open.with", { name: preferred.name }) : t("files-panel.open.with.default.app"),
      onClick: () => handlers.openFile(preview.path, preferred?.id ?? null),
    }, preferred?.icon ? h('img', { class: 'app-icon', src: preferred.icon, alt: '' }) : null, t("files-panel.open")),
    h('button', {
      type: 'button', class: 'btn btn-outline btn-small open-more', 'aria-label': t("files-panel.choose.an.app"), 'aria-haspopup': 'menu', 'aria-expanded': String(files.menu),
      onClick: handlers.toggleOpenMenu,
    }, icon('chevron', 12)),
    files.menu ? h('div', { class: 'open-menu', role: 'menu' },
      listed ? null : h('span', { class: 'open-item open-pending', text: t("files-panel.finding.apps.that.can.open.this.file") }),
      apps.map((app) => h('button', { type: 'button', role: 'menuitem', class: 'open-item', onClick: () => handlers.openFile(preview.path, app.id) },
        app.icon ? h('img', { class: 'app-icon', src: app.icon, alt: '' }) : h('span', { class: 'app-icon' }),
        h('span', { class: 'open-name', text: app.name }),
        app.default ? h('span', { class: 'open-default', text: t("files-panel.default") }) : null)),
      h('button', { type: 'button', role: 'menuitem', class: 'open-item open-reveal', onClick: reveal }, h('span', { class: 'app-icon' }), h('span', { class: 'open-name', text: REVEAL }))) : null)
}

/** The rest of a long text: read as the preview is scrolled to its end, or with the button. */
function moreRow(files: Files, handlers: Handlers) {
  if (files.preview.nextOffset == null) return null
  return h('button', { type: 'button', class: 'btn btn-outline btn-small file-more', disabled: files.loadingMore, text: files.loadingMore ? t("extensions.loading") : t("files-panel.load.more"), onClick: handlers.loadMorePreview })
}

function previewPane(files: Files, handlers: Handlers) {
  const { preview } = files
  if (files.loading) return h('div', { class: 'file-preview' }, h('p', { class: 'empty', text: t("extensions.loading") }))
  if (!preview) return h('div', { class: 'file-preview' }, h('p', { class: 'empty', text: t("files-panel.select.a.file.to.view.its.contents") }))
  const pane = h('div', {
    class: 'file-preview', 'data-path': preview.path,
    onScroll: (event: Event) => {
      const el = event.currentTarget as HTMLElement
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

export function filesView(state: State, handlers: Handlers): HTMLElement[] {
  const { files } = state
  const top = files.folders['']
  return [h('div', { class: 'files' },
    files.error ? h('p', { class: 'form-error', role: 'alert', text: files.error }) : null,
    h('nav', { class: 'file-tree', 'aria-label': t("files-panel.workspace.files") },
      top === undefined ? h('p', { class: 'empty', text: t("extensions.loading") })
        : top.length ? rows('', 0, files, touchedPaths(state), handlers)
          : h('p', { class: 'empty', text: t("files-panel.no.files.in.this.workspace.yet") })),
    previewPane(files, handlers))]
}

onLocaleChange(() => {
  REVEAL = t("files-panel.show.file.location")
})
