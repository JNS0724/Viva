import { translate } from './i18n/translate.ts'
import { LOCALES } from './i18n/locale.ts'
import type { Locale } from './i18n/locale.ts'

export function continueText(item: { title: string, body: string }, locale?: Locale) {
  return `${translate('feed.continue.from', { title: item.title }, locale)}\n\n${item.body}`
}

export function matchesFeedContinuation(item: { title: string, body: string }, text: string) {
  return LOCALES.some(locale => {
    const original = continueText(item, locale).trim()
    return text === original || text.startsWith(`${original}\n\n`)
  })
}
