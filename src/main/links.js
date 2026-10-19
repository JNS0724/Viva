/**
 * Links in the agent's answers open outside the app. The window asks; this side decides, whatever the
 * page sent: only web and mail addresses, never file:, javascript: or an app's custom scheme.
 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const MAX_URL_CHARS = 4000

/**
 * @param {unknown} value
 * @returns {string} the address to hand to the OS
 */
export function externalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) throw new Error('链接无效')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('链接无效')
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) throw new Error(`不打开这类链接：${url.protocol}`)
  return url.href
}
