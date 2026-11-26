import type { ResolvedTheme, ThemePreference, ThemeState } from '../shared/theme.ts'

export interface ThemeActionApi {
  getTheme: () => Promise<ThemeState>
  setTheme: (theme: ThemePreference) => Promise<ThemeState>
  onTheme: (callback: (state: ThemeState) => void) => () => void
}

export function createThemeActions({
  api,
  getState,
  dispatch,
  seed = dispatch,
  applyDocument,
  isFocused = () => false,
  canRestoreFocus = () => false,
  focusControl = () => {},
}: Pick<ActionDeps, 'getState' | 'dispatch'> & {
  api: ThemeActionApi
  /** Startup state updater that avoids publishing island/draft targets before conversation identity is known. */
  seed?: ActionDeps['dispatch']
  applyDocument: (resolved: ResolvedTheme) => void
  isFocused?: () => boolean
  canRestoreFocus?: () => boolean
  focusControl?: () => void
}) {
  let saving = false
  let ready = false

  async function initialize(): Promise<void> {
    let received = false
    api.onTheme((next) => {
      received = true
      applyDocument(next.resolved)
      const current = getState().theme
      const resolvedOnly = next.theme === current.theme
      const emit = ready && !resolvedOnly ? dispatch : seed
      emit({ type: 'theme_synced', theme: next })
    })
    try {
      const initial = await api.getTheme()
      if (!received) {
        applyDocument(initial.resolved)
        seed({ type: 'theme_applied', theme: initial })
      }
    } finally {
      ready = true
    }
  }

  async function setTheme(next: ThemePreference): Promise<void> {
    const current = getState().theme
    if (saving || current.pending !== null || next === current.theme) return
    const startedFocused = isFocused()
    saving = true
    dispatch({ type: 'theme_saving', theme: next })
    let shouldRestore = false
    try {
      const updated = await api.setTheme(next)
      // Decide before the completion redraw so focus moved to another button is never mistaken for dropped focus.
      shouldRestore = startedFocused && canRestoreFocus()
      applyDocument(updated.resolved)
      dispatch({ type: 'theme_applied', theme: updated })
    } catch {
      shouldRestore = startedFocused && canRestoreFocus()
      dispatch({ type: 'theme_failed' })
    } finally {
      saving = false
    }
    if (shouldRestore) focusControl()
  }

  return { initialize, setTheme }
}
