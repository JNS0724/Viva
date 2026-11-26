import path from 'node:path'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { ResolvedTheme } from '../shared/theme.ts'

/** Window chrome, size and icon per platform. Pure, so the choices can be tested on any OS. */

/**
 * Shared by both platforms; Windows draws its caption buttons at this height too. Room for the vertical
 * title-bar badge (46px portrait anchored 12px from the top + tucked status chin) strictly inside: keep
 * in step with styles.css --titlebar-h.
 */
export const TITLEBAR_HEIGHT = 72
const CHROME_PALETTE: Readonly<Record<ResolvedTheme, Readonly<{ background: string, symbolColor: string }>>> = Object.freeze({
  dark: Object.freeze({ background: '#060B16', symbolColor: '#A3B0CC' }),
  light: Object.freeze({ background: '#F2F5FA', symbolColor: '#3B4C68' }),
})
const TRAFFIC_LIGHT_HEIGHT = 14
const TRAFFIC_LIGHT_X = 18
const PREFERRED = { width: 1360, height: 860 }
const MINIMUM = { width: 880, height: 600 }
/** Leave some desktop around the window on small or scaled screens. */
const SCREEN_SHARE = 0.9

export const windowBackground = (theme: ResolvedTheme = 'dark'): string => CHROME_PALETTE[theme].background

export const titleBarOverlay = (theme: ResolvedTheme = 'dark') => ({
  color: CHROME_PALETTE[theme].background,
  symbolColor: CHROME_PALETTE[theme].symbolColor,
  height: TITLEBAR_HEIGHT,
})

/**
 * macOS keeps its traffic lights on the left; Windows and Linux get system-drawn buttons on the right
 * (`titleBarOverlay`), which the page makes room for via `env(titlebar-area-width)`.
 */
export function windowChrome(platform: string, theme: ResolvedTheme = 'dark'): Partial<BrowserWindowConstructorOptions> {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: Math.round((TITLEBAR_HEIGHT - TRAFFIC_LIGHT_HEIGHT) / 2) },
    }
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(theme),
  }
}

/**
 * The app's icon while it runs from the repository (`npm start`): a built app shows the icon packaged into
 * it (build/icons, see package.json), but Electron itself would show its own. macOS takes it for the Dock,
 * Windows and Linux for the window and taskbar.
 * @returns the icon file, or null for a built app
 */
export function devIcon({ platform, packaged, appRoot }: { platform: string, packaged: boolean, appRoot: string }): string | null {
  if (packaged) return null
  return path.join(appRoot, 'build', 'icons', platform === 'win32' ? 'viva.ico' : 'viva.png')
}

/** The preferred size, shrunk to fit the work area (a 1080p laptop at 150% scaling has ~690px of height). */
export function windowSize(workArea: { width: number, height: number }) {
  const width = Math.min(PREFERRED.width, Math.floor(workArea.width * SCREEN_SHARE))
  const height = Math.min(PREFERRED.height, Math.floor(workArea.height * SCREEN_SHARE))
  return { width, height, minWidth: Math.min(MINIMUM.width, width), minHeight: Math.min(MINIMUM.height, height) }
}
