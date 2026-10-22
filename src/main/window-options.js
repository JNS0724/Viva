import path from 'node:path'

/** Window chrome, size and icon per platform. Pure, so the choices can be tested on any OS. */

/** Shared by both platforms; Windows draws its caption buttons at this height too. */
export const TITLEBAR_HEIGHT = 48
const BACKGROUND = '#060B16'
const SYMBOL_COLOR = '#A3B0CC'
const TRAFFIC_LIGHT_HEIGHT = 14
const TRAFFIC_LIGHT_X = 18
const PREFERRED = { width: 1360, height: 860 }
const MINIMUM = { width: 880, height: 600 }
/** Leave some desktop around the window on small or scaled screens. */
const SCREEN_SHARE = 0.9

/**
 * macOS keeps its traffic lights on the left; Windows and Linux get system-drawn buttons on the right
 * (`titleBarOverlay`), which the page makes room for via `env(titlebar-area-width)`.
 */
/** @param {string} platform @returns {Partial<import('electron').BrowserWindowConstructorOptions>} */
export function windowChrome(platform) {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: Math.round((TITLEBAR_HEIGHT - TRAFFIC_LIGHT_HEIGHT) / 2) },
    }
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: SYMBOL_COLOR, height: TITLEBAR_HEIGHT },
  }
}

/**
 * The app's icon while it runs from the repository (`npm start`): a built app shows the icon packaged into
 * it (build/icons, see package.json), but Electron itself would show its own. macOS takes it for the Dock,
 * Windows and Linux for the window and taskbar.
 * @returns {string | null} the icon file, or null for a built app
 */
export function devIcon({ platform, packaged, appRoot }) {
  if (packaged) return null
  return path.join(appRoot, 'build', 'icons', platform === 'win32' ? 'viva.ico' : 'viva.png')
}

/**
 * The preferred size, shrunk to fit the work area (a 1080p laptop at 150% scaling has ~690px of height).
 * @param {{ width: number, height: number }} workArea
 */
export function windowSize(workArea) {
  const width = Math.min(PREFERRED.width, Math.floor(workArea.width * SCREEN_SHARE))
  const height = Math.min(PREFERRED.height, Math.floor(workArea.height * SCREEN_SHARE))
  return { width, height, minWidth: Math.min(MINIMUM.width, width), minHeight: Math.min(MINIMUM.height, height) }
}
