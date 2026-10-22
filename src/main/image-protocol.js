import fs from 'node:fs'
import { isImageId, mimeOfId } from '../shared/images.ts'

/**
 * viva-image://img/<id>: a picture from the pictures folder, for the thread and the inputs to show by name
 * (the pages' Content-Security-Policy lets them load it). Anything that is not a kept picture is 404, so a
 * picture removed by emptying the folder shows as gone.
 */
export const IMAGE_SCHEME = 'viva-image'
export const IMAGE_SCHEME_PRIVILEGES = Object.freeze({ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } })

/** @param {string} url @param {{ pathOf: (id: string) => string | null }} store */
export function imageResponse(url, store) {
  let parsed
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

/** @param {Electron.Protocol} protocol */
export function registerImageProtocol(protocol, store) {
  protocol.handle(IMAGE_SCHEME, (request) => imageResponse(request.url, store))
}
