/**
 * The desktop island's right-click menu: on a computer the place to look for what else something can do.
 * Built as a template so it can be checked without Electron; island-main.js turns it into a menu.
 *
 * @param {{
 *   working: boolean, shortcut: string,
 *   ask: () => void, open: () => void, stop: () => void, resetPlace: () => void, hide: () => void, switchOff: () => void,
 * }} deps shortcut: the ask shortcut, shown beside 提问… (it is registered elsewhere, as a global shortcut);
 *   hide: until the window is next closed to the tray; switchOff: for good, as the switch in settings
 * @returns {object[]} a template for Menu.buildFromTemplate
 */
export function deskMenuTemplate({ working, shortcut, ask, open, stop, resetPlace, hide, switchOff }) {
  return [
    { label: '提问…', accelerator: shortcut, registerAccelerator: false, click: ask },
    { label: '打开 Viva 窗口', click: open },
    { label: '停止', enabled: working, click: stop },
    { type: 'separator' },
    { label: '放回顶部正中', click: resetPlace },
    { label: '先隐藏（下次关闭窗口时再出现）', click: hide },
    { label: '不再显示桌面岛（可在设置里打开）', click: switchOff },
  ]
}
