import { IMAGE_TYPES } from '../shared/images.ts'

/**
 * What a paste carries, for the main input and the desktop island's: the pictures, and the words. Copied from
 * WeChat, a web page or a document, a picture with words often comes with the words only as formatted text
 * (HTML), with no plain-text copy; a text field then takes nothing, so the words are read out of the HTML.
 */
const BLOCK_END = /<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)>/gi
const LINE_BREAK = /<br\s*\/?>/gi
const DROPPED = /<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi
const ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })

function decodeEntity(whole: string, name: string) {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
  const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
  return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
}

/** The words of an HTML fragment, a line for each block, without the markup. */
export function htmlToText(html: unknown) {
  return String(html ?? '')
    .replace(DROPPED, '')
    .replace(LINE_BREAK, '\n')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * @param data the paste's clipboardData
 * @returns the pictures pasted, and the words to put in the field ourselves (null: nothing but words, which
 *   the field takes by itself)
 */
export function pastedParts<F extends { type: string }>(data: { files?: ArrayLike<F>, getData: (type: string) => string } | null | undefined): { images: F[], text: string | null } {
  const images = Array.from(data?.files ?? []).filter((file) => Object.hasOwn(IMAGE_TYPES, file.type))
  const plain = data?.getData?.('text/plain') ?? ''
  if (plain) return { images, text: images.length ? plain : null }
  const html = data?.getData?.('text/html') ?? ''
  if (html) return { images, text: htmlToText(html) }
  return { images, text: images.length ? '' : null }
}

/** Puts `text` where the caret is in a text field, as typing it would, so undo and the field's own events follow. */
export function insertText(field: HTMLInputElement | HTMLTextAreaElement, text: string | null) {
  if (!text) return
  field.focus()
  if (field.ownerDocument.execCommand?.('insertText', false, text)) return
  field.setRangeText(text, field.selectionStart ?? 0, field.selectionEnd ?? 0, 'end')
  field.dispatchEvent(new Event('input', { bubbles: true }))
}
