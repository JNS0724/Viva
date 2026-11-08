import { t } from '../shared/i18n/translate.ts'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * The desktop island's right-click menu: on a computer the place to look for what else something can do.
 * Built as a template so it can be checked without Electron; island-main.js turns it into a menu.
 *
 * shortcut: the ask shortcut, shown beside 提问… (it is registered elsewhere, as a global shortcut);
 * hide: until the window is next closed to the tray; switchOff: for good, as the switch in settings.
 */
export function deskMenuTemplate({ working, shortcut, ask, open, stop, resetPlace, hide, switchOff, placeAt }: {
  working: boolean, shortcut: string,
  ask: () => void, open: () => void, stop: () => void, resetPlace: () => void, hide: () => void, switchOff: () => void,
  placeAt?: (corner: string) => void,
}): MenuItemConstructorOptions[] {
  return [
    { label: t('native.ask'), accelerator: shortcut, registerAccelerator: false, click: ask },
    { label: t('native.openWindow'), click: open },
    { label: t('native.stop'), enabled: working, click: stop },
    { type: 'separator' },
    { label: t('native.resetIsland'), click: resetPlace },
    ...(placeAt ? [{ label: t('desk.interaction.positions'), submenu: ([
      ['left-top', 'desk.interaction.left.top'], ['right-top', 'desk.interaction.right.top'],
      ['left-bottom', 'desk.interaction.left.bottom'], ['right-bottom', 'desk.interaction.right.bottom'],
    ] as const).map(([corner, label]) => ({ label: t(label), click: () => placeAt(corner) })) }] : []),
    { label: t('native.hideIsland'), click: hide },
    { label: t('native.disableIsland'), click: switchOff },
  ]
}
