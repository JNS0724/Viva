import fs from 'node:fs'
import path from 'node:path'
import { t } from '../shared/i18n/translate.ts'
import { REGISTRY_TOKEN_ENV } from './dsh-launch.ts'
import type { Encryption } from './settings-store.ts'

export { REGISTRY_TOKEN_ENV }

/**
 * The company's own plugin source: an npm registry dsh's plugin manager installs from (dsh-profile.ts), and the token
 * it asks for, kept encrypted like the model keys. The token is never written out: the profile's .npmrc names it by a
 * variable only, and dsh hands pnpm that variable's value (dsh-launch.ts), so neither the files nor the agent's own
 * commands have it.
 */
const FILE_VERSION = 1
const MARK = '# viva: plugin source'
const MAX_TOKEN_CHARS = 4096
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A registry's address as kept: https, or http on this computer; no user or password in it; one slash at the end. */
export function normalizeRegistry(input: unknown): string {
  let url: URL
  try {
    url = new URL(String(input ?? '').trim())
  } catch {
    throw new Error(t('main.plugin-source.address'))
  }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !local) throw new Error(t('main.plugin-source.address'))
  if (url.username || url.password) throw new Error(t('main.plugin-source.credentials'))
  return `${url.origin}${url.pathname.replace(/\/*$/, '/')}`
}

/** The registry as npm names it for its token: `//host[:port]/path/`. */
export const authKey = (registry: string): string => registry.replace(/^https?:/, '')

/** The profile's .npmrc with the app's line for `registry` (or none), the user's own lines left as they are. */
export function npmrcWith(current: string, registry: string | null): string {
  const lines = current.split(/\r?\n/)
  const own = lines.filter((line, index) => line !== MARK && lines[index - 1] !== MARK)
  const kept = own.join('\n').replace(/\n+$/, '')
  const added = registry ? [MARK, `${authKey(registry)}:_authToken=\${${REGISTRY_TOKEN_ENV}}`].join('\n') : ''
  const text = [kept, added].filter(Boolean).join('\n')
  return text ? `${text}\n` : ''
}

function validToken(input: string): string {
  const token = input.trim()
  if (/\s/.test(token) || token.length > MAX_TOKEN_CHARS) throw new Error(t('main.plugin-source.token'))
  return token
}

export interface PluginSourceView { registry: string | null, hasToken: boolean }

export function createPluginSourceStore({ file, crypto, onError = () => {} }: { file: string, crypto: Encryption, onError?: (err: Error) => void }) {
  function read(): { registry: string | null, token: string } {
    let data: { registry?: unknown, token?: unknown }
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') onError(err as Error)
      return { registry: null, token: '' }
    }
    const registry = typeof data.registry === 'string' ? data.registry : null
    if (typeof data.token !== 'string' || !data.token) return { registry, token: '' }
    try {
      return { registry, token: crypto.decryptString(Buffer.from(data.token, 'base64')) }
    } catch (err) {
      onError(err as Error)
      return { registry, token: '' }
    }
  }

  function write(registry: string, token: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    const sealed = token ? crypto.encryptString(token).toString('base64') : ''
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, registry, token: sealed }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  return {
    view: (): PluginSourceView => {
      const { registry, token } = read()
      return { registry, hasToken: Boolean(registry && token) }
    },
    /** The registry, or null for none. */
    registry: (): string | null => read().registry,
    /** The token's value, for dsh only; '' when there is none. */
    token: (): string => (read().registry ? read().token : ''),
    /**
     * A registry (null for none) and its token: undefined keeps the one kept, '' clears it. Refuses to keep a token
     * without the system keychain rather than write it as it is.
     */
    save({ registry, token }: { registry: unknown, token?: unknown }): PluginSourceView {
      if (registry === null || registry === '') {
        fs.rmSync(file, { force: true })
        return { registry: null, hasToken: false }
      }
      const address = normalizeRegistry(registry)
      const next = token === undefined ? read().token : validToken(String(token))
      if (next && !crypto.isEncryptionAvailable()) throw new Error(t('main.model-providers.system.keychain.unavailable.the.key.cannot.be'))
      write(address, next)
      return { registry: address, hasToken: Boolean(next) }
    },
  }
}
