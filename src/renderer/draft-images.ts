import { draftPictures, pictureKept } from './view/pictures.ts'
import { IMAGE_LIMITS } from '../shared/images.ts'

/** IPC errors arrive as "Error invoking remote method 'x': Error: msg"; keep only the message. */
const messageOf = (err: unknown) => String((err as { message?: unknown } | null)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * The pictures pasted or dropped into an input, waiting to be sent with its words: each kept in the pictures
 * folder as soon as it comes in (main/image-store.js), shown small above the words, and handed over on send.
 * Their draft references belong to the main process, which completes a keep after a composer is destroyed.
 */
export function createDraftImages({ keep, container, onChange = () => {}, showError, capture }: {
  keep: (key: string, images: Uint8Array<ArrayBuffer>[]) => Promise<void>,
  container: HTMLElement,
  onChange?: () => void,
  showError: (message: string) => void,
  capture: () => string | null,
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

  /** @param files pictures pasted or dropped; every keep is registered against the originating draft. */
  async function add(files: readonly Blob[]) {
    const origin = capture()
    if (!origin) return
    const read = await Promise.allSettled(files.slice(0, IMAGE_LIMITS.perMessage + 1).map(file => file.arrayBuffer()))
    const bytes: Uint8Array<ArrayBuffer>[] = []
    for (const result of read) {
      if (result.status === 'fulfilled') bytes.push(new Uint8Array(result.value))
      else if (capture() === origin) showError(messageOf(result.reason))
    }
    try {
      if (bytes.length) await keep(origin, bytes)
    } catch (err) {
      if (capture() === origin) showError(messageOf(err))
    }
  }

  return {
    add,
    remove,
    list: (): Array<{ id: string }> => images,
    replace(next: ReadonlyArray<{ id: string }>) {
      images = next.map(image => ({ id: image.id }))
      images.forEach(image => pictureKept(image.id))
      render()
    },
    clear() {
      if (!images.length) return
      images = []
      render()
    },
  }
}
