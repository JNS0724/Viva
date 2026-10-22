import { fileItems } from './selectors.ts'

/**
 * The 文件 tab: the workspace's folders as they were read (by workspace path, '' for the top), which are
 * open, and the file shown below them. Folders are read again after a turn, since the agent may have
 * written; what is open and selected stays.
 */
export const initialFiles = Object.freeze({
  folders: {},
  expanded: [],
  selected: null,
  preview: null,
  /** The path whose preview is on its way. */
  loading: null,
  /** The next page of the preview is on its way. */
  loadingMore: false,
  /** The apps that open each file (files:apps), by workspace path. */
  apps: {},
  /** The 打开 menu is open. */
  menu: false,
  /** A CSV or TSV file as a table, or as its text. */
  view: 'table',
  error: null,
})

/** A page after the first joins the preview; the first page of the file (read again) replaces it. */
function withPage(current, page) {
  if (page.offset === 0 || !current) return page
  if (page.offset !== current.nextOffset) return current
  return {
    ...current,
    text: current.text + page.text,
    ...(current.html !== undefined ? { html: current.html + (page.html ?? '') } : {}),
    nextOffset: page.nextOffset,
  }
}

const withFiles = (state, changes) => ({ ...state, files: { ...state.files, ...changes } })

export const FILES_ACTIONS: Record<string, Reducer> = {
  files_listed: (state, { path, entries }) => withFiles(state, { folders: { ...state.files.folders, [path]: entries }, error: null }),
  files_toggled: (state, { path }) => withFiles(state, {
    expanded: state.files.expanded.includes(path) ? state.files.expanded.filter((item) => item !== path) : [...state.files.expanded, path],
  }),
  files_selected: (state, { path }) => withFiles(state, { selected: path, preview: null, loading: path, error: null, menu: false, view: 'table' }),
  files_previewed: (state, { preview }) => (preview.path === state.files.selected
    ? withFiles(state, { preview: withPage(state.files.preview, preview), loading: null, loadingMore: false })
    : state),
  files_more: (state) => withFiles(state, { loadingMore: true }),
  files_apps: (state, { path, apps }) => withFiles(state, { apps: { ...state.files.apps, [path]: apps } }),
  files_menu: (state, { open }) => withFiles(state, { menu: open }),
  files_view: (state, { mode }) => withFiles(state, { view: mode }),
  files_failed: (state, { message }) => withFiles(state, { error: message, loading: null, loadingMore: false }),
  files_stale: (state) => withFiles(state, { folders: {} }),
}

const slashes = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')

/** The files the agent touched in this conversation, as workspace paths (what the tree is keyed by). */
export function touchedPaths(state) {
  const root = `${slashes(state.info.cwd)}/`
  return new Set(fileItems(state)
    .map((item) => slashes(item.path))
    .filter((path) => root.length > 1 && path.startsWith(root))
    .map((path) => path.slice(root.length)))
}
