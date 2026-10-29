import { getLocale } from './locale.ts'
export const formatDate = (date: number | Date, options: Intl.DateTimeFormatOptions = {}): string => new Intl.DateTimeFormat(getLocale(), options).format(date)
export const formatNumber = (value: number): string => new Intl.NumberFormat(getLocale()).format(value)
export const relativeTime = (value: number, unit: Intl.RelativeTimeFormatUnit): string => new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(value, unit)
export const plural = (value: number): Intl.LDMLPluralRule => new Intl.PluralRules(getLocale()).select(value)
/** Calendar days, independent of daylight saving transitions. */
export function calendarDays(from: number, to: number): number {
  const day = (ts: number) => { const d = new Date(ts); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) }
  return Math.round((day(to) - day(from)) / 86_400_000)
}
