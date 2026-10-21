import path from 'node:path'

/**
 * The tray icon (the menu bar on macOS, the notification area on Windows): there from the first time the
 * window is closed, since closing the window keeps Viva running there. Clicking it, or 打开 Viva in its
 * menu, brings the window back; 退出 Viva quits.
 */
const TOOLTIP = 'Viva'

/** macOS takes a black template image and colours it to suit the menu bar; Windows shows the app icon. */
const iconFile = (platform) => (platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')

/**
 * @param {{ Tray: Function, Menu: object, nativeImage: object, iconDir: string, platform: string, onOpen: () => void, onQuit: () => void }} deps
 * @returns {{ destroy: () => void }}
 */
export function createTray({ Tray, Menu, nativeImage, iconDir, platform, onOpen, onQuit }) {
  const image = nativeImage.createFromPath(path.join(iconDir, iconFile(platform)))
  if (platform === 'darwin') image.setTemplateImage(true)
  const tray = new Tray(image)
  tray.setToolTip(TOOLTIP)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Viva', click: onOpen },
    { type: 'separator' },
    { label: '退出 Viva', click: onQuit },
  ]))
  // On Windows a click opens the window and the menu is on the right button; on macOS a click shows the menu.
  if (platform !== 'darwin') tray.on('click', onOpen)
  return { destroy: () => tray.destroy() }
}
