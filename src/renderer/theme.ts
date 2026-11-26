import type { ResolvedTheme, ThemeState } from '../shared/theme.ts'

export interface ThemeReadApi {
  getTheme: () => Promise<ThemeState>
  onTheme: (callback: (state: ThemeState) => void) => () => void
}

let currentResolved: ResolvedTheme = 'dark'
const extraDocuments = new Set<Document>()

function applyTo(doc: Document, resolved: ResolvedTheme): void {
  doc.documentElement.dataset.theme = resolved
}

/** Sync the resolved theme attribute on the host document and every registered child document (e.g. search iframe). */
export function applyThemeDocument(resolved: ResolvedTheme): void {
  currentResolved = resolved
  if (typeof document !== 'undefined') applyTo(document, resolved)
  for (const doc of extraDocuments) applyTo(doc, resolved)
}

/** The isolated search field shares colour scheme with its parent window. */
export function registerThemeDocument(doc: Document): void {
  if (extraDocuments.has(doc)) return
  extraDocuments.add(doc)
  applyTo(doc, currentResolved)
}

/** Read-only theme initialization for the desktop island window, which never writes preferences. */
export async function initializeDeskTheme(api: Partial<ThemeReadApi> | null | undefined): Promise<void> {
  if (!api?.getTheme || !api?.onTheme) return
  let received = false
  api.onTheme((next) => {
    received = true
    applyThemeDocument(next.resolved)
  })
  const initial = await api.getTheme()
  if (!received) applyThemeDocument(initial.resolved)
}

/** Reset registered documents between unit tests. */
export function resetThemeDocumentsForTest(): void {
  currentResolved = 'dark'
  extraDocuments.clear()
}
