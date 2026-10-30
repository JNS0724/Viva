import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
import { IMAGE_LIMITS } from '../shared/images.ts'
import { draftPictures, pictureKept } from './view/pictures.ts'

let TOO_MANY = t("desk.up.to.images.per.message", { perMessage: IMAGE_LIMITS.perMessage })
/** IPC errors arrive as "Error invoking remote method 'x': Error: msg"; keep only the message. */
const messageOf = (err: unknown) => String((err as { message?: unknown } | null)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * The pictures pasted or dropped into an input, waiting to be sent with its words: each kept in the pictures
 * folder as soon as it comes in (main/image-store.js), shown small above the words, and handed over on send.
 * Like the words in the field, they live with the page, not in the conversation's state.
 */
export function createDraftImages({ keep, container, onChange = () => {}, showError }: {
  keep: (bytes: Uint8Array<ArrayBuffer>) => Promise<{ id: string, mimeType: string, size: number }>,
  container: HTMLElement,
  onChange?: () => void,
  showError: (message: string) => void,
}) {
  let images: Array<{ id: string }> = []

  function render() {
    container.hidden = images.length === 0
    container.replaceChildren(...(images.length ? [draftPictures(images, remove)] : []))
    onChange()
  }

  function remove(id: string) {
    images = images.filter((image) => image.id !== id)
    render()
  }

  /** @param files pictures pasted or dropped; each kept, in order, the same picture once */
  async function add(files: readonly Blob[]) {
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
    list: (): Array<{ id: string }> => images,
    clear() {
      if (!images.length) return
      images = []
      render()
    },
  }
}

onLocaleChange(() => {
  TOO_MANY = t("desk.up.to.images.per.message", { perMessage: IMAGE_LIMITS.perMessage })
})
