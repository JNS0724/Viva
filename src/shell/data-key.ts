import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_KEY_BYTES } from '../backend/envelope.ts'
import type { Secrets } from '../backend/host.ts'

/**
 * The shell's half of the backend's encryption (src/backend/envelope.ts): a random data key kept in the app's data,
 * encrypted with the system keychain (safeStorage). It goes to the backend over the IPC channel, never in its
 * environment (dsh, its child, inherits that).
 */
export const DATA_KEY_FILE = 'data-key.bin'

type Keychain = Pick<Secrets, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>

/**
 * The data key, made on the first launch. Null when the keychain is not available (the stores then refuse to
 * save keys, as they did with safeStorage). A key the keychain can no longer open is set aside, and a new one made:
 * what it encrypted is lost, as it would have been with safeStorage.
 */
export function loadDataKey({ dir, keychain, onProblem = () => {} }: { dir: string, keychain: Keychain, onProblem?: (message: string) => void }): Buffer | null {
  if (!keychain.isEncryptionAvailable()) return null
  const file = path.join(dir, DATA_KEY_FILE)
  if (fs.existsSync(file)) {
    try {
      const key = Buffer.from(keychain.decryptString(fs.readFileSync(file)), 'base64')
      if (key.length === DATA_KEY_BYTES) return key
      onProblem(`${DATA_KEY_FILE} holds no key`)
    } catch (err) {
      onProblem(`${DATA_KEY_FILE} cannot be opened: ${(err as Error).message}`)
    }
    fs.renameSync(file, `${file}.unreadable`)
  }
  const key = randomBytes(DATA_KEY_BYTES)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, keychain.encryptString(key.toString('base64')), { mode: 0o600 })
  return key
}
