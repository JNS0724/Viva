import { t } from '../shared/i18n/translate.ts'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * The desktop island's right-click menu: kept minimal to window-level actions not directly reachable from the
 * portrait itself (open the main window or turn off the desktop island). Built as a template so it can be
 * checked without Electron; island-main.ts turns it into a menu.
 */
export function deskMenuTemplate({ open, switchOff, preview }: {
  open: () => void, switchOff: () => void,
  preview?: MenuItemConstructorOptions,
}): MenuItemConstructorOptions[] {
  return [
    { label: t('native.openWindow'), click: open },
    { label: t('native.disableIsland'), click: switchOff },
    ...(preview ? [{ type: 'separator' } as const, preview] : []),
  ]
}
