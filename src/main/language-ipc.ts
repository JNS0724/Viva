import type { IpcRegistry } from './ipc-contract.ts'
import { resolveLocale, setLocale, type Language, type LanguageState } from '../shared/i18n/locale.ts'

export function registerLanguageIpc(ipcMain: IpcRegistry, deps: {
  getLanguage: () => Language
  saveLanguage: (language: Language) => void
  systemLocale: () => string
  broadcast: (state: LanguageState) => void
  refreshNative: () => void
}): void {
  const snapshot = (): LanguageState => ({ language: deps.getLanguage(), locale: resolveLocale(deps.getLanguage(), deps.systemLocale()) })
  setLocale(snapshot().locale)
  ipcMain.handle('language:get', snapshot)
  ipcMain.handle('language:set', (_event, language) => {
    deps.saveLanguage(language)
    const state = snapshot()
    setLocale(state.locale)
    deps.refreshNative()
    deps.broadcast(state)
    return state
  })
}
