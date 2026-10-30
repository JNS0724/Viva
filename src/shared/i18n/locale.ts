export type Locale = 'zh-CN' | 'en'
export type Language = Locale | 'system'
export interface LanguageState { language: Language; locale: Locale }

export function isLanguage(value: unknown): value is Language {
  return value === 'system' || value === 'zh-CN' || value === 'en'
}

export function resolveLocale(language: Language, system: string): Locale {
  if (language !== 'system') return language
  const tag = system.replaceAll('_', '-').toLowerCase()
  if (/^zh-hant(?:-|$)|^zh-(?:tw|hk|mo)(?:-|$)/.test(tag)) return 'en'
  return /^zh(?:$|-(?:cn|sg|hans)(?:-|$))/.test(tag) ? 'zh-CN' : 'en'
}

let current: Locale = 'zh-CN'
let revision = 0
const listeners = new Set<() => void>()
export const getLocale = (): Locale => current
export const localeRevision = (): number => revision
export function setLocale(locale: Locale): void {
  if (locale === current) return
  current = locale
  revision++
  for (const listener of listeners) listener()
}
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
