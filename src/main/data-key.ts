import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_KEY_BYTES, isEnvelope } from '../backend/envelope.ts'
import type { Secrets } from '../backend/host.ts'

/**
 * The shell's half of the backend's encryption (src/backend/envelope.ts): a random data key kept in the app's data,
 * encrypted with the system keychain (safeStorage), and what an earlier version encrypted with the keychain
 * directly, decrypted for the backend at launch. Both go to the backend over the IPC channel, never in its
 * environment (dsh, its child, inherits that).
 */
export const DATA_KEY_FILE = 'data-key.bin'
/** The stores that held keychain-encrypted values (settings-store.ts, model-providers.ts, mcp-config.ts). */
export const LEGACY_SECRET_FILES = ['settings.json', 'models.json', 'mcp-servers.json'] as const
/** A keychain blob is longer than this in base64; shorter strings are never tried. */
const MIN_BLOB_CHARS = 16
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

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

/** Every string in a JSON value, however deep. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

/** The stores' keychain-encrypted values (base64) and what they decrypt to; what the keychain cannot open is left out. */
export function legacySecrets({ dir, keychain }: { dir: string, keychain: Keychain }): Record<string, string> {
  if (!keychain.isEncryptionAvailable()) return {}
  const found: Array<[string, string]> = []
  for (const name of LEGACY_SECRET_FILES) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const text of stringsIn(parsed)) {
      if (text.length < MIN_BLOB_CHARS || !BASE64.test(text)) continue
      const data = Buffer.from(text, 'base64')
      if (isEnvelope(data)) continue
      try {
        found.push([text, keychain.decryptString(data)])
      } catch {
        // Not something the keychain encrypted: a name, a URL, a new-form value.
      }
    }
  }
  return Object.fromEntries(found)
}
