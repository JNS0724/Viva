import fs from 'node:fs'
import path from 'node:path'

/**
 * Small switches the user flips in settings, kept in preferences.json next to the other app data.
 * Nothing secret goes here: keys live in settings-store.js and model-providers.js, encrypted.
 */
const FILE_VERSION = 1

/**
 * deskPlaces: where the desktop island was dragged to, per display (desk-place.ts checks what is read);
 * deskCoached: the user has seen the island's first-time note on what it can do;
 * workDirs: the working directories used lately, and the ones the user confirmed (work-dir-ipc.js checks what is read);
 * imagesDir: where the user moved the pictures folder to (image-store.js); empty for the default in the app's data;
 * permission: what the assistant may do without asking (plugins/permission; checked where it is set).
 */
export interface Preferences {
  deskIsland: boolean
  deskPlaces: any
  deskCoached: boolean
  workDirs: any
  imagesDir: string
  permission: string
}

const DEFAULTS: Readonly<Preferences> = Object.freeze({
  deskIsland: true,
  deskPlaces: Object.freeze({ last: null, places: Object.freeze({}) }),
  deskCoached: false,
  workDirs: Object.freeze({ recent: Object.freeze([]), trusted: Object.freeze([]) }),
  imagesDir: '',
  permission: 'workspace-write',
})

export function createPreferences({ file, onError = () => {} }: { file: string, onError?: (err: Error) => void }) {
  function read(): Preferences {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, typeof saved[key] === typeof value ? saved[key] : value])) as Preferences
    } catch (err: any) {
      if (err.code !== 'ENOENT') onError(err)
      return { ...DEFAULTS }
    }
  }

  const get = (): Preferences => read()

  /** @returns the preferences after the change */
  function set(key: string, value: unknown): Preferences {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`unknown preference: ${key}`)
    if (typeof value !== typeof DEFAULTS[key]) throw new Error(`${key} must be a ${typeof DEFAULTS[key]}`)
    const next = { ...read(), [key]: value }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: FILE_VERSION, ...next }))
    fs.renameSync(tmp, file)
    return next
  }

  return { get, set }
}
