import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'

const FILE_VERSION = 1
const KEY_MIN_LENGTH = 8
const KEY_MAX_LENGTH = 512
const HINT_VISIBLE_CHARS = 4

/** The OS keychain, as Electron's safeStorage offers it; handed in so the stores can be tested without it. */
export interface Encryption {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

/** @returns the trimmed key */
export function validateApiKey(input: unknown): string {
  if (typeof input !== 'string') throw new Error(t("main.settings-store.api.key.must.be.text"))
  const key = input.trim()
  if (!key) throw new Error(t("main.settings-store.enter.an.api.key.first"))
  if (/\s/.test(key)) throw new Error(t("main.settings-store.api.key.cannot.contain.spaces.or.line"))
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH) {
    throw new Error(t("main.settings-store.api.key.must.contain.characters", { KEY_MIN_LENGTH: KEY_MIN_LENGTH, KEY_MAX_LENGTH: KEY_MAX_LENGTH }))
  }
  return key
}

/** Masked form shown in the UI; the full key never leaves the main process. */
export const keyHint = (key: string | null | undefined): string => (key ? `••••${key.slice(-HINT_VISIBLE_CHARS)}` : '')

/**
 * Persists the DeepSeek API key encrypted with the OS keychain (Electron `safeStorage`).
 * Refuses to fall back to plaintext when encryption is unavailable.
 */
export function createSettingsStore({ file, crypto, onError = () => {} }: { file: string, crypto: Encryption, onError?: (err: Error) => void }) {
  function readFile(): { deepseekApiKey?: string } | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err: any) {
      if (err.code !== 'ENOENT') onError(err)
      return null
    }
  }

  function writeFile(data: object): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function getApiKey(): string {
    const encoded = readFile()?.deepseekApiKey
    if (!encoded) return ''
    try {
      return crypto.decryptString(Buffer.from(encoded, 'base64'))
    } catch (err: any) {
      onError(err)
      return ''
    }
  }

  function saveApiKey(input: unknown): string {
    const key = validateApiKey(input)
    if (!crypto.isEncryptionAvailable()) throw new Error(t("main.model-providers.system.keychain.unavailable.the.key.cannot.be"))
    writeFile({ version: FILE_VERSION, deepseekApiKey: crypto.encryptString(key).toString('base64') })
    return key
  }

  function clearApiKey(): void {
    fs.rmSync(file, { force: true })
  }

  return { getApiKey, saveApiKey, clearApiKey }
}
