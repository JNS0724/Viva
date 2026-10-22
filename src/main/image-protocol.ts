import fs from 'node:fs'
import type { Protocol } from 'electron'
import { isImageId, mimeOfId } from '../shared/images.ts'

/**
 * viva-image://img/<id>: a picture from the pictures folder, for the thread and the inputs to show by name
 * (the pages' Content-Security-Policy lets them load it). Anything that is not a kept picture is 404, so a
 * picture removed by emptying the folder shows as gone.
 */
export const IMAGE_SCHEME = 'viva-image'
export const IMAGE_SCHEME_PRIVILEGES = Object.freeze({ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } })

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
  if (!file) return new Response(null, { status: 404 })
  return new Response(fs.readFileSync(file), { headers: { 'content-type': mimeOfId(id), 'cache-control': 'max-age=31536000, immutable' } })
}

export function registerImageProtocol(protocol: Pick<Protocol, 'handle'>, store: PictureFiles): void {
  protocol.handle(IMAGE_SCHEME, (request) => imageResponse(request.url, store))
}
