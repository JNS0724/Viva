import { t } from '../shared/i18n/translate.ts'
/**
 * Links in the agent's answers open outside the app. The window asks; this side decides, whatever the
 * page sent: only web and mail addresses, never file:, javascript: or an app's custom scheme.
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const MAX_URL_CHARS = 4000

/** The address to hand to the OS. */
export function externalUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) throw new Error(t("main.links.invalid.link"))
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(t("main.links.invalid.link"))
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) throw new Error(t("main.links.this.link.type.is.not.opened", { protocol: url.protocol }))
  return url.href
}
