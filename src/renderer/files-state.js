import { fileItems } from './selectors.js'

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
  error: null,
})

const withFiles = (state, changes) => ({ ...state, files: { ...state.files, ...changes } })

export const FILES_ACTIONS = {
  files_listed: (state, { path, entries }) => withFiles(state, { folders: { ...state.files.folders, [path]: entries }, error: null }),
  files_toggled: (state, { path }) => withFiles(state, {
    expanded: state.files.expanded.includes(path) ? state.files.expanded.filter((item) => item !== path) : [...state.files.expanded, path],
  }),
  files_selected: (state, { path }) => withFiles(state, { selected: path, preview: null, loading: path, error: null }),
  files_previewed: (state, { preview }) => (preview.path === state.files.selected ? withFiles(state, { preview, loading: null }) : state),
  files_failed: (state, { message }) => withFiles(state, { error: message, loading: null }),
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
