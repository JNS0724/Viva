import { IMAGE_LIMITS } from '../shared/images.ts'
import { draftPictures, pictureKept } from './view/pictures.js'

const TOO_MANY = `一次最多 ${IMAGE_LIMITS.perMessage} 张图`
/** IPC errors arrive as "Error invoking remote method 'x': Error: msg"; keep only the message. */
const messageOf = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * The pictures pasted or dropped into an input, waiting to be sent with its words: each kept in the pictures
 * folder as soon as it comes in (main/image-store.js), shown small above the words, and handed over on send.
 * Like the words in the field, they live with the page, not in the conversation's state.
 * @param {{
 *   keep: (bytes: Uint8Array) => Promise<{ id: string, mimeType: string, size: number }>,
 *   container: HTMLElement,
 *   onChange?: () => void,
 *   showError: (message: string) => void,
 * }} options
 */
export function createDraftImages({ keep, container, onChange = () => {}, showError }) {
  let images = []

  function render() {
    container.hidden = images.length === 0
    container.replaceChildren(...(images.length ? [draftPictures(images, remove)] : []))
    onChange()
  }

  function remove(id) {
    images = images.filter((image) => image.id !== id)
    render()
  }

  /** @param {Blob[]} files pictures pasted or dropped; each kept, in order, the same picture once */
  async function add(files) {
    for (const file of files) {
      if (images.length >= IMAGE_LIMITS.perMessage) {
        showError(TOO_MANY)
        break
      }
      try {
        const kept = await keep(new Uint8Array(await file.arrayBuffer()))
        pictureKept(kept.id)
        if (!images.some((image) => image.id === kept.id)) images = [...images, { id: kept.id }]
      } catch (err) {
        showError(messageOf(err))
      }
    }
    render()
  }

  return {
    add,
    remove,
    /** @returns {{ id: string }[]} */
    list: () => images,
    clear() {
      if (!images.length) return
      images = []
      render()
    },
  }
}
