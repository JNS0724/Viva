import type { Protocol } from 'electron'

/**
 * viva-image://img/<id>: a picture from the pictures folder, for the thread and the inputs to show by name (the
 * pages' Content-Security-Policy lets them load it). The shell registers the scheme; the backend, which has the
 * pictures folder, answers it (src/backend/image-protocol.ts imageResponse).
 */
const IMAGE_SCHEME = 'viva-image'
export const IMAGE_SCHEME_PRIVILEGES = Object.freeze({ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } })

/** viva-image:// answered by `answer`: from the backend. */
export function registerImageProtocol(protocol: Pick<Protocol, 'handle'>, answer: (url: string) => Response | Promise<Response>): void {
  protocol.handle(IMAGE_SCHEME, (request) => answer(request.url))
}
