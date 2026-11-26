import type { IpcRegistry } from '../shared/ipc-contract.ts'
import { resolveTheme, type ResolvedTheme, type ThemePreference, type ThemeState } from '../shared/theme.ts'

export interface ThemeIpcDeps {
  getTheme: () => ThemePreference
  saveTheme: (theme: ThemePreference) => Promise<unknown> | void
  systemDark: () => boolean
  syncNative: (theme: ThemePreference) => void
  applyWindow: (state: ThemeState) => void
  broadcast: (state: ThemeState) => void
  onSystemThemeChange?: (listener: () => void) => () => void
}

/**
 * Shell-owned theme IPC (`theme:get`, `theme:set`) and OS appearance subscription.
 * Keeps Electron's nativeTheme, window chrome/background, and every open page in step.
 */
export function registerThemeIpc(ipcMain: IpcRegistry, deps: ThemeIpcDeps): {
  current: () => ThemeState
  dispose: () => void
} {
  const snapshot = (): ThemeState => {
    const theme = deps.getTheme()
    return { theme, resolved: resolveTheme(theme, deps.systemDark()) }
  }

  deps.syncNative(deps.getTheme())
  const initial = snapshot()
  let lastResolved: ResolvedTheme = initial.resolved
  deps.applyWindow(initial)

  ipcMain.handle('theme:get', () => snapshot())
  ipcMain.handle('theme:set', async (_event, theme) => {
    await deps.saveTheme(theme)
    deps.syncNative(theme)
    const state = snapshot()
    lastResolved = state.resolved
    deps.applyWindow(state)
    deps.broadcast(state)
    return state
  })

  const dispose = deps.onSystemThemeChange?.(() => {
    if (deps.getTheme() !== 'system') return
    const state = snapshot()
    if (state.resolved === lastResolved) return
    lastResolved = state.resolved
    deps.applyWindow(state)
    deps.broadcast(state)
  }) ?? (() => {})

  return { current: snapshot, dispose }
}
