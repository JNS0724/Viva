import { imageUrl } from '../../shared/images.js'
import { h } from './dom.js'

/** Shown where a picture was when the pictures folder no longer has it (emptied in settings). */
export const GONE_TEXT = '图已清理'

/** A picture from the pictures folder; when it is gone, a quiet box saying so. */
export function picture(id, { cls = 'pic' } = {}) {
  const img = h('img', { class: cls, src: imageUrl(id), alt: '图片', loading: 'lazy', decoding: 'async' })
  img.addEventListener('error', () => img.replaceWith(h('span', { class: `${cls} pic-gone`, text: GONE_TEXT })), { once: true })
  return img
}

/** The pictures of a sent question, above its words. */
export const sentPictures = (images) => (images?.length ? h('div', { class: 'msg-pics' }, images.map(({ id }) => picture(id, { cls: 'msg-pic' }))) : null)

/**
 * The pictures waiting in an input to be sent: small, each with its ×.
 * @param {{ id: string }[]} images @param {(id: string) => void} remove
 */
export const draftPictures = (images, remove) => h('div', { class: 'draft-pics' }, images.map(({ id }) => h('div', { class: 'draft-pic' },
  picture(id, { cls: 'draft-pic-img' }),
  h('button', { class: 'draft-pic-x', type: 'button', 'aria-label': '去掉这张图', text: '×', onClick: () => remove(id) }))))
