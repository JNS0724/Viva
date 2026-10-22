import path from 'node:path'
import type { Menu as ElectronMenu, NativeImage, Tray as ElectronTray } from 'electron'

/**
 * The tray icon (the menu bar on macOS, the notification area on Windows): there from the first time the
 * window is closed, since closing the window keeps Viva running there. Clicking it, or 打开 Viva in its
 * menu, brings the window back; 退出 Viva quits.
 */
const TOOLTIP = 'Viva'

/** macOS takes a black template image and colours it to suit the menu bar; Windows shows the app icon. */
const iconFile = (platform: string) => (platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')

/** Electron's Tray, Menu and nativeImage, handed in so the tray can be tested without Electron. */
interface TrayDeps {
  Tray: new (image: NativeImage) => Pick<ElectronTray, 'setToolTip' | 'setContextMenu' | 'on' | 'destroy'>
  Menu: Pick<typeof ElectronMenu, 'buildFromTemplate'>
  nativeImage: { createFromPath: (file: string) => Pick<NativeImage, 'setTemplateImage'> }
  iconDir: string
  platform: string
  onOpen: () => void
  onQuit: () => void
}

export function createTray({ Tray, Menu, nativeImage, iconDir, platform, onOpen, onQuit }: TrayDeps): { destroy: () => void } {
  const image = nativeImage.createFromPath(path.join(iconDir, iconFile(platform)))
  if (platform === 'darwin') image.setTemplateImage(true)
  const tray = new Tray(image as NativeImage)
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
