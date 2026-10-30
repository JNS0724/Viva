import { t } from '../shared/i18n/translate.ts'
import path from 'node:path'
import type { Menu as ElectronMenu, NativeImage, Tray as ElectronTray } from 'electron'

/**
 * The tray icon (the menu bar on macOS, the notification area on Windows): there from the first time the
 * window is closed (or from launch, when Viva starts with the computer), since closing the window keeps Viva
 * running there. Clicking it, or 打开 Viva in its menu, brings the window back; 退出 Viva quits. When follow-ups
 * are ready, the tray says how many (beside the icon on macOS, in the tooltip on Windows), and the menu leads to
 * them.
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
  /** 「N 件等你看」: the 后台 page. */
  onPending?: () => void
  /** How many follow-ups are ready, at the start. */
  pending?: number
}

export function createTray({ Tray, Menu, nativeImage, iconDir, platform, onOpen, onQuit, onPending = onOpen, pending = 0 }: TrayDeps): {
  destroy: () => void, setPending: (count: number) => void,
} {
  const image = nativeImage.createFromPath(path.join(iconDir, iconFile(platform)))
  if (platform === 'darwin') image.setTemplateImage(true)
  const tray = new Tray(image as NativeImage)

  function setPending(count: number) {
    tray.setToolTip(count ? `${TOOLTIP} · ${t('native.pending', { count })}` : TOOLTIP)
    if (platform === 'darwin') tray.setTitle?.(count ? String(count) : '')
    tray.setContextMenu(Menu.buildFromTemplate([
      ...(count ? [{ label: t('native.pending', { count }), click: onPending }, { type: 'separator' as const }] : []),
      { label: t('native.open'), click: onOpen },
      { type: 'separator' },
      { label: t('native.quit'), click: onQuit },
    ]))
  }

  setPending(pending)
  // On Windows a click opens the window and the menu is on the right button; on macOS a click shows the menu.
  if (platform !== 'darwin') tray.on('click', onOpen)
  return { destroy: () => tray.destroy(), setPending }
}
