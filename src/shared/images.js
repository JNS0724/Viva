/**
 * Pictures pasted or dropped into a question (main input and desktop island): kept by Viva in its picture
 * folder under a name made of their contents (main/image-store.js), sent to the model with the words, and shown
 * above the words in the thread by that name (viva-image://, main/image-protocol.js).
 */
export const IMAGE_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })
export const IMAGE_LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, perMessage: 10 })
const ID = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/
const MIME_OF_EXT = Object.freeze(Object.fromEntries(Object.entries(IMAGE_TYPES).map(([mime, ext]) => [ext, mime])))

/** A picture's name in the folder: its SHA-256 and the extension of its kind. */
export const isImageId = (id) => typeof id === 'string' && ID.test(id)
export const mimeOfId = (id) => MIME_OF_EXT[String(id).split('.').pop()] ?? null
export const imageUrl = (id) => `viva-image://img/${id}`

const startsWith = (bytes, signature, offset = 0) => signature.every((byte, i) => bytes[offset + i] === byte)
const ascii = (text) => [...text].map((c) => c.charCodeAt(0))

/** What the bytes are, from their first bytes, whatever the clipboard called them; null for anything else. */
export function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

/** @returns {{ id: string }[] | null} the pictures of a message as stored or sent, or null when they are not that */
export function checkImages(images) {
  if (images === undefined || images === null) return []
  if (!Array.isArray(images) || images.length > IMAGE_LIMITS.perMessage) return null
  return images.every((image) => isImageId(image?.id)) ? images.map((image) => ({ id: image.id })) : null
}
