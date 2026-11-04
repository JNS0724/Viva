import fs from 'node:fs'
import { isImageId, mimeOfId } from '../shared/images.ts'

/**
 * The backend's answer to viva-image://img/<id> (the shell registers the scheme: src/shell/image-protocol.ts).
 * Anything that is not a kept picture is 404, so a picture removed by emptying the folder shows as gone.
 */

/** What of the picture store this needs. */
interface PictureFiles { pathOf: (id: string) => string | null }

export function imageResponse(url: string, store: PictureFiles): Response {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return new Response(null, { status: 400 })
  }
  const id = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  const file = parsed.host === 'img' && isImageId(id) ? store.pathOf(id) : null
  const mime = mimeOfId(id)
  if (!file || !mime) return new Response(null, { status: 404 })
  return new Response(fs.readFileSync(file), { headers: { 'content-type': mime, 'cache-control': 'max-age=31536000, immutable' } })
}
