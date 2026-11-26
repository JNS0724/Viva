import { MAX_MEMORY_CHARS } from './text-limits.ts'
export { MAX_MEMORY_CHARS } from './text-limits.ts'

const KNOWN_CREDENTIAL = /(?:^|[^\p{L}\p{N}])(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_])/u

/**
 * Things that must never be kept or sent to the model: keys, passwords, codes, ID numbers.
 * Mentions of the topic ("密码每 90 天更换") are fine; only a value being handed over is refused.
 */
const SECRET_PATTERNS = [
  KNOWN_CREDENTIAL,
  /(密码|口令|\b(?:password|passwd|pwd)\b)\s*(?:是|为|[:：=]|\bis\b)\s*\S/iu,
  /(?:验证码|动态码|(?<![A-Za-z])(?:otp|totp|hotp))\s*(?:(?:是|为|[:：=]|\bis\b)\s*)?\d(?:[ \t-]{0,3}\d){3}/iu,
  /\b(token|secret|api[_ -]?key|access[_ -]?key)\s*[:：=]\s*\S{6,}/i,
  /\b(?:proxy[-_ ]?)?authorization\s*[:：=]\s*(?:bearer|basic)\s+\S+/iu,
  /\b\d{17}[\dXx]\b/,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/,
]

const LINKS = /https?:\/\/[^\s<>"'，。！？；）】]+/giu
const URL_KEY = /^(?:token|(?:access|refresh|id|session|security)[_-]?token|key|api[_-]?key|auth(?:orization)?|proxy[_-]?authorization|password|signature|sig|x-amz-(?:credential|signature|security-token))$/iu
const URL_FIELDS = /(?:^|[/?&#;])([^=/?&#;\s]+)=([^&#;]+)/gu

function decoded(value: string) {
  // Decode valid percent-encoded runs even when a separate part of the URL is malformed.
  return value.replace(/(?:%[\da-f]{2})+/giu, part => {
    try { return decodeURIComponent(part) } catch { return part.replace(/%([\da-f]{2})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) }
  })
}

function urlHasCredential(link: string) {
  const visible = decoded(link)
  if (KNOWN_CREDENTIAL.test(visible) || [...visible.matchAll(URL_FIELDS)].some(([, key, value]) => URL_KEY.test(key) && Boolean(value.trim()))) return true
  try {
    const url = new URL(link)
    if (url.username || url.password) return true
    if ([...url.searchParams].some(([key, value]) => Boolean(value) && (URL_KEY.test(decoded(key)) || KNOWN_CREDENTIAL.test(decoded(value))))) return true
    const path = url.pathname.split('/').filter(Boolean).map(decoded)
    return path.some((part, index) => /^(?:reset|password-reset|verify-email|magic-link|activate|invite)$/iu.test(part)
      && /^(?=.{24,}$)(?=.*\d)[A-Za-z\d_-]+$/u.test(path[index + 1] ?? ''))
  } catch {
    return /^https?:\/\/[^/\s@]+@/iu.test(visible)
  }
}

export function looksSecret(text: string): boolean {
  const links = text.match(LINKS) ?? []
  // Ordinary document links may contain opaque IDs; check URLs before applying that exception.
  return links.some(urlHasCredential) || SECRET_PATTERNS.some(pattern => pattern.test(text.replace(LINKS, ' ')))
}
