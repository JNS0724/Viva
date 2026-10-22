const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * The desktop island's page (desk.js) hears what to show and says what was clicked, where the island is,
 * and what the user asks with which dropped files. Dropped files are known to it only by their paths.
 */
contextBridge.exposeInMainWorld('desk', /** @satisfies {DeskApi} */ ({
  onView: (callback) => {
    const listener = (/** @type {Electron.IpcRendererEvent} */ _event, /** @type {unknown} */ payload) => callback(payload)
    ipcRenderer.on('island:view', listener)
    return () => ipcRenderer.removeListener('island:view', listener)
  },
  act: (action) => ipcRenderer.send('island:act', action),
  /** The files of a drop, by their paths: what they are, or why they cannot be handed over. */
  describeFiles: (files) => ipcRenderer.invoke('island:files', Array.from(files, (file) => webUtils.getPathForFile(file))),
  ask: (text, files, images = []) => ipcRenderer.invoke('island:ask', { text, files, images }),
  /** A picture pasted into the island's input, into the pictures folder: { id, mimeType, size } (main/image-ipc.js). */
  keepImage: (bytes) => ipcRenderer.invoke('island:keep-image', bytes),
  /** The ask shortcut as the user presses it (island-main.js ASK_SHORTCUT). */
  shortcut: process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space',
}))
