import { translate } from './i18n/translate.ts'
import { LOCALES } from './i18n/locale.ts'
import type { Locale } from './i18n/locale.ts'

export function continueText(item: { title: string, body: string }, locale?: Locale) {
  return `${translate('feed.continue.from', { title: item.title }, locale)}\n\n${item.body}`
}

export function extractFeedContinuationSupplement(item: { title: string, body: string }, text: string): string | null {
  for (const locale of LOCALES) {
    const original = continueText(item, locale).trim()
    if (text === original) return ''
    if (text.startsWith(`${original}\n\n`)) return text.slice(original.length + 2)
  }
  return null
}

export function matchesFeedContinuation(item: { title: string, body: string }, text: string) {
  return extractFeedContinuationSupplement(item, text) !== null
}
