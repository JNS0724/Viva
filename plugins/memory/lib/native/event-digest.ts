import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export function nativeEventDigest(event: SessionEvent) {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex')
}
