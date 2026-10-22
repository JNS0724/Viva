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
  if (typeof input !== 'string') throw new Error('API key 必须是文本')
  const key = input.trim()
  if (!key) throw new Error('请先填写 API key')
  if (/\s/.test(key)) throw new Error('API key 里不能有空格或换行')
  if (key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH) {
    throw new Error(`API key 长度应在 ${KEY_MIN_LENGTH}–${KEY_MAX_LENGTH} 个字符之间`)
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
    if (!crypto.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法安全保存 key')
    writeFile({ version: FILE_VERSION, deepseekApiKey: crypto.encryptString(key).toString('base64') })
    return key
  }

  function clearApiKey(): void {
    fs.rmSync(file, { force: true })
  }

  return { getApiKey, saveApiKey, clearApiKey }
}
