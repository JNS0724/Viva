import type { ActionHandlers } from './action-types.ts'
import type { ResolvedTheme, ThemePreference } from '../shared/theme.ts'

export interface ThemeSlice {
  readonly theme: ThemePreference
  readonly resolved: ResolvedTheme
  readonly pending: ThemePreference | null
  readonly failed: boolean
}

export const initialTheme: ThemeSlice = Object.freeze({
  theme: 'dark',
  resolved: 'dark',
  pending: null,
  failed: false,
})

export const THEME_ACTIONS: ActionHandlers = {
  theme_applied: (state, { theme }) => ({
    ...state,
    theme: {
      ...state.theme,
      theme: theme.theme,
      resolved: theme.resolved,
      pending: null,
      failed: false,
    },
  }),
  /** External broadcast (e.g. OS appearance flip): preserve in-flight saves and keep save errors on resolution-only updates. */
  theme_synced: (state, { theme }) => ({
    ...state,
    theme: state.theme.pending !== null || theme.theme === state.theme.theme
      ? { ...state.theme, theme: theme.theme, resolved: theme.resolved }
      : { ...state.theme, theme: theme.theme, resolved: theme.resolved, failed: false },
  }),
  theme_saving: (state, { theme }) => ({
    ...state,
    theme: { ...state.theme, pending: theme, failed: false },
  }),
  theme_failed: (state) => ({
    ...state,
    theme: { ...state.theme, pending: null, failed: true },
  }),
}
