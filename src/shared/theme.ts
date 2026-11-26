export type ThemePreference = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'
export interface ThemeState { theme: ThemePreference; resolved: ResolvedTheme }

export const THEMES: readonly ThemePreference[] = Object.freeze(['system', 'dark', 'light'])

export const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'dark' || value === 'light'

/** Resolve the active colour scheme for a preference and OS dark-mode flag. */
export function resolveTheme(theme: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (theme === 'dark' || theme === 'light') return theme
  return systemDark ? 'dark' : 'light'
}
