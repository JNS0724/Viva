import fs from 'node:fs'
import path from 'node:path'

/**
 * Small switches the user flips in settings, kept in preferences.json next to the other app data.
 * Nothing secret goes here: keys live in settings-store.js and model-providers.js, encrypted.
 */
const FILE_VERSION = 1
/**
 * deskPlaces: where the desktop island was dragged to, per display (desk-place.js checks what is read);
 * deskCoached: the user has seen the island's first-time note on what it can do;
 * workDirs: the working directories used lately, and the ones the user confirmed (work-dir-ipc.js checks what is read);
 * imagesDir: where the user moved the pictures folder to (image-store.js); empty for the default in the app's data;
 * permission: what the assistant may do without asking (plugins/permission; checked where it is set).
 */
const DEFAULTS = Object.freeze({
  deskIsland: true,
  deskPlaces: Object.freeze({ last: null, places: Object.freeze({}) }),
  deskCoached: false,
  workDirs: Object.freeze({ recent: Object.freeze([]), trusted: Object.freeze([]) }),
  imagesDir: '',
  permission: 'workspace-write',
})

/** @param {{ file: string, onError?: (err: Error) => void }} options */
export function createPreferences({ file, onError = () => {} }) {
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, typeof saved[key] === typeof value ? saved[key] : value]))
    } catch (err) {
      if (err.code !== 'ENOENT') onError(err)
      return { ...DEFAULTS }
    }
  }

  /** @returns {{ deskIsland: boolean, deskPlaces: object, deskCoached: boolean }} */
  const get = () => read()

  /** @returns {{ deskIsland: boolean, deskPlaces: object, deskCoached: boolean }} the preferences after the change */
  function set(key, value) {
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
