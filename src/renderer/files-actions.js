/**
 * What the 文件 tab does (files-state.js holds what it shows): read folders as they are opened, preview the
 * picked file, show it in the system's file manager or open it with its app. All through the main process,
 * which keeps every path inside the workspace (src/main/workspace-files.js).
 */
export function createFilesActions({ api, getState, dispatch, errorMessage }) {
  const fail = (err) => dispatch({ type: 'files_failed', message: errorMessage(err) })

  async function list(path) {
    try {
      const folder = await api.listFiles(path)
      dispatch({ type: 'files_listed', path, entries: folder.entries })
    } catch (err) {
      fail(err)
    }
  }

  async function preview(path, offset = 0) {
    try {
      dispatch({ type: 'files_previewed', preview: await api.previewFile(path, offset) })
    } catch (err) {
      fail(err)
    }
  }

  async function loadApps(path) {
    if (getState().files.apps[path]) return
    try {
      dispatch({ type: 'files_apps', path, apps: await api.fileApps(path) })
    } catch (err) {
      fail(err)
    }
  }

  /** Images in a Markdown preview, read once each while the app runs. */
  const images = new Map()

  /** The top folder and every open one that has not been read yet. */
  function loadFiles() {
    const { files } = getState()
    for (const path of ['', ...files.expanded]) if (!files.folders[path]) list(path)
  }

  return {
    loadFiles,
    toggleFolder(path) {
      dispatch({ type: 'files_toggled', path })
      const { files } = getState()
      if (files.expanded.includes(path) && !files.folders[path]) list(path)
    },
    selectFile(path) {
      dispatch({ type: 'files_selected', path })
      preview(path)
      loadApps(path)
      api.watchFile(path).catch(fail)
    },
    /** The next page of a long text, when the preview is scrolled to its end. */
    loadMorePreview() {
      const { preview: shown, loadingMore } = getState().files
      if (!shown || shown.nextOffset == null || loadingMore) return
      dispatch({ type: 'files_more' })
      preview(shown.path, shown.nextOffset)
    },
    /** The file on preview changed on disk: read it again from the start. */
    onFilesChanged({ path }) {
      if (getState().files.selected === path) preview(path)
    },
    revealFile(path) {
      dispatch({ type: 'files_menu', open: false })
      api.revealFile(path).catch(fail)
    },
    /** With `app` (one of the file's apps) or, without, the system's default. */
    openFile(path, app = null) {
      dispatch({ type: 'files_menu', open: false })
      api.openFile(path, app).catch(fail)
    },
    toggleOpenMenu: () => dispatch({ type: 'files_menu', open: !getState().files.menu }),
    setTableView: (mode) => dispatch({ type: 'files_view', mode }),
    /** @returns {Promise<string>} a data URL for a picture inside the workspace */
    fileImage(path) {
      if (!images.has(path)) images.set(path, api.fileImage(path).catch((err) => { images.delete(path); throw err }))
      return images.get(path)
    },
    /** After a turn the agent may have written: read again what is on screen, the preview included. */
    filesAfterTurn() {
      dispatch({ type: 'files_stale' })
      const { files, drawer } = getState()
      if (drawer !== 'files') return
      loadFiles()
      if (files.selected) preview(files.selected)
    },
  }
}
