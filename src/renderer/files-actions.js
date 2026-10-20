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

  async function preview(path) {
    try {
      dispatch({ type: 'files_previewed', preview: await api.previewFile(path) })
    } catch (err) {
      fail(err)
    }
  }

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
    },
    revealFile: (path) => api.revealFile(path).catch(fail),
    openFile: (path) => api.openFile(path).catch(fail),
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
