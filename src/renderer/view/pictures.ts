import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { imageUrl } from '../../shared/images.ts'
import { h } from './dom.ts'

/** Shown where a picture was when the pictures folder no longer has it (emptied in settings). */
export let GONE_TEXT = t("pictures.image.removed")

/**
 * Once the folder has been emptied from this page, every picture kept before is gone, though the page may still
 * have it cached: drawn again, it shows as gone. Pictures kept after that show as usual.
 */
let emptied = false
const keptSinceEmptied = new Set<string>()

/** A picture just kept in the folder (pasted, dropped, or sent from the desktop island). */
export function pictureKept(id: string) {
  if (emptied) keptSinceEmptied.add(id)
}

const goneBox = (cls: string) => h('span', { class: `${cls} pic-gone`, text: GONE_TEXT })

/** A picture from the pictures folder; when it is gone, a quiet box saying so. */
export function picture(id: string, { cls = 'pic' } = {}) {
  if (emptied && !keptSinceEmptied.has(id)) return goneBox(cls)
  const img = h('img', { class: cls, src: imageUrl(id), alt: t("pictures.image"), loading: 'lazy', decoding: 'async' })
  img.addEventListener('error', () => img.replaceWith(h('span', { class: `${cls} pic-gone`, text: GONE_TEXT })), { once: true })
  return img
}

/**
 * The folder was just emptied: every picture on the page shows as gone at once, without asking for it again
 * (shown pictures do not load anew until their conversation is drawn again).
 */
export function markAllGone(root: ParentNode) {
  emptied = true
  keptSinceEmptied.clear()
  for (const img of root.querySelectorAll('img[src^="viva-image:"]')) img.replaceWith(goneBox(img.className))
}

/** The pictures of a sent question, above its words. */
export const sentPictures = (images: ReadonlyArray<{ id: string }> | null | undefined) => (images?.length ? h('div', { class: 'msg-pics' }, images.map(({ id }) => picture(id, { cls: 'msg-pic' }))) : null)

/** The pictures waiting in an input to be sent: small, each with its ×. */
export const draftPictures = (images: ReadonlyArray<{ id: string }>, remove: (id: string) => void) => h('div', { class: 'draft-pics' }, images.map(({ id }) => h('div', { class: 'draft-pic' },
  picture(id, { cls: 'draft-pic-img' }),
  h('button', { class: 'draft-pic-x', type: 'button', 'aria-label': t("pictures.remove.this.image"), text: '×', onClick: () => remove(id) }))))

onLocaleChange(() => {
  GONE_TEXT = t("pictures.image.removed")
})
