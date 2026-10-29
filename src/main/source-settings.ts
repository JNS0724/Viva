import { t } from '../shared/i18n/translate.ts'
import fs from 'node:fs'
import path from 'node:path'
import { checkConfigValues, MAX_EVERY, MIN_EVERY, missingFields, type ConfigValues, type SourceManifest } from './source-contract.ts'
import type { Encryption } from './settings-store.ts'

/**
 * What the user set for each message source: whether it is on (off until switched on), how often it is asked,
 * and the values of the fields its viva-source.json declares. Secret fields are encrypted with the OS keychain
 * like the API key and never leave the main process: settings only learns which of them are saved. A change
 * takes effect at the source's next run, with no restart of anything.
 */
const FILE_VERSION = 1

/** One source's settings as kept: secrets as base64 of the encrypted JSON, or null. */
interface StoredSettings { enabled?: boolean, everyMinutes?: number, values?: Record<string, unknown>, secrets?: string | null }

/** One source's settings as the main process uses them: every value, secrets decrypted. */
export interface SourceSettings { enabled: boolean, everyMinutes: number, values: ConfigValues }

/** What settings may show: the plain values, and the names of the secrets that have a value. */
export interface SettingsView { enabled: boolean, everyMinutes: number, values: ConfigValues, savedSecrets: string[], missing: string[] }

/** A change from the settings form; a secret left blank keeps the saved one. */
export interface SettingsChange { enabled?: boolean, everyMinutes?: number, values?: Readonly<Record<string, unknown>> }

const isSecret = (manifest: SourceManifest, key: string) => manifest.config[key]?.type === 'secret'

function splitValues(manifest: SourceManifest, values: ConfigValues) {
  const plain = Object.fromEntries(Object.entries(values).filter(([key]) => !isSecret(manifest, key)))
  const secrets = Object.fromEntries(Object.entries(values).filter(([key]) => isSecret(manifest, key)))
  return { plain, secrets }
}

export function createSourceSettings({ file, crypto, onError = () => {} }: { file: string, crypto: Encryption, onError?: (err: Error) => void }) {
  function readAll(): Record<string, StoredSettings> {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return data && typeof data.sources === 'object' && data.sources ? data.sources : {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') onError(err as Error)
      return {}
    }
  }

  function writeAll(sources: Record<string, StoredSettings>): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, sources }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function decrypt(id: string, stored: StoredSettings): Record<string, unknown> {
    if (!stored.secrets) return {}
    try {
      return JSON.parse(crypto.decryptString(Buffer.from(stored.secrets, 'base64')))
    } catch (err) {
      onError(new Error(`could not decrypt the secrets of source "${id}": ${(err as Error).message}`))
      return {}
    }
  }

  /** The saved values that still fit the manifest; a field the source no longer declares is let go. */
  function savedValues(manifest: SourceManifest, stored: StoredSettings): ConfigValues {
    const raw = { ...(stored.values ?? {}), ...decrypt(manifest.id, stored) }
    const known = Object.fromEntries(Object.entries(raw).filter(([key]) => Object.hasOwn(manifest.config, key)))
    const checked = checkConfigValues(manifest.config, known)
    if (checked.problem === undefined) return checked.values
    onError(new Error(`saved settings of source "${manifest.id}" no longer fit: ${checked.problem}`))
    const defaults = checkConfigValues(manifest.config, {})
    return defaults.problem === undefined ? defaults.values : {}
  }

  function get(manifest: SourceManifest): SourceSettings {
    const stored = readAll()[manifest.id] ?? {}
    const values = savedValues(manifest, stored)
    const enabled = stored.enabled === true && missingFields(manifest.config, values).length === 0
    return { enabled, everyMinutes: stored.everyMinutes ?? manifest.everyMinutes, values }
  }

  function view(manifest: SourceManifest): SettingsView {
    const settings = get(manifest)
    const { plain, secrets } = splitValues(manifest, settings.values)
    return {
      enabled: settings.enabled,
      everyMinutes: settings.everyMinutes,
      values: plain,
      savedSecrets: Object.keys(secrets),
      missing: missingFields(manifest.config, settings.values),
    }
  }

  /** Applies a change and returns the settings as now kept; throws, in the user's words, when it does not fit. */
  function save(manifest: SourceManifest, change: SettingsChange): SourceSettings {
    const current = get(manifest)
    const typed = Object.entries(change.values ?? {}).filter(([key, value]) => !(isSecret(manifest, key) && (value === '' || value === undefined)))
    const checked = checkConfigValues(manifest.config, { ...current.values, ...Object.fromEntries(typed) })
    if (checked.problem !== undefined) throw new Error(checked.problem)
    const everyMinutes = change.everyMinutes ?? current.everyMinutes
    if (!Number.isInteger(everyMinutes) || everyMinutes < MIN_EVERY || everyMinutes > MAX_EVERY) throw new Error(t("main.source-settings.polling.interval.must.be.minutes", { MIN_EVERY: MIN_EVERY, MAX_EVERY: MAX_EVERY }))
    const enabled = change.enabled ?? current.enabled
    const missing = missingFields(manifest.config, checked.values)
    if (enabled && missing.length) throw new Error(t("main.source-settings.fill.in.first", { value1: missing.join('、') }))
    const { plain, secrets } = splitValues(manifest, checked.values)
    const hasSecrets = Object.keys(secrets).length > 0
    if (hasSecrets && !crypto.isEncryptionAvailable()) throw new Error(t("main.source-settings.system.keychain.unavailable.credentials.cannot.be.stored"))
    const stored: StoredSettings = {
      enabled,
      everyMinutes,
      values: plain,
      secrets: hasSecrets ? crypto.encryptString(JSON.stringify(secrets)).toString('base64') : null,
    }
    writeAll({ ...readAll(), [manifest.id]: stored })
    return { enabled, everyMinutes, values: checked.values }
  }

  function remove(id: string): void {
    const { [id]: _removed, ...rest } = readAll()
    writeAll(rest)
  }

  return { get, view, save, remove }
}

export type SourceSettingsStore = ReturnType<typeof createSourceSettings>
