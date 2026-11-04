import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Secrets } from './host.ts'

/**
 * The encryption of the user's keys in the backend process (docs/system-design.md §5). Electron's
 * safeStorage is only in the shell, so the shell keeps a random data key encrypted with it (src/shell/data-key.ts)
 * and hands the key to the backend at launch over the IPC channel; the backend encrypts with AES-256-GCM under
 * that key.
 */
export const DATA_KEY_BYTES = 32
const MAGIC = Buffer.from('viva-env1:')
const IV_BYTES = 12
const TAG_BYTES = 16

/** Whether stored bytes are in this envelope's form. */
export const isEnvelope = (data: Buffer): boolean => data.subarray(0, MAGIC.length).equals(MAGIC)

interface EnvelopeOptions {
  /** The data key; null when the system keychain is not available, as safeStorage would say. */
  key: Buffer | null
}

export function createEnvelope({ key }: EnvelopeOptions): Secrets {
  if (key && key.length !== DATA_KEY_BYTES) throw new Error(`the data key must be ${DATA_KEY_BYTES} bytes`)

  function requireKey(): Buffer {
    if (!key) throw new Error('encryption is not available')
    return key
  }

  return {
    isEncryptionAvailable: () => key !== null,
    encryptString(text: string): Buffer {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', requireKey(), iv)
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
    },
    decryptString(data: Buffer): string {
      if (!isEnvelope(data)) throw new Error('cannot decrypt: not encrypted by this app')
      const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
      const tag = data.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', requireKey(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
    },
  }
}
