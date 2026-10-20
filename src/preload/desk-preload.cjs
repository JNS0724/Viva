const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * The desktop island's page (desk.js) hears what to show and says what was clicked, where the island is,
 * and what the user asks with which dropped files. Dropped files are known to it only by their paths.
 */
contextBridge.exposeInMainWorld('desk', {
  onView: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('island:view', listener)
    return () => ipcRenderer.removeListener('island:view', listener)
  },
  act: (action) => ipcRenderer.send('island:act', action),
  /** @param {File[]} files from a drop @returns {Promise<{ files?: object[], error?: string }>} */
  describeFiles: (files) => ipcRenderer.invoke('island:files', Array.from(files, (file) => webUtils.getPathForFile(file))),
  ask: (text, files) => ipcRenderer.invoke('island:ask', { text, files }),
})
