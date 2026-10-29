import { getLocale, type Locale } from './locale.ts'
import { en, type MessageKey } from './messages/en.ts'
import { zhCN } from './messages/zh-CN.ts'

type Slots<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? (Name extends `${string} ${string}` ? never : Name) | Slots<Rest> : never
type Values<K extends MessageKey> = Record<Slots<(typeof en)[K]>, string | number>
const reported = new Set<string>()
/** Diagnostics contain catalog keys only, never interpolation values or user content. */
function missing(key: string): void {
  if (reported.has(key)) return
  reported.add(key)
  console.warn('[i18n] Missing message:', key)
}
export function t<K extends MessageKey>(key: K, ...args: Slots<(typeof en)[K]> extends never ? [values?: Values<K>] : [values: Values<K>]): string {
  return translate(key, args[0])
}
export function translate(key: string, values: Readonly<Record<string, string | number>> = {}, locale: Locale = getLocale()): string {
  const source = locale === 'zh-CN' ? zhCN : en
  if (!Object.hasOwn(source, key)) missing(key)
  let template: string = Object.hasOwn(source, key) ? source[key as MessageKey] : Object.hasOwn(en, key) ? en[key as MessageKey] : en['errors.generic']
  // Only catalog-authored count phrases are inflected, before inserting any user text.
  if (locale === 'en') template = template.replace(/\{(\w+)\} (messages|minutes|hours|days|files|tasks|items|seconds|reminders|images)\b/g, (phrase, name: string, noun: string) =>
    typeof values[name] === 'number' && new Intl.PluralRules('en').select(values[name]) === 'one' ? `{${name}} ${noun.slice(0, -1)}` : phrase)
  return template.replace(/\{(\w+)\}/g, (slot, name: string) => Object.hasOwn(values, name) ? String(values[name]) : slot)
}
