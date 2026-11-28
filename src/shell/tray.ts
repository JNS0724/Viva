import { t } from '../shared/i18n/translate.ts'
import path from 'node:path'
import type { Menu as ElectronMenu, NativeImage, Tray as ElectronTray } from 'electron'

/**
 * The tray icon (the menu bar on macOS, the notification area on Windows): there from the first time the
 * window is closed (or from launch on Windows and when Viva starts with the computer), since closing the window keeps Viva
 * running there. Clicking it, or 打开 Viva in its menu, brings the window back; 退出 Viva quits.
 */
const TOOLTIP = 'Viva'

/** macOS takes a black template image and colours it to suit the menu bar; Windows shows the app icon. */
const iconFile = (platform: string) => (platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')

/** Electron's Tray, Menu and nativeImage, handed in so the tray can be tested without Electron. */
interface TrayDeps {
  Tray: new (image: NativeImage) => Pick<ElectronTray, 'setToolTip' | 'setContextMenu' | 'on' | 'destroy'> & Partial<Pick<ElectronTray, 'setTitle'>>
  Menu: Pick<typeof ElectronMenu, 'buildFromTemplate'>
  nativeImage: { createFromPath: (file: string) => Pick<NativeImage, 'setTemplateImage'> }
  iconDir: string
  platform: string
  onOpen: () => void
  onQuit: () => void
  onDiagnosticsExport?: () => void
  onDiagnosticsOpen?: () => void
  onDiagnosticsClear?: () => void
  onDiagnosticsDebug?: () => void
  onDiagnosticsDebugStop?: () => void
}

export function createTray({ Tray, Menu, nativeImage, iconDir, platform, onOpen, onQuit, onDiagnosticsExport, onDiagnosticsOpen, onDiagnosticsClear, onDiagnosticsDebug, onDiagnosticsDebugStop }: TrayDeps): {
  destroy: () => void, refresh: () => void,
} {
  const image = nativeImage.createFromPath(path.join(iconDir, iconFile(platform)))
  if (platform === 'darwin') image.setTemplateImage(true)
  const tray = new Tray(image as NativeImage)

  function refresh() {
    tray.setToolTip(TOOLTIP)
    if (platform === 'darwin') tray.setTitle?.('')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: t('native.open'), click: onOpen },
      ...(onDiagnosticsExport ? [{ id: 'viva-diagnostics-export', label: t('diagnostics.export'), click: onDiagnosticsExport }] : []),
      ...(onDiagnosticsOpen ? [{ id: 'viva-diagnostics-open', label: t('diagnostics.open'), click: onDiagnosticsOpen }] : []),
      ...(onDiagnosticsClear ? [{ id: 'viva-diagnostics-clear', label: t('diagnostics.clear'), click: onDiagnosticsClear }] : []),
      ...(onDiagnosticsDebug ? [{ id: 'viva-diagnostics-debug', label: t('diagnostics.debug'), click: onDiagnosticsDebug }] : []),
      ...(onDiagnosticsDebugStop ? [{ id: 'viva-diagnostics-debug-stop', label: t('diagnostics.debug.stop'), click: onDiagnosticsDebugStop }] : []),
      { type: 'separator' },
      { label: t('native.quit'), click: onQuit },
    ]))
  }

  refresh()
  // On Windows a click opens the window and the menu is on the right button; on macOS a click shows the menu.
  if (platform !== 'darwin') tray.on('click', onOpen)
  return { destroy: () => tray.destroy(), refresh }
}
