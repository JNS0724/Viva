const { contextBridge, ipcRenderer } = require('electron')

/** The desktop island's page (desk.js) only hears what to show and says what was clicked. */
contextBridge.exposeInMainWorld('desk', {
  onView: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('island:view', listener)
    return () => ipcRenderer.removeListener('island:view', listener)
  },
  act: (action) => ipcRenderer.send('island:act', action),
})
